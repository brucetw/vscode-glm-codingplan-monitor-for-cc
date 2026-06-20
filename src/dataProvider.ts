import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as https from 'https'
import * as http from 'http'
import * as vscode from 'vscode'
import type { SessionInfo, SpeedState, QuotaResponse, UsageBucket, BucketedUsage, MonitorData } from './types'

const CLAUDE_DIR = path.join(os.homedir(), '.claude')
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions')
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects')

// 模型对应的上下文窗口大小（tokens）
// 注意：匹配时按 key 长度降序，避免 glm-5.2 误中 glm-5
const CONTEXT_WINDOWS: Record<string, number> = {
    'glm-5.2': 200000,   // 默认 200K；开启 1M 需后缀 [1m] 或设 CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000
    'glm-5.1': 200000,
    'glm-5': 200000,
    'glm-4': 128000,
    'opus': 200000,
    'sonnet': 200000,
    'haiku': 200000,
}

// GLM 模型价格（每百万 tokens）
const GLM_PRICING: Record<string, { input: number; output: number }> = {
    'glm-5.2': { input: 10, output: 30 },   // 发布初期限时免费，沿用 glm-5 价格作参考
    'glm-5.1': { input: 10, output: 30 },
    'glm-5': { input: 10, output: 30 },
    'glm-4': { input: 5, output: 15 },
}

// Claude 模型价格（每百万 tokens）
const CLAUDE_PRICING: Record<string, { input: number; cache_read: number; output: number }> = {
    'opus': { input: 15, cache_read: 1.5, output: 75 },
    'sonnet': { input: 3, cache_read: 0.3, output: 15 },
    'haiku': { input: 0.8, cache_read: 0.08, output: 4 },
}

// ===== 配额缓存 =====
const QUOTA_CACHE_PATH = path.join(os.tmpdir(), 'claude-monitor-quota.json')
const QUOTA_CACHE_TTL = 3 * 60 * 1000

function readJsonFile<T>(filePath: string): T | null {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T
    } catch {
        return null
    }
}

function writeJsonFile(filePath: string, data: unknown): void {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data), 'utf-8')
    } catch { /* ignore */ }
}

// ===== HTTP GET =====
function httpGet(url: string, headers: Record<string, string> = {}, timeout = 5000): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http
        const req = mod.get(url, { headers, timeout }, (res) => {
            let body = ''
            res.on('data', (c) => body += c)
            res.on('end', () => {
                try { resolve(JSON.parse(body)) }
                catch { reject(new Error('Invalid JSON')) }
            })
        })
        req.on('error', reject)
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    })
}

// ===== 模型名解析 =====
function modelDisplayName(model: string): string {
    if (!model) return 'Unknown'
    const clean = model.replace(/^(models\/|anthropic\/)/, '').replace(/\[1m\]/i, '')
    const lower = clean.toLowerCase()
    const verMatch = lower.match(/[-.](\d+)[-._](\d+)/)

    if (lower.includes('glm-5v')) return 'GLM-5V-Turbo'
    if (lower.includes('glm-5.2') || lower.includes('glm-5-2')) return 'GLM-5.2'
    if (lower.includes('glm-5.1') || lower.includes('glm-5-1')) return 'GLM-5.1'
    if (lower.includes('glm-5-turbo')) return 'GLM-5-Turbo'
    if (lower.includes('glm-5')) {
        const sub = lower.match(/glm-5[.-]?(\d+)?/)
        return sub && sub[1] ? 'GLM-5.' + sub[1] : 'GLM-5'
    }
    if (lower.includes('glm-x')) return 'GLM-X'
    if (lower.includes('glm-4')) {
        const sub = lower.match(/glm-4[.-]?(\w+)?/)
        return sub && sub[1] ? 'GLM-4-' + sub[1].toUpperCase() : 'GLM-4'
    }
    if (lower.includes('opus')) {
        if (verMatch) return 'Opus ' + verMatch[1] + '.' + verMatch[2]
        return 'Opus'
    }
    if (lower.includes('sonnet')) {
        if (verMatch) return 'Sonnet ' + verMatch[1] + '.' + verMatch[2]
        return 'Sonnet'
    }
    if (lower.includes('haiku')) {
        if (verMatch) return 'Haiku ' + verMatch[1] + '.' + verMatch[2]
        return 'Haiku'
    }
    if (lower.includes('gpt-4o')) return 'GPT-4o'
    if (lower.includes('gpt-4')) {
        const sub = lower.match(/gpt-4[.-]?(\d+)?/)
        return sub && sub[1] ? 'GPT-4.' + sub[1] : 'GPT-4'
    }
    if (lower.includes('deepseek')) {
        return 'DeepSeek-' + clean.replace(/^deepseek[-.]?/i, '').toUpperCase()
    }
    if (lower.includes('minimax')) return clean
    return '切换中...'
}

