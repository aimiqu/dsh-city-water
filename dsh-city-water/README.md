# dsh-city-water · 城市水智管

DeepSeek Harness（DSH）的「城市水智管 · 水资源管理 Agent」工作台插件。

- **宿主半**（`lib/index.js` + `lib/chat.js`）：水务数据 API（演示数据单一事实源）、
  **面板内流式对话通道**（`/api/dsh-city-water/chat`，SSE）、3 个只读演示工具
  （`water_overview` / `water_risk` / `water_report_draft`）、
  **city-water 水资源管理技能同步**（→ `~/.dsh/skills/city-water/`）、系统提示节（水务上下文 + 审批红线）。
- **浏览器半**（`lib/client.js`）：GUI 侧边栏「城市水智管」入口 + 会话区工作台面板 + 面板开合控制。
- **工作台页面**（`workbench/`）：综合研判 / 水情监测 / 供需调度 / 风险预警 / 河湖管理 / 报告中心 / 知识库
  + 系统侧栏（数据源 · 模型 · 插件 · 日志），界面资产源自 city-water-agent-source，全量保留。
- **技能**（`skills/city-water/SKILL.md`）：水资源管理技能 —— 研判 SOP、指标阈值、调度框架、
  报告模板、安全红线，单一事实源、双通道挂载。

## 对话（面板内直连）

工作台综合研判对话区直接对话，走宿主 `/chat` SSE 流式通道：

| 模式 | 触发条件 | 行为 |
| --- | --- | --- |
| live | 配置了 `DEEPSEEK_API_KEY` | 真实模型正常对话（通用问题照常回答）+ 水务场景按 city-water 技能执行，带 3 个工具的函数调用循环，流式输出 |
| demo | 无密钥 | 关键词研判 + 通用问候（基于演示数据），模拟流式，开箱可用 |

对话中工具调用会渲染为任务步（汇集态势数据 / 查询风险预警 / 起草水务报告），回答带模式徽标。
DSH 原生主会话照常可用：任意会话可直接调用三个只读工具，或用 `/city-water` 显式挂载技能。

## 安装

```bash
dsh plugin --profile web add /path/to/dsh-city-water
dsh web    # 重启后，侧边栏出现「城市水智管」
```

详细步骤、验证方法与常见问题见仓库根目录 `INSTALL.md`。

## 配置 DeepSeek 密钥（可选，启用 live 模式）

```bash
export DEEPSEEK_API_KEY=sk-...
export DEEPSEEK_BASE_URL=https://api.deepseek.com   # 可选
export DEEPSEEK_MODEL=deepseek-chat                  # 可选
dsh web
```

也可在 profile 的 `cordis.patch.yml` 中给插件行加 `config: { apiKey, baseUrl, model }`。

## 安全

- 全部路由 loopback-only（仅放行本机浏览器，同 dsh-law 护栏）。
- v1 工具与 API 只读；生产控制（SCADA / 泵站 / 闸门）只生成方案、必须人工审批。
- 全部数据标注 `source=demo`，界面显示「演示态势数据」徽标；密钥只存在于宿主进程。

## 扩展点

- 真实数据源：替换 `lib/water-data.js`（或新增只读数据工具），API 契约不变。
- 技能迭代：直接改 `skills/city-water/SKILL.md`，重启后同步到原生会话、/chat 自动挂载新版。
- 更多工具：在 `lib/index.js`（DSH 工具）与 `lib/chat.js`（/chat 工具循环）成对扩展。
- 「城市水智管模式」会话预设：官方 preset roots 下的 `agent.cordis.yml`（路线图见 DESIGN.md）。
