/** sessions/*.json 的格式 */
export interface SessionInfo {
    pid: number
    sessionId: string
    cwd: string
    startedAt: number
    procStart?: string
    version: string
    kind: string
    entrypoint: string
}

/** assistant 消息中的 usage 结构 */
export interface MessageUsage {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
}

/** JSONL 中 assistant 消息结构 */
export interface AssistantEntry {
    type: 'assistant'
    message: {
        id: string
        type: string
        role: 'assistant'
        model: string
        content: unknown[]
        stop_reason: string
        usage: MessageUsage
    }
    timestamp: string
    sessionId: string
    uuid: string
}

/** JSONL 中 user 消息结构 */
export interface UserEntry {
    type: 'user'
    message: {
        role: 'user'
        content: unknown[]
    }
    timestamp: string
    sessionId: string
    uuid: string
}

/** 速度计算缓存 */
export interface SpeedState {
    lastTimestamp: number
    lastInputTokens: number
    lastOutputTokens: number
    inputTps: number
    outputTps: number
}

/** GLM 配额 API 响应 */
export interface QuotaResponse {
    code: number
    msg: string
    data: {
        limits: QuotaLimit[]
        level: string
    }
    success: boolean
}

export interface QuotaLimit {
    type: 'TOKENS_LIMIT' | 'TIME_LIMIT'
    unit: number      // 3=5小时, 5=天, 6=周
    number: number
    usage?: number
    currentValue?: number
    remaining?: number
    percentage: number
    nextResetTime?: number
    usageDetails?: { modelCode: string; usage: number }[]
}

/** 单个时间段的模型用量 */
export interface UsageBucket {
    label: string
    totalTokens: number
    models: { name: string; tokens: number }[]
}

/** 分时段的一个柱子 */
export interface TimeBucket {
    label: string       // e.g. "14:00", "周一", "4/20"
    start?: number      // ms timestamp (optional, server may not provide)
    end?: number        // ms timestamp (optional, server may not provide)
    totalTokens: number
    models: { name: string; tokens: number }[]
}

/** 分时段数据（一个周期） */
export interface BucketedUsage {
    period: '24h' | 'today' | '7d' | '30d'
    buckets: TimeBucket[]
}

/** 聚合后的监控数据，供状态栏使用 */
export interface MonitorData {
    modelName: string
    contextPct: number
    contextUsed: number
    contextTotal: number
    inputTps: number
    outputTps: number
    totalInputTokens: number
    totalOutputTokens: number
    cost: number
    promptCount: number
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
    sessionId: string
    active: boolean
}