// 已知支持 1M 大上下文的模型关键字。JSONL 会剥离 GLM 的 [1m] 后缀，
// 故需结合 CLAUDE_CODE_AUTO_COMPACT_WINDOW 判断；此处限定可升级窗口的型号，避免误判 glm-5.1/glm-4。
const LARGE_CONTEXT_MODELS = ['glm-5.2', 'deepseek-v4-pro']

// 读取 settings.json 中配置的自动压缩窗口（智谱文档：开启 1M 即设为 1000000）
function getAutoCompactWindow(): number | null {
    const settings = readJsonFile<{ env?: Record<string, string> }>(path.join(CLAUDE_DIR, 'settings.json'))
    const raw = settings?.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW
    if (!raw) return null
    const n = parseInt(raw, 10)
    return Number.isFinite(n) && n > 0 ? n : null
}

function contextWindowSize(model: string): number {
    const lower = (model || '').toLowerCase()
    // 1) 显式 1M 后缀（如 glm-5.2[1m]、deepseek-v4-pro[1m]）
    if (lower.includes('[1m]')) return 1_000_000
    // 2) 模型表基础窗口（keys 按长度降序，避免 glm-5.2 误中 glm-5）
    let base = 200_000
    for (const key of Object.keys(CONTEXT_WINDOWS).sort((a, b) => b.length - a.length)) {
        if (lower.includes(key)) { base = CONTEXT_WINDOWS[key]; break }
    }
    // 3) 用户配置的压缩窗口：仅当模型支持大上下文时才采纳（兜住 JSONL 剥离 [1m] 的情况）
    const auto = getAutoCompactWindow()
    if (auto && auto > base && LARGE_CONTEXT_MODELS.some(k => lower.includes(k))) {
        return auto
    }
    return base
}

function estimateCost(model: string, totalInput: number, totalOutput: number, cacheRead: number): number {
    const lower = model.toLowerCase()

    // GLM 模型（keys 按长度降序，避免 glm-5.2 误中 glm-5）
    for (const key of Object.keys(GLM_PRICING).sort((a, b) => b.length - a.length)) {
        if (lower.includes(key)) {
            const pricing = GLM_PRICING[key]
            return (totalInput * pricing.input + totalOutput * pricing.output) / 1_000_000
        }
    }

    // Claude 模型
    for (const [key, pricing] of Object.entries(CLAUDE_PRICING)) {
        if (lower.includes(key)) {
            return ((totalInput - cacheRead) * pricing.input + cacheRead * pricing.cache_read + totalOutput * pricing.output) / 1_000_000
        }
    }

    // 默认：按 Sonnet 价格
    const p = CLAUDE_PRICING['sonnet']
    return ((totalInput - cacheRead) * p.input + cacheRead * p.cache_read + totalOutput * p.output) / 1_000_000
}

