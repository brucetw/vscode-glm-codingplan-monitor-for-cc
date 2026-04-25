# GLM CodingPlan Monitor for CC

VSCode 扩展，在状态栏中实时监控 Claude Code 使用 GLM Coding Plan 时的 Token 用量、模型分布、Context 使用率、输出速度等信息。

## 功能

- **状态栏实时显示**：24h Token 用量、当前模型、Context 使用率、输出速度、API 调用次数、配额进度
- **分时段柱状图**：支持 24小时 / 当天 / 近7天 / 近30天 四种视图，按模型分色堆叠
- **Tooltip 详情**：鼠标悬停柱子可查看该时段各模型的精确用量（带颜色标记）
- **配额监控**：5小时滚动窗口、周限额、MCP 限额的百分比及重置时间
- **用量统计与官方一致**：当天从0点起，近7天/近30天按自然日计算

## 安装

```bash
# 下载 vsix 文件后安装
code --install-extension glm-codingplan-monitor-for-cc-0.2.0.vsix
```

或手动编译：

```bash
git clone https://github.com/brucetw/glm-codingplan-monitor-for-cc.git
cd glm-codingplan-monitor-for-cc
npm install
npx vsce package
code --install-extension glm-codingplan-monitor-for-cc-0.2.0.vsix
```

## 前置条件

本扩展需要读取以下配置（通常由 GLM Coding Plan 的 Claude Code 接入方式自动配置）：

- `~/.claude/settings.json` 中的 `ANTHROPIC_BASE_URL` 和 `ANTHROPIC_AUTH_TOKEN`
- 或对应的环境变量

## 使用方式

- 扩展在 VSCode 启动后自动激活，状态栏显示实时监控数据
- 点击状态栏的 Token 用量项，打开分时段柱状图面板
- 点击面板上方的标签页切换不同时间视图

## 支持的模型颜色

| 模型 | 颜色 |
|------|------|
| GLM-5.1 | 🔵 蓝色 |
| GLM-5-Turbo | 🟢 绿色 |
| GLM-5V-Turbo | 🟡 橙色 |
| GLM-5 | 🟣 紫色 |
| GLM-4.7 | 🟠 橙色 |
| GLM-4 | 🔴 红色 |

## 可配置项

通过 VSCode 设置（`Ctrl+,`）搜索 `glmMonitor` 可配置：

| 设置项 | 默认值 | 说明 |
|--------|--------|------|
| `glmMonitor.refreshInterval` | 1000 | 数据刷新间隔（毫秒） |
| `glmMonitor.showTokenUsage` | true | 显示 24h Token 用量 |
| `glmMonitor.showModel` | true | 显示模型名称 |
| `glmMonitor.showContext` | true | 显示 Context 使用率 |
| `glmMonitor.showSpeed` | true | 显示输出速度 |
| `glmMonitor.showPrompts` | true | 显示 API 调用次数 |
| `glmMonitor.showQuota` | true | 显示配额信息 |

## 许可

MIT
