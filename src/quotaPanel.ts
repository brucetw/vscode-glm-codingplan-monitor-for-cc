import * as vscode from 'vscode'
import { DataProvider } from './dataProvider'
import type { MonitorData } from './types'

function formatTokenCount(n: number): string {
    if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + 'B'
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
    if (n >= 1_000) return (n / 1_000).toFixed(2) + 'k'
    return String(n)
}

function getHtml(data: MonitorData): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
        font-family: var(--vscode-font-family, -apple-system, sans-serif);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        padding: 12px 16px;
        min-width: 580px;
        max-width: 960px;
    }
    .header {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 10px;
    }
    h2 { font-size: 15px; }
    .plan-badge {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        padding: 2px 8px;
        border-radius: 4px;
        font-size: 11px;
        font-weight: 600;
    }
    .quota-row {
        display: flex;
        gap: 10px;
        margin-bottom: 12px;
        flex-wrap: wrap;
    }
    .quota-card {
        background: var(--vscode-editor-inactiveSelectionBackground, rgba(128,128,128,0.1));
        border-radius: 6px;
        padding: 8px 12px;
        min-width: 120px;
    }
    .quota-card .label { font-size: 10px; opacity: 0.7; margin-bottom: 2px; }
    .quota-card .value { font-size: 18px; font-weight: 700; }
    .quota-card .reset { font-size: 9px; opacity: 0.5; margin-top: 2px; }
    .tabs {
        display: flex;
        gap: 4px;
        margin-bottom: 10px;
    }
    .tab {
        padding: 4px 12px;
        border-radius: 4px;
        font-size: 12px;
        cursor: pointer;
        border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
        background: transparent;
        color: var(--vscode-foreground);
        opacity: 0.6;
    }
    .tab:hover { opacity: 0.8; }
    .tab.active {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border-color: transparent;
        opacity: 1;
    }
    .chart-container {
        position: relative;
        width: 100%;
        height: 280px;
        background: var(--vscode-editor-inactiveSelectionBackground, rgba(128,128,128,0.05));
        border-radius: 6px;
        padding: 20px 6px 28px 40px;
        overflow: visible;
    }
    .chart-area {
        position: absolute;
        left: 40px;
        right: 6px;
        top: 20px;
        bottom: 28px;
        display: flex;
        align-items: flex-end;
        gap: 1px;
    }
    .bar-group {
        flex: 1;
        min-width: 0;
        display: flex;
        justify-content: center;
        align-items: flex-end;
        position: relative;
    }
    .bar-col {
        width: 65%;
        min-width: 3px;
        display: flex;
        flex-direction: column-reverse;
    }
    .bar-seg {
        width: 100%;
        border-radius: 2px 2px 0 0;
    }
    .bar-seg:hover { filter: brightness(1.25); cursor: pointer; }
    .x-axis {
        position: absolute;
        left: 40px;
        right: 6px;
        bottom: 4px;
        height: 20px;
        font-size: 10px;
        opacity: 0.6;
    }
    .x-label {
        position: absolute;
        bottom: 0;
        white-space: nowrap;
        transform: translateX(-50%);
    }
    .y-axis {
        position: absolute;
        left: 0;
        top: 20px;
        bottom: 22px;
        width: 36px;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        font-size: 9px;
        opacity: 0.5;
        text-align: right;
        padding-right: 4px;
    }
    .tooltip {
        display: none;
        position: absolute;
        bottom: 100%;
        left: 50%;
        transform: translateX(-50%);
        margin-bottom: 4px;
        background: var(--vscode-editor-background, #1e1e2e);
        border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
        border-radius: 4px;
        padding: 4px 8px;
        font-size: 10px;
        white-space: nowrap;
        z-index: 99;
        box-shadow: 0 2px 8px rgba(0,0,0,0.4);
    }
    .bar-group:hover .tooltip { display: block; }
    .legend {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
        margin-top: 8px;
        font-size: 11px;
        opacity: 0.7;
    }
    .legend-item { display: flex; align-items: center; gap: 4px; }
    .legend-dot { width: 8px; height: 8px; border-radius: 50%; }
    .loading {
        text-align: center;
        padding: 40px;
        opacity: 0.5;
        font-size: 13px;
    }
</style>
</head>
<body>
<div class="header">
    <h2>Token 用量</h2>
    ${data.planLevel ? '<span class="plan-badge">套餐: ' + data.planLevel + '</span>' : ''}
</div>
<div class="quota-row">
    ${data.quota5hPct > 0 ? '<div class="quota-card"><div class="label">5小时滚动窗口</div><div class="value">' + data.quota5hPct + '%</div><div class="reset">重置: ' + (data.quota5hResetTime > 0 ? new Date(data.quota5hResetTime).toLocaleTimeString() : '-') + '</div></div>' : ''}
    ${data.quotaWeeklyPct > 0 ? '<div class="quota-card"><div class="label">周限额</div><div class="value">' + data.quotaWeeklyPct + '%</div><div class="reset">重置: ' + (data.quotaWeeklyResetTime > 0 ? new Date(data.quotaWeeklyResetTime).toLocaleString() : '-') + '</div></div>' : ''}
    ${data.mcpPct > 0 ? '<div class="quota-card"><div class="label">MCP</div><div class="value">' + data.mcpPct + '%</div><div class="reset">' + (data.mcpResetTime > 0 ? '重置: ' + new Date(data.mcpResetTime).toLocaleTimeString() : '') + '</div></div>' : ''}
</div>
<div class="quota-row">
    <div class="quota-card"><div class="label">24小时用量</div><div class="value">${formatTokenCount(data.usage24h.totalTokens)}</div></div>
    <div class="quota-card"><div class="label">当天用量</div><div class="value">${formatTokenCount(data.usageToday.totalTokens)}</div></div>
    <div class="quota-card"><div class="label">7天用量</div><div class="value">${formatTokenCount(data.usage7d.totalTokens)}</div></div>
    <div class="quota-card"><div class="label">30天用量</div><div class="value">${formatTokenCount(data.usage30d.totalTokens)}</div></div>
</div>
<div class="tabs">
    <button class="tab active" data-period="24h">24小时</button>
    <button class="tab" data-period="today">当天</button>
    <button class="tab" data-period="7d">近7天</button>
    <button class="tab" data-period="30d">近30天</button>
</div>
<div style="font-size:10px;opacity:0.5;margin-bottom:6px;">Token 用量数据最多有 3 分钟延迟</div>
<div id="chart" class="chart-container">
    <div class="loading">加载中...</div>
</div>
<div id="legend" class="legend"></div>

<script>
const vscode = acquireVsCodeApi()

function formatTokens(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
    if (n >= 1e3) return (n / 1e3).toFixed(2) + 'k'
    return String(n)
}

function extractTime(label) {
    const m = label.match(/(\\d{1,2}:\\d{2})/)
    return m ? m[1] : label
}

function extractDate(label) {
    const m = label.match(/(\\d{4})-(\\d{1,2})-(\\d{1,2})/)
    if (m) return m[2] + '-' + m[3]
    const m2 = label.match(/(\\d{1,2}\\/\\d{1,2})/)
    if (m2) return m2[0]
    return label
}

const MODEL_COLORS = {
    'GLM-5.1': '#4A90D9', 'GLM-5-Turbo': '#50C878',
    'GLM-5V-Turbo': '#F5A623', 'GLM-5': '#9B59B6',
    'GLM-4.7': '#E67E22', 'GLM-4': '#E74C3C',
}
function modelColor(name) {
    if (MODEL_COLORS[name]) return MODEL_COLORS[name]
    const l = name.toLowerCase()
    if (l.includes('glm-5.1')) return '#4A90D9'
    if (l.includes('glm-5v')) return '#F5A623'
    if (l.includes('glm-5')) return '#50C878'
    if (l.includes('glm-4.7')) return '#E67E22'
    if (l.includes('glm-4')) return '#E74C3C'
    return '#95A5A6'
}

function renderChart(buckets, period) {
    const chart = document.getElementById('chart')
    const legend = document.getElementById('legend')
    if (!buckets || buckets.length === 0) {
        chart.innerHTML = '<div class="loading">暂无数据</div>'
        legend.innerHTML = ''
        return
    }
    const maxTokens = Math.max(...buckets.map(b => b.totalTokens), 1)
    const count = buckets.length

    // Y axis labels
    const yLabels = [formatTokens(maxTokens), formatTokens(maxTokens * 0.5), '0']

    let html = '<div class="y-axis">' + yLabels.map(l => '<span>' + l + '</span>').join('') + '</div>'
    html += '<div class="chart-area" id="chartArea">'

    // collect all model names for legend
    const allModels = new Map()
    for (const b of buckets) {
        for (const m of b.models) {
            if (!allModels.has(m.name)) allModels.set(m.name, modelColor(m.name))
        }
    }

    // 收集X轴标签：根据period类型分别处理
    const xLabels = []
    if (period === 'today') {
        // 当天模式：只显示时间 HH:mm
        const step = count > 20 ? Math.ceil(count / 12) : 1
        for (let i = 0; i < count; i += step) {
            xLabels.push({ pos: (i + 0.5) / count * 100, label: extractTime(buckets[i].label) })
        }
    } else if (period === '7d') {
        // 7天模式：提取每天日期，显示 M/D 格式
        let lastDate = ''
        let foundAny = false
        for (let i = 0; i < count; i++) {
            const d = extractDate(buckets[i].label)
            if (d !== lastDate) {
                lastDate = d
                xLabels.push({ pos: i / count * 100, label: d })
                foundAny = true
            }
        }
        if (!foundAny && count > 0) {
            const step = Math.ceil(count / 7)
            for (let i = 0; i < count; i += step) {
                xLabels.push({ pos: (i + 0.5) / count * 100, label: extractTime(buckets[i].label) })
            }
        }
    } else if (period === '30d') {
        // 30天模式：提取日期，显示约6个标签
        const dates = []
        let lastDate = ''
        for (let i = 0; i < count; i++) {
            const d = extractDate(buckets[i].label)
            if (d !== lastDate) {
                lastDate = d
                dates.push({ pos: i / count * 100, label: d })
            }
        }
        const step = Math.max(1, Math.ceil(dates.length / 6))
        for (let i = 0; i < dates.length; i += step) {
            xLabels.push(dates[i])
        }
        if (dates.length > 0 && xLabels.length > 0 && xLabels[xLabels.length - 1].label !== dates[dates.length - 1].label) {
            xLabels.push(dates[dates.length - 1])
        }
    } else {
        // 24小时模式：显示时间
        const step = count > 20 ? Math.ceil(count / 12) : 1
        for (let i = 0; i < count; i += step) {
            xLabels.push({ pos: (i + 0.5) / count * 100, label: extractTime(buckets[i].label) })
        }
    }

    for (let i = 0; i < count; i++) {
        const b = buckets[i]

        // tooltip content
        let tipHtml = b.label + ': ' + formatTokens(b.totalTokens)
        for (const m of b.models) {
            tipHtml += '<br><span style="color:' + modelColor(m.name) + '">&#9679;</span> ' + m.name + ': ' + formatTokens(m.tokens)
        }

        html += '<div class="bar-group" data-index="' + i + '" data-total="' + b.totalTokens + '" data-max="' + maxTokens + '">'
        html += '<div class="tooltip">' + tipHtml + '</div>'
        html += '<div class="bar-col">'

        if (b.totalTokens > 0) {
            for (const m of b.models) {
                html += '<div class="bar-seg" style="background:' + modelColor(m.name) + '" data-tokens="' + m.tokens + '"></div>'
            }
        } else {
            html += '<div class="bar-seg" style="height:2px;background:rgba(128,128,128,0.15)"></div>'
        }

        html += '</div></div>'
    }
    html += '</div>'

    // 独立X轴标签行
    html += '<div class="x-axis">'
    for (const xl of xLabels) {
        html += '<span class="x-label" style="left:' + xl.pos.toFixed(1) + '%">' + xl.label + '</span>'
    }
    html += '</div>'
    chart.innerHTML = html

    // 用实际容器高度计算柱子像素高度
    requestAnimationFrame(() => {
        const area = document.getElementById('chartArea')
        if (!area) return
        const areaH = area.clientHeight
        if (areaH <= 0) return
        const groups = area.querySelectorAll('.bar-group')
        groups.forEach(g => {
            const total = parseFloat(g.dataset.total) || 0
            const maxVal = parseFloat(g.dataset.max) || 1
            const col = g.querySelector('.bar-col')
            if (!col) return
            if (total > 0) {
                const segs = col.querySelectorAll('.bar-seg[data-tokens]')
                segs.forEach(seg => {
                    const tokens = parseFloat(seg.dataset.tokens) || 0
                    seg.style.height = Math.max((tokens / maxVal) * areaH, 1) + 'px'
                })
            }
            col.style.height = Math.max((total / maxVal) * areaH, total > 0 ? 2 : 0) + 'px'
        })
    })

    // legend
    let legendHtml = ''
    for (const [name, color] of allModels) {
        legendHtml += '<span class="legend-item"><span class="legend-dot" style="background:' + color + '"></span>' + name + '</span>'
    }
    legend.innerHTML = legendHtml
}

// Tab switching
document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'))
        tab.classList.add('active')
        const period = tab.dataset.period
        document.getElementById('chart').innerHTML = '<div class="loading">加载中...</div>'
        document.getElementById('legend').innerHTML = ''
        vscode.postMessage({ command: 'loadPeriod', period })
    })
})

window.addEventListener('message', event => {
    const msg = event.data
    if (msg.command === 'chartData') {
        renderChart(msg.buckets, msg.period)
    }
})

// Request initial data
vscode.postMessage({ command: 'loadPeriod', period: '24h' })
</script>
</body>
</html>`
}

export function showQuotaPanel(provider: DataProvider) {
    const data = provider.getData()
    const panel = vscode.window.createWebviewPanel(
        'claudeMonitorQuota',
        'Token 用量',
        { viewColumn: vscode.ViewColumn.Active, preserveFocus: true },
        { enableScripts: true }
    )
    panel.webview.html = getHtml(data)

    panel.webview.onDidReceiveMessage(async (msg: { command: string; period: '24h' | 'today' | '7d' | '30d' }) => {
        if (msg.command === 'loadPeriod') {
            try {
                const usage = await provider.getBucketedUsage(msg.period)
                panel.webview.postMessage({
                    command: 'chartData',
                    buckets: usage.buckets,
                    period: msg.period,
                })
            } catch (e) {
                panel.webview.postMessage({
                    command: 'chartData',
                    buckets: [],
                    period: msg.period,
                })
            }
        }
    })
}