// ===== 路径编码 =====
function encodeProjectPath(cwd: string): string {
    // Windows: f:\Projects\... -> f--Projects-...
    // Unix: /home/user/... -> -home-user-...
    let normalized = cwd.replace(/\\/g, '/').replace(/:/g, '')
    normalized = normalized.replace(/\//g, '-')
    return normalized
}

// ===== 获取活跃会话 =====
function getActiveSession(): SessionInfo | null {
    try {
        const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'))
        let latest: SessionInfo | null = null
        for (const file of files) {
            const info = readJsonFile<SessionInfo>(path.join(SESSIONS_DIR, file))
            if (info && (!latest || info.startedAt > latest.startedAt)) {
                latest = info
            }
        }
        return latest
    } catch {
        return null
    }
}

// ===== 获取会话 JSONL 路径 =====
function getSessionJsonlPath(sessionId: string, cwd: string): string | null {
    const encoded = encodeProjectPath(cwd)
    const candidate = path.join(PROJECTS_DIR, encoded, sessionId + '.jsonl')
    try {
        fs.accessSync(candidate, fs.constants.R_OK)
        return candidate
    } catch { /* not found by ID */ }

    // 回退：在项目目录中找最近修改的 JSONL 文件
    let latest: { path: string; mtime: number } | null = null
    const searchDirs = [path.join(PROJECTS_DIR, encoded)]
    try {
        const dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
        for (const d of dirs) {
            if (d.isDirectory()) searchDirs.push(path.join(PROJECTS_DIR, d.name))
        }
    } catch { }
    for (const dir of [...new Set(searchDirs)]) {
        try {
            for (const f of fs.readdirSync(dir)) {
                if (!f.endsWith('.jsonl')) continue
                const p = path.join(dir, f)
                const stat = fs.statSync(p)
                if (!latest || stat.mtimeMs > latest.mtime) {
                    latest = { path: p, mtime: stat.mtimeMs }
                }
            }
        } catch { continue }
    }
    // 只使用 10 分钟内修改过的文件
    if (latest && Date.now() - latest.mtime < 10 * 60 * 1000) {
        return latest.path
    }
    return null
}

// ===== 解析 JSONL 文件 =====
function parseSessionData(jsonlPath: string) {
    const raw = fs.readFileSync(jsonlPath, 'utf-8')
    const lines = raw.split('\n')

    let modelName = ''
    let totalInputTokens = 0
    let totalOutputTokens = 0
    let totalCacheRead = 0
    let totalCacheCreate = 0
    let promptCount = 0
    let lastInputTokens = 0
    let lastCacheRead = 0
    let lastCacheCreate = 0
    const timestamps: number[] = []
    const outputTokenDeltas: number[] = []
    const inputTokenDeltas: number[] = []   // 每轮相对上一轮的输入净增量（见下）
    const durationsMs: number[] = []        // 每轮 user→assistant 的真实墙钟耗时（治本：替代落盘间隔）
    let prevInputTokens = 0
    let lastUserTs = 0                      // 最近一条 user/tool_result 落盘时刻，作为下一轮请求起点

    for (const line of lines) {
        if (!line.trim()) continue
        try {
            const entry = JSON.parse(line)
            if (entry.isSidechain) continue            // 排除子代理记录，只统计主链
            const ts = new Date(entry.timestamp).getTime()

            // user 行（含工具结果 tool_result）：作为下一轮 assistant 的请求起点
            if (entry.type === 'user') {
                if (isFinite(ts)) lastUserTs = ts
                continue
            }
            if (entry.type !== 'assistant') continue
            const msg = entry.message
            if (!msg?.usage) continue

            modelName = msg.model || modelName
            const usage = msg.usage
            totalInputTokens += usage.input_tokens || 0
            totalOutputTokens += usage.output_tokens || 0
            totalCacheRead += usage.cache_read_input_tokens || 0
            totalCacheCreate += usage.cache_creation_input_tokens || 0
            lastInputTokens = usage.input_tokens || 0
            lastCacheRead = usage.cache_read_input_tokens || 0
            lastCacheCreate = usage.cache_creation_input_tokens || 0
            promptCount++

            timestamps.push(ts)
            outputTokenDeltas.push(usage.output_tokens || 0)
            // 输入按相邻轮的净增量统计：无缓存时 usage.input_tokens 是每轮总输入（含历史），
            // 直接累加会让「输入速度」爆到 9w+ t/s，故取本轮相对上一轮的正向增量。
            const curInput = usage.input_tokens || 0
            inputTokenDeltas.push(prevInputTokens > 0 ? Math.max(0, curInput - prevInputTokens) : 0)
            prevInputTokens = curInput
            // 本轮真实耗时 = 本 assistant 落盘 - 上一条 user/tool_result 落盘。
            // 用它当分母替代「相邻 assistant 落盘差」，根治长回复被短间隔除出几千 t/s 的问题。
            const dur = lastUserTs > 0 ? ts - lastUserTs : 0
            durationsMs.push(isFinite(dur) && dur > 0 ? dur : 0)
        } catch { continue }
    }

    return {
        modelName,
        totalInputTokens,
        totalOutputTokens,
        totalCacheRead,
        totalCacheCreate,
        lastInputTokens,
        lastCacheRead,
        lastCacheCreate,
        promptCount,
        timestamps,
        outputTokenDeltas,
        inputTokenDeltas,
        durationsMs,
    }
}

// ===== 配额获取 =====
interface QuotaResult {
    quota5hPct: number
    quota5hResetTime: number
    quotaWeeklyPct: number
    quotaWeeklyResetTime: number
    mcpPct: number
    mcpResetTime: number
    planLevel: string
    usage24h: UsageBucket
    usageToday: UsageBucket
    usage7d: UsageBucket
    usage30d: UsageBucket
}

function getApiBaseUrl(): string | null {
    let baseUrl = process.env.ANTHROPIC_BASE_URL
    if (!baseUrl) {
        const settings = readJsonFile<{ env?: Record<string, string> }>(path.join(CLAUDE_DIR, 'settings.json'))
        baseUrl = settings?.env?.ANTHROPIC_BASE_URL
    }
    if (!baseUrl) return null
    return baseUrl.replace(/\/api\/anthropic/, '/api').replace(/\/anthropic$/, '')
}

function getAuthToken(): string | null {
    let token = process.env.ANTHROPIC_AUTH_TOKEN
    if (!token) {
        const settings = readJsonFile<{ env?: Record<string, string> }>(path.join(CLAUDE_DIR, 'settings.json'))
        token = settings?.env?.ANTHROPIC_AUTH_TOKEN
    }
    return token || null
}

interface ModelUsageResponse {
    code: number
    success: boolean
    data: {
        x_time: string[]
        tokensUsage: number[]
        totalUsage: {
            totalModelCallCount: number
            totalTokensUsage: number
            modelSummaryList: { modelName: string; totalTokens: number; sortOrder: number }[]
        }
        modelDataList: {
            modelName: string
            tokensUsage: number[]
        }[]
    }
}

// 智谱平台用北京时间 (UTC+8)
function formatBeijingTime(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0')
    // 手动加8小时偏移
    const utcMs = d.getTime() + d.getTimezoneOffset() * 60000
    const bj = new Date(utcMs + 8 * 3600000)
    return `${bj.getFullYear()}-${pad(bj.getMonth() + 1)}-${pad(bj.getDate())} ${pad(bj.getHours())}:${pad(bj.getMinutes())}:${pad(bj.getSeconds())}`
}

async function fetchModelUsage(apiBase: string, headers: Record<string, string>, hours: number): Promise<ModelUsageResponse | null> {
    try {
        const now = new Date()
        const ago = new Date(now.getTime() - hours * 3600000)
        const start = encodeURIComponent(formatBeijingTime(ago))
        const end = encodeURIComponent(formatBeijingTime(now))
        const url = `${apiBase}/monitor/usage/model-usage?startTime=${start}&endTime=${end}`
        const resp = await httpGet(url, headers) as ModelUsageResponse
        return (resp && resp.success) ? resp : null
    } catch {
        return null
    }
}

// 按精确时间范围查询用量
async function fetchModelUsageInRange(apiBase: string, headers: Record<string, string>, start: Date, end: Date): Promise<ModelUsageResponse | null> {
    try {
        const startStr = encodeURIComponent(formatBeijingTime(start))
        const endStr = encodeURIComponent(formatBeijingTime(end))
        const url = `${apiBase}/monitor/usage/model-usage?startTime=${startStr}&endTime=${endStr}`
        const resp = await httpGet(url, headers) as ModelUsageResponse
        return (resp && resp.success) ? resp : null
    } catch {
        return null
    }
}

// 获取北京时间当天的0点（返回本地Date对象，但代表北京时间）
function beijingTodayStart(): Date {
    return beijingDaysAgoStart(0)
}

// 获取北京时间N天前的0点
function beijingDaysAgoStart(days: number): Date {
    const now = new Date()
    const utcMs = now.getTime() + now.getTimezoneOffset() * 60000
    const bj = new Date(utcMs + 8 * 3600000)
    bj.setHours(0, 0, 0, 0)
    bj.setDate(bj.getDate() - days)
    // 转回本地时间
    return new Date(bj.getTime() - 8 * 3600000 - now.getTimezoneOffset() * 60000)
}

function toBucket(label: string, resp: ModelUsageResponse | null): UsageBucket {
    if (!resp?.data?.totalUsage) return { label, totalTokens: 0, models: [] }
    const t = resp.data.totalUsage
    const models = (t.modelSummaryList || [])
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map(s => ({ name: s.modelName, tokens: s.totalTokens }))
    const totalTokens = t.totalTokensUsage > 0
        ? t.totalTokensUsage
        : models.reduce((sum, m) => sum + m.tokens, 0)
    return { label, totalTokens, models }
}

async function fetchQuota(): Promise<QuotaResult | null> {
    const apiBase = getApiBaseUrl()
    const token = getAuthToken()
    if (!apiBase || !token) return null

    const cached = readJsonFile<{ ts: number; payload: QuotaResult }>(QUOTA_CACHE_PATH)
    if (cached && Date.now() - cached.ts < QUOTA_CACHE_TTL) return cached.payload

    const headers = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
    }

    try {
        const now = new Date()
        const todayStart = beijingTodayStart()
        const weekAgoStart = beijingDaysAgoStart(6)
        const monthAgoStart = beijingDaysAgoStart(29)

        const [quotaResp, resp24h, respToday, resp7d, resp30d] = await Promise.all([
            httpGet(`${apiBase}/monitor/usage/quota/limit`, headers) as Promise<QuotaResponse>,
            fetchModelUsage(apiBase, headers, 24),
            fetchModelUsageInRange(apiBase, headers, todayStart, now),
            fetchModelUsageInRange(apiBase, headers, weekAgoStart, now),
            fetchModelUsageInRange(apiBase, headers, monthAgoStart, now),
        ])

        if (!quotaResp.success || !quotaResp.data?.limits) return null

        const result: QuotaResult = {
            quota5hPct: 0, quota5hResetTime: 0,
            quotaWeeklyPct: 0, quotaWeeklyResetTime: 0,
            mcpPct: 0, mcpResetTime: 0,
            planLevel: quotaResp.data.level || '',
            usage24h: toBucket('24h', resp24h),
            usageToday: toBucket('today', respToday),
            usage7d: toBucket('7d', resp7d),
            usage30d: toBucket('30d', resp30d),
        }

        for (const limit of quotaResp.data.limits) {
            if (limit.type === 'TOKENS_LIMIT' && limit.unit === 3) {
                result.quota5hPct = limit.percentage || 0
                result.quota5hResetTime = limit.nextResetTime || 0
            } else if (limit.type === 'TOKENS_LIMIT' && limit.unit === 6) {
                result.quotaWeeklyPct = limit.percentage || 0
                result.quotaWeeklyResetTime = limit.nextResetTime || 0
            } else if (limit.type === 'TIME_LIMIT') {
                result.mcpPct = limit.percentage || 0
                result.mcpResetTime = limit.nextResetTime || 0
            }
        }

        writeJsonFile(QUOTA_CACHE_PATH, { ts: Date.now(), payload: result })
        return result
    } catch {
        return null
    }
}

