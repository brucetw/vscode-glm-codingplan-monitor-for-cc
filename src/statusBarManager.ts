import * as vscode from 'vscode'
import { DataProvider } from './dataProvider'
import type { MonitorData } from './types'

function formatTokenCount(n: number): string {
    if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + 'B'
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
    if (n >= 1_000) return (n / 1_000).toFixed(2) + 'k'
    return String(n)
}

function progressBar(ratio: number, width = 6): string {
    const filled = Math.round(ratio * width)
    const empty = width - filled
    return '█'.repeat(filled) + '░'.repeat(empty)
}

interface StatusItem {
    item: vscode.StatusBarItem
    update(data: MonitorData): void
}

export class StatusBarManager {
    private provider: DataProvider
    private timer: ReturnType<typeof setInterval> | null = null
    private items: StatusItem[] = []

    constructor(provider: DataProvider) {
        this.provider = provider
    }

    start() {
        // 防止重复启动：如果已经在运行，先停止旧的
        if (this.timer !== null) {
            this.stop()
        }

        const config = vscode.workspace.getConfiguration('glmMonitor')
        const interval = config.get<number>('refreshInterval', 1000)

        this.createItems()
        this.refresh()

        this.timer = setInterval(() => this.refresh(), interval)
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer)
            this.timer = null
        }
        for (const s of this.items) {
            s.item.dispose()
        }
        this.items = []
    }

    private refresh() {
        const data = this.provider.getData()
        for (const s of this.items) {
            s.update(data)
        }
    }

    private createItems() {
        const config = vscode.workspace.getConfiguration('glmMonitor')

        if (config.get<boolean>('showTokenUsage', true)) {
            this.items.push(this.createTokenUsageItem())
        }
        if (config.get<boolean>('showModel', true)) {
            this.items.push(this.createModelItem())
        }
        if (config.get<boolean>('showContext', true)) {
            this.items.push(this.createContextItem())
        }
        if (config.get<boolean>('showSpeed', true)) {
            this.items.push(this.createOutputSpeedItem())
        }
        if (config.get<boolean>('showPrompts', true)) {
            this.items.push(this.createPromptItem())
        }
        if (config.get<boolean>('showQuota', true)) {
            this.items.push(this.createQuotaItem())
        }
    }

    private createTokenUsageItem(): StatusItem {
        const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 30)
        item.command = 'glmMonitor.showQuota'
        const status: StatusItem = {
            item,
            update(data) {
                if (!data.active || data.usage24h.totalTokens <= 0) {
                    item.hide()
                    return
                }
                item.text = `$(layers) 24h ${formatTokenCount(data.usage24h.totalTokens)}`

                const tipLines: string[] = []
                tipLines.push(`**24h**: ${formatTokenCount(data.usage24h.totalTokens)} tokens`)
                if (data.usage24h.models.length > 0) {
                    for (const m of data.usage24h.models) {
                        tipLines.push(`　${m.name}: ${formatTokenCount(m.tokens)}`)
                    }
                }
                tipLines.push('---')
                tipLines.push(`**当天**: ${formatTokenCount(data.usageToday.totalTokens)} tokens`)
                if (data.usageToday.models.length > 0) {
                    for (const m of data.usageToday.models) {
                        tipLines.push(`　${m.name}: ${formatTokenCount(m.tokens)}`)
                    }
                }
                tipLines.push('---')
                tipLines.push(`**7天**: ${formatTokenCount(data.usage7d.totalTokens)} tokens`)
                if (data.usage7d.models.length > 0) {
                    for (const m of data.usage7d.models) {
                        tipLines.push(`　${m.name}: ${formatTokenCount(m.tokens)}`)
                    }
                }
                tipLines.push('---')
                tipLines.push(`**30天**: ${formatTokenCount(data.usage30d.totalTokens)} tokens`)
                if (data.usage30d.models.length > 0) {
                    for (const m of data.usage30d.models) {
                        tipLines.push(`　${m.name}: ${formatTokenCount(m.tokens)}`)
                    }
                }
                tipLines.push('---')
                tipLines.push('*点击查看分时段柱状图*')
                item.tooltip = new vscode.MarkdownString(tipLines.join('\n\n'))
                item.show()
            },
        }
        return status
    }

    private createModelItem(): StatusItem {
        const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
        const status: StatusItem = {
            item,
            update(data) {
                if (!data.active || !data.modelName) {
                    item.hide()
                    return
                }
                item.text = `$(symbol-method) ${data.modelName}`
                item.tooltip = new vscode.MarkdownString(`**模型**: ${data.modelName}\n\n**Session**: ${data.sessionId.slice(0, 8)}...\n\n*点击显示 Session ID*`)
                item.command = {
                    title: 'Show Session ID',
                    command: 'glmMonitor.showSessionId',
                    arguments: [data.sessionId],
                } as any
                item.show()
            },
        }
        return status
    }

    private createContextItem(): StatusItem {
        const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90)
        const status: StatusItem = {
            item,
            update(data) {
                if (!data.active || data.contextPct <= 0) {
                    item.hide()
                    return
                }
                const bar = progressBar(data.contextPct / 100, 10)
                const color = data.contextPct > 80 ? '#f56c6c' : data.contextPct > 50 ? '#e6a23c' : undefined
                item.text = `$(graph) ${bar} ${data.contextPct}%`
                item.color = color
                item.tooltip = new vscode.MarkdownString(
                    `**Context 使用率**: ${data.contextPct}%\n\n` +
                    `已用: ${formatTokenCount(data.contextUsed)} tokens\n\n` +
                    `总量: ${formatTokenCount(data.contextTotal)} tokens`
                )
                item.show()
            },
        }
        return status
    }

    private createOutputSpeedItem(): StatusItem {
        const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 80)
        const status: StatusItem = {
            item,
            update(data) {
                if (!data.active) {
                    item.hide()
                    return
                }
                const speed = data.outputTps
                const str = speed > 0 ? speed.toFixed(1) : '--'
                item.text = `$(arrow-down) ${str} t/s`
                item.tooltip = new vscode.MarkdownString(`**输出速度**: ${str} tokens/s`)
                item.show()
            },
        }
        return status
    }

    private createPromptItem(): StatusItem {
        const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50)
        const status: StatusItem = {
            item,
            update(data) {
                if (!data.active || data.promptCount <= 0) {
                    item.hide()
                    return
                }
                item.text = `$(pulse) ${data.promptCount}`
                item.tooltip = new vscode.MarkdownString(`**API 调用次数**: ${data.promptCount}\n\n**Session**: ${data.sessionId.slice(0, 8)}...`)
                item.show()
            },
        }
        return status
    }

    private createQuotaItem(): StatusItem {
        const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 40)
        const status: StatusItem = {
            item,
            update(data) {
                if (!data.active) {
                    item.hide()
                    return
                }
                const parts: string[] = []

                if (data.quota5hPct > 0) {
                    const bar = progressBar(data.quota5hPct / 100, 10)
                    parts.push(`5h ${bar} ${data.quota5hPct}%`)
                }
                if (data.quotaWeeklyPct > 0) {
                    parts.push(`W:${data.quotaWeeklyPct}%`)
                }
                if (data.mcpPct > 0) {
                    parts.push(`MCP:${data.mcpPct}%`)
                }

                if (parts.length === 0) {
                    item.hide()
                    return
                }

                // 颜色
                const maxPct = Math.max(data.quota5hPct, data.quotaWeeklyPct, data.mcpPct)
                item.color = maxPct > 90 ? '#f56c6c' : maxPct > 70 ? '#e6a23c' : undefined

                const levelTag = data.planLevel ? `套餐:${data.planLevel} ` : ''
                item.text = `$(gauge) ${levelTag}${parts.join(' ')}`

                // hover tooltip: 仅配额百分比
                const tipLines: string[] = []
                if (data.quota5hPct > 0) {
                    const reset5h = data.quota5hResetTime > 0 ? new Date(data.quota5hResetTime).toLocaleTimeString() : '-'
                    tipLines.push(`**5h 滚动窗口**: ${data.quota5hPct}%　重置: ${reset5h}`)
                }
                if (data.quotaWeeklyPct > 0) {
                    const resetW = data.quotaWeeklyResetTime > 0 ? new Date(data.quotaWeeklyResetTime).toLocaleString() : '-'
                    tipLines.push(`**周限制**: ${data.quotaWeeklyPct}%　重置: ${resetW}`)
                }
                if (data.mcpPct > 0) {
                    tipLines.push(`**MCP**: ${data.mcpPct}%`)
                }
                if (tipLines.length > 0) {
                    item.tooltip = new vscode.MarkdownString(tipLines.join('\n\n'))
                }
                item.show()
            },
        }
        return status
    }
}
