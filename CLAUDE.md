# Aether-Proxy

一个以设计为差异点的跨平台代理客户端。桌面端（Windows / macOS / Linux）用 Electron + React，Android 用 Kotlin + Jetpack Compose，代理内核复用 mihomo，通过其 Clash 兼容 REST API 驱动。

目标：开源 + 自用。差异点是信息架构与桌面手感，不是功能数量。

## 设计产出存放位置（硬约束）

**所有设计产出必须放在本仓库内，不得只存在于 `~/.gstack/` 或其他仓库外的目录。**

- 设计文档：`docs/design/YYYY-MM-DD-<slug>.md`
- 每次设计会话一个新文件；修订关系用文档头部的 `Supersedes:` 字段串联，不要覆盖旧文件。
- 设计文档由 `/office-hours`、`/plan-ceo-review`、`/plan-design-review` 等技能生成时，**生成动作完成前必须把成品复制到 `docs/design/`**，并在结果里告诉用户仓库内路径。
- 如果某个 gstack 技能默认写到 `~/.gstack/projects/<slug>/`，那只是镜像：仓库内副本是唯一的事实来源（source of truth），镜像用于技能自动发现。两者不一致时，以仓库内版本为准，并把镜像同步过去。
- 同理适用于：线框图、设计稿导出、tokens 文件、架构图、评审报告。它们的最终位置都在本仓库（建议 `docs/design/`、`docs/diagrams/`、`tokens/`）。
- 提交信息不要用 `docs: ...` 之外的模糊前缀；设计相关提交应能让人从 git log 看出改了哪次设计。

## 已确认的技术决策

这些是经过讨论锁定的决定。**不要在没有新证据的情况下重新讨论，更不要擅自推翻。**需要推翻时，先在 `docs/design/` 新增一份文档说明理由和 `Supersedes:` 关系。

| 决策 | 结论 |
|---|---|
| 代理内核 | 不自研，用 mihomo（桌面 sidecar；Android 用 gomobile AAR，不可用子进程方案） |
| 桌面栈 | Electron + React + TypeScript + Vite（`electron-vite`） |
| 移动栈 | Kotlin + Jetpack Compose |
| 三端一致性 | Windows / macOS / Linux 渲染必须一致 → 排除所有借用系统 WebView 的方案（Tauri / Wails / Neutralino） |
| 设计系统 | 两套壳共用 `tokens.json`（→ CSS 变量 + Compose Theme），页面布局各自实现 |
| iOS | 不做（开源 Clash 系客户端进不了 App Store） |
| 第一版范围 | 系统代理 only，无 TUN；无自动更新；无 macOS 公证 |
| 审美方向 | 深色卡片式仪表盘，参考 Aircan 的 Windows 适配：近黑分层、蓝色单强调、绿色成功态、14px 圆角 |
| 主视图 | 卡片仪表盘（当前节点 / 内核 / 三张速率卡 / 流量折线）；侧栏：仪表盘 / 节点 / 连接 / 设置 / 日志 |
| 模式切换 | 规则 / 全局 / 直连，顶栏常驻分段控件（真实能力，不是装饰） |
| 核心差异功能 | 路由透视（X-Ray）位于「连接」页：进程 → 域名 → 命中规则 → 策略组 → 节点 → 流量/时长 |
| 连接数据源 | `GET /connections?interval=500` 的 WS 快照 + 60 秒环形缓冲；`chains[0]` 是实际出站，界面需反转显示 |

唯一的未决问题：**TUN 是否进 v1**，由一日实测（`Get-NetTCPConnection` 对比 mihomo `/connections`）决定。

## 工程约定

- mihomo controller 只绑定 `127.0.0.1`，带随机 secret；渲染进程不直连，一律经主进程 IPC 转发。
- 窗口隐藏即销毁（`win.destroy()`），托盘常驻内存目标 ≤280MB、闸门 300MB（实测基线 268MB；推翻理由见 `docs/design/2026-10-29-memory-budget.md`）。
- 平台相关能力（系统代理、TUN、提权）必须藏在 `PlatformProxy` 接口后，v1 只实现 Windows。
- 退出路径必须保证：终止 mihomo 子进程、还原系统代理设置。这是硬要求。
- 主进程内的「内核管理」和「平台代理」两个模块保持低耦合，将来可原样搬到独立守护进程（Mullvad 式架构）。

## 参考文档

- `docs/design/2026-10-23-aether-proxy.md` — 产品与技术设计，含完整决策日志与取舍依据。
- `docs/design/2026-10-23-ui-pivot-dashboard.md` — 主视图从密集网格改为卡片仪表盘的推翻说明（Supersedes 原 UI 规范一节）。
- `docs/design/2026-10-29-memory-budget.md` — 托盘内存预算从 <150MB 改为 ≤280MB 的推翻说明（Supersedes 原测量协议的内存一项）。
- `PRODUCT.md` — 产品事实：用户、用途、定位、约束、原则。
- `DESIGN.md` — 视觉系统规范（从选定的视觉稿反推）：色板、字阶、布局、组件、规则。`.impeccable/design.json` 是它的结构化 sidecar。
- `docs/design/mockups/variants/a-cards.html` — **选定的** M1 仪表盘视觉稿（1280×800，自包含）。
- `docs/design/mockups/variants/index.html` — 四版方案的对比页；B/C/D 未采用，仅作记录。
- `docs/design/mockups/archive/htop-grid/` — 被替换的旧网格方案，仅作历史证据。
- `.impeccable/rolls/2026-10-23-direction.md` — 旧网格方案的掷骰记录。
- `openspec/changes/add-m1-windows-vertical-slice/` — M1 的提案、规格与任务（UI 相关部分需按新主视图更新）。