// ===== 分时段柱状图数据 =====
const BUCKETED_CACHE_PATH = path.join(os.tmpdir(), 'claude-monitor-bucketed.json')
const BUCKETED_CACHE_TTL = 3 * 60 * 1000

interface BucketedCacheEntry {
    ts: number
    data: BucketedUsage
}

function periodTimeRange(period: '24h' | 'today' | '7d' | '30d'): { start: Date; end: Date } {
    const now = new Date()
    if (period === '24h') {
        return { start: new Date(now.getTime() - 24 * 3600000), end: now }
    }
    if (period === 'today') {
        return { start: beijingTodayStart(), end: now }
    }
    if (period === '7d') {
        return { start: beijingDaysAgoStart(6), end: now }
    }
    return { start: beijingDaysAgoStart(29), end: now }
}

async function fetchBucketedUsage(period: '24h' | 'today' | '7d' | '30d'): Promise<BucketedUsage> {
    const apiBase = getApiBaseUrl()
    const token = getAuthToken()
    const empty: BucketedUsage = { period, buckets: [] }

    if (!apiBase || !token) return empty

    // 检查缓存（每个周期独立时间戳）
    const cached = readJsonFile<Record<string, BucketedCacheEntry>>(BUCKETED_CACHE_PATH)
    const entry = cached?.[period]
    if (entry && Date.now() - entry.ts < BUCKETED_CACHE_TTL) {
        return entry.data
    }

    const headers = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
    }

    // 一次性请求整个时间段，使用服务端返回的趋势数据
    const range = periodTimeRange(period)
    const startStr = encodeURIComponent(formatBeijingTime(range.start))
    const endStr = encodeURIComponent(formatBeijingTime(range.end))
    const url = `${apiBase}/monitor/usage/model-usage?startTime=${startStr}&endTime=${endStr}`

    try {
        const resp = await httpGet(url, headers) as ModelUsageResponse

        if (!resp || !resp.success || !resp.data) return empty

        const xTime = resp.data.x_time || []
        const tokensUsage = resp.data.tokensUsage || []
        const modelDataList = resp.data.modelDataList || []

        if (xTime.length === 0 || tokensUsage.length === 0) return empty

        // 收集所有模型名
        const modelNames = modelDataList.map(m => m.modelName)

        // 构建 buckets
        let buckets: UsageBucket[] = []
        for (let i = 0; i < xTime.length; i++) {
            const models: { name: string; tokens: number }[] = []
            for (let mi = 0; mi < modelNames.length; mi++) {
                const tokens = modelDataList[mi].tokensUsage[i] || 0
                if (tokens > 0) {
                    models.push({ name: modelNames[mi], tokens })
                }
            }
            buckets.push({
                label: xTime[i],
                totalTokens: tokensUsage[i] || 0,
                models,
            })
        }

        // 7d 模式：将4小时桶合并为8小时桶，让柱子更粗
        if (period === '7d' && buckets.length > 1) {
            const merged: UsageBucket[] = []
            for (let i = 0; i < buckets.length; i += 2) {
                const a = buckets[i]
                const b = buckets[i + 1]
                if (b) {
                    const modelMap = new Map<string, number>()
                    for (const m of a.models) modelMap.set(m.name, m.tokens)
                    for (const m of b.models) modelMap.set(m.name, (modelMap.get(m.name) || 0) + m.tokens)
                    merged.push({
                        label: a.label,
                        totalTokens: a.totalTokens + b.totalTokens,
                        models: Array.from(modelMap.entries())
                            .map(([name, tokens]) => ({ name, tokens }))
                            .filter(m => m.tokens > 0),
                    })
                } else {
                    merged.push(a)
                }
            }
            buckets = merged
        }

        const result: BucketedUsage = { period, buckets }

        // 更新缓存（每个周期独立时间戳）
        const existing = cached || {}
        existing[period] = { ts: Date.now(), data: result }
        writeJsonFile(BUCKETED_CACHE_PATH, existing)

        return result
    } catch {
        return empty
    }
}

