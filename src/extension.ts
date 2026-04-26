import * as vscode from 'vscode'
import { DataProvider } from './dataProvider'
import { StatusBarManager } from './statusBarManager'
import { showQuotaPanel } from './quotaPanel'

function formatTokenCount(n: number): string {
    if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + 'B'
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
    if (n >= 1_000) return (n / 1_000).toFixed(2) + 'k'
    return String(n)
}

let manager: StatusBarManager | null = null

export function activate(context: vscode.ExtensionContext) {
    // 防止重复激活
    if (manager) return

    // 检测是否有同类扩展重复安装
    const duplicates = vscode.extensions.all.filter(
        e => e.id !== context.extension.id && e.id.toLowerCase().includes('codingplan-monitor')
    )
    if (duplicates.length > 0) {
        const names = duplicates.map(e => `${e.id} (v${e.packageJSON.version})`).join(', ')
        vscode.window.showWarningMessage(
            `检测到重复安装的同类扩展: ${names}，建议卸载旧版本以避免冲突。`,
            '知道了'
        )
    }

    const provider = new DataProvider()
    manager = new StatusBarManager(provider)
    manager.start()

    const showDetails = vscode.commands.registerCommand('glmMonitor.showDetails', () => {
        const data = provider.getData()
        const lines: string[] = []
        lines.push(`模型: ${data.modelName || '-'}`)
        lines.push(`Context: ${data.contextPct}% (${formatTokenCount(data.contextUsed)}/${formatTokenCount(data.contextTotal)})`)
        lines.push(`输出速度: ${data.outputTps.toFixed(1)} t/s`)
        lines.push(`花费: $${data.cost.toFixed(4)}`)
        lines.push(`调用: ${data.promptCount} 次`)
        if (data.quota5hPct > 0) lines.push(`5h配额: ${data.quota5hPct}%`)
        if (data.quotaWeeklyPct > 0) lines.push(`周配额: ${data.quotaWeeklyPct}%`)
        if (data.mcpPct > 0) lines.push(`MCP配额: ${data.mcpPct}%`)
        if (data.planLevel) lines.push(`套餐: ${data.planLevel}`)
        vscode.window.showInformationMessage(lines.join(' | '), { modal: false })
    })

    const showSessionId = vscode.commands.registerCommand('glmMonitor.showSessionId', (sessionId: string) => {
        vscode.window.showInformationMessage(`Session ID: ${sessionId}`)
    })

    const showQuota = vscode.commands.registerCommand('glmMonitor.showQuota', () => {
        showQuotaPanel(provider)
    })

    context.subscriptions.push(
        showDetails,
        showSessionId,
        showQuota,
        {
            dispose: () => {
                if (manager) {
                    manager.stop()
                    manager = null
                }
            },
        },
    )
}

export function deactivate() {
    if (manager) {
        manager.stop()
        manager = null
    }
}