// ===== DataProvider =====
export class DataProvider {
    private speedState: SpeedState | null = null
    private quota: QuotaResult | null = null
    private quotaFetchPromise: Promise<void> | null = null

    constructor() {
        // 后台获取配额
        this.refreshQuota()
    }

    /** 获取分时段用量数据（供面板使用） */
    async getBucketedUsage(period: '24h' | 'today' | '7d' | '30d'): Promise<BucketedUsage> {
        return fetchBucketedUsage(period)
    }

    /**
     * 基于滑动时间窗口计算平均输入/输出吞吐，并用 EMA 平滑（跨刷新持久化）。
     * 「计算窗口」与「保持显示」解耦：窗口内取样算实时值；闲置 10~120s 之间维持上次值
     * （供状态栏标灰显示，避免思考/间隔期频繁 --）；闲置超 120s 才归零。
     */
    private computeSpeed(
        timestamps: number[],
        inputDeltas: number[],
        outputDeltas: number[],
        durationsMs: number[],
    ): { inputTps: number; outputTps: number; ageMs: number } {
        const winSec = vscode.workspace.getConfiguration('glmMonitor').get<number>('speedWindowSeconds', 10)
        const WINDOW_MS = Math.max(5, Math.round(winSec || 10)) * 1000  // 统计窗口（可配置，默认 10 秒）
        const KEEP_MS = 120_000      // 闲置超过此值才归零，期间保持显示上次速度
        const MIN_DURATION_MS = 200  // 单轮墙钟下限，杜绝时间戳毛刺导致瞬时尖峰
        const ABSURD_TPS = 1000      // 物理不可能的瞬时速度，超过即判本轮 duration 失真并丢弃
        const ALPHA = 0.5            // EMA 平滑系数

        const n = timestamps.length
        const prevOut = this.speedState?.outputTps ?? 0
        const prevIn = this.speedState?.inputTps ?? 0
        if (n === 0) return { inputTps: prevIn, outputTps: prevOut, ageMs: Infinity }

        const lastTs = timestamps[n - 1]
        const ageMs = Date.now() - lastTs   // 距最后一条记录，用于区分实时 / 保持

        // 闲置超过保持期：归零（状态栏显示 --）
        if (ageMs >= KEEP_MS) {
            this.speedState = { lastTimestamp: lastTs, inputTps: 0, outputTps: 0 }
            return { inputTps: 0, outputTps: 0, ageMs }
        }

        const windowStart = lastTs - WINDOW_MS

        // 从最新向最旧累计窗口内的 token 与各自真实耗时。仅纳入 duration 可信的轮：
        // 过短（<下限）或隐含速度物理不可能（>ABSURD_TPS，说明 user→assistant 落盘几乎同刻）
        // 的轮整轮丢弃，不污染平均——这样不设真实速度上限，只剔除明显坏掉的样本。
        let sumIn = 0, sumOut = 0, sumDur = 0
        for (let i = n - 1; i >= 0; i--) {
            if (timestamps[i] < windowStart) break
            const dur = durationsMs[i] || 0
            const outTok = outputDeltas[i] || 0
            if (dur < MIN_DURATION_MS) continue
            if (outTok / (dur / 1000) > ABSURD_TPS) continue   // 配对失真，丢弃
            sumDur += dur
            sumIn += inputDeltas[i] || 0
            sumOut += outTok
        }

        let rawOut = 0, rawIn = 0
        if (sumDur >= MIN_DURATION_MS) {
            const spanSec = sumDur / 1000
            rawOut = sumOut / spanSec    // 不设上限，真实反映
            rawIn = sumIn / spanSec
        }

        let outTps: number, inTps: number
        if (rawOut > 0) {
            // 本轮窗口有计算结果：EMA 平滑（首次直接采信避免起步偏低）
            outTps = prevOut > 0 ? ALPHA * rawOut + (1 - ALPHA) * prevOut : rawOut
            inTps = prevIn > 0 ? ALPHA * rawIn + (1 - ALPHA) * prevIn : rawIn
        } else if (prevOut > 0) {
            // 窗口样本不足（如刚起步、跨度太小），但在保持期内：沿用上次值
            outTps = prevOut
            inTps = prevIn
        } else {
            outTps = 0
            inTps = 0
        }
        this.speedState = { lastTimestamp: lastTs, inputTps: inTps, outputTps: outTps }
        return { inputTps: inTps, outputTps: outTps, ageMs }
    }

    private refreshQuota() {
        if (this.quotaFetchPromise) return
        this.quotaFetchPromise = fetchQuota().then(q => {
            this.quota = q
            this.quotaFetchPromise = null
        }).catch(() => {
            this.quotaFetchPromise = null
        })
    }

    getData(): MonitorData {
        const empty: MonitorData = {
            modelName: '', contextPct: 0, contextUsed: 0, contextTotal: 0,
            inputTps: 0, outputTps: 0, speedAgeMs: 0,
            totalInputTokens: 0, totalOutputTokens: 0,
            cost: 0, promptCount: 0,
            quota5hPct: 0, quota5hResetTime: 0,
            quotaWeeklyPct: 0, quotaWeeklyResetTime: 0,
            mcpPct: 0, mcpResetTime: 0,
            planLevel: '',
            usage24h: { label: '24h', totalTokens: 0, models: [] },
            usageToday: { label: 'today', totalTokens: 0, models: [] },
            usage7d: { label: '7d', totalTokens: 0, models: [] },
            usage30d: { label: '30d', totalTokens: 0, models: [] },
            sessionId: '', active: false,
        }

        // 1. 获取活跃会话
        const session = getActiveSession()
        if (!session) return empty

        const sessionId = session.sessionId

        // 2. 检查进程是否存活
        try {
            process.kill(session.pid, 0)
        } catch {
            return empty
        }

        // 3. 查找 JSONL 文件
        const jsonlPath = getSessionJsonlPath(sessionId, session.cwd)
        if (!jsonlPath) return empty

        // 4. 解析会话数据
        const data = parseSessionData(jsonlPath)
        if (data.promptCount === 0) return empty

        const modelName = modelDisplayName(data.modelName)
        const ctxTotal = contextWindowSize(data.modelName)
        // 上下文已用 = 最新一次请求的 input_tokens + cache_read_input_tokens
        const lastEntryInput = data.lastInputTokens + data.lastCacheRead + data.lastCacheCreate
        const ctxUsed = Math.min(lastEntryInput, ctxTotal)
        const ctxPct = ctxTotal > 0 ? Math.round((ctxUsed / ctxTotal) * 100) : 0

        // 5. 计算速度：每轮按 user→assistant 的真实墙钟耗时，窗口内 Σtoken / Σ耗时，再用 EMA 平滑。
        //    早期用「相邻 assistant 落盘差」当分母，长回复被短间隔除会算出几千 t/s；改用真实耗时根治。
        const { inputTps, outputTps, ageMs } = this.computeSpeed(
            data.timestamps,
            data.inputTokenDeltas,
            data.outputTokenDeltas,
            data.durationsMs,
        )

        // 6. 计算花费
        const cost = estimateCost(data.modelName, data.totalInputTokens + data.totalCacheRead, data.totalOutputTokens, data.totalCacheRead)

        // 7. 配额
        let quota5hPct = 0, quota5hResetTime = 0
        let quotaWeeklyPct = 0, quotaWeeklyResetTime = 0
        let mcpPct = 0, mcpResetTime = 0
        let planLevel = ''
        let usage24h: UsageBucket = { label: '24h', totalTokens: 0, models: [] }
        let usageToday: UsageBucket = { label: 'today', totalTokens: 0, models: [] }
        let usage7d: UsageBucket = { label: '7d', totalTokens: 0, models: [] }
        let usage30d: UsageBucket = { label: '30d', totalTokens: 0, models: [] }
        if (this.quota) {
            quota5hPct = this.quota.quota5hPct
            quota5hResetTime = this.quota.quota5hResetTime
            quotaWeeklyPct = this.quota.quotaWeeklyPct
            quotaWeeklyResetTime = this.quota.quotaWeeklyResetTime
            mcpPct = this.quota.mcpPct
            mcpResetTime = this.quota.mcpResetTime
            planLevel = this.quota.planLevel
            usage24h = this.quota.usage24h
            usageToday = this.quota.usageToday
            usage7d = this.quota.usage7d
            usage30d = this.quota.usage30d
        }

        // 定期刷新配额
        this.refreshQuota()

        return {
            modelName,
            contextPct: ctxPct, contextUsed: ctxUsed, contextTotal: ctxTotal,
            inputTps, outputTps, speedAgeMs: ageMs,
            totalInputTokens: data.totalInputTokens + data.totalCacheRead,
            totalOutputTokens: data.totalOutputTokens,
            cost, promptCount: data.promptCount,
            quota5hPct, quota5hResetTime,
            quotaWeeklyPct, quotaWeeklyResetTime,
            mcpPct, mcpResetTime,
            planLevel,
            usage24h, usageToday, usage7d, usage30d,
            sessionId, active: true,
        }
    }
}
