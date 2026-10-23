# Proposal: M1 — Windows 垂直切片

## Why

现有代理客户端（以 FlClash 为代表）在四个方面同时让人别扭：桌面端像手机 App、信息架构混乱、视觉没有气质、分流配置难用。目标是做一个**以设计为差异点**的开源代理客户端，先在自己日常使用中跑通，而不是再做一个功能表更长的客户端。

M1 是第一个可日常自用的内部里程碑：它在 Windows 上跑通「导入配置 → 切换节点 → 开启系统代理 → 上网」这一条完整链路，并把差异点——**路由透视（X-Ray）**——做成真正可用的主界面。M1 不对外分发，v1 是随后的 M1.5。

依据：`docs/design/2026-10-23-aether-proxy.md`（Revision 6，已 APPROVED）。

## What Changes

- 新建一个 Electron + React + TypeScript 的桌面应用骨架（`electron-vite`）。
- 以 sidecar 方式管理 mihomo v1.19.32：动态端口、随机 secret、健康检查、崩溃重启策略、孤儿进程识别。
- 配置管线：本地 Clash YAML 或一次性 URL 拉取 → 三层文件（upstream / overrides / runtime）→ **逐键合并策略** → `mihomo -t` 校验 → 引用完整性检查 → 热重载与回滚。
- Windows 系统代理：通过 Rust + napi-rs 写 HKCU 与 WinINet，包含 PAC/WPAD 处理、原状态快照、异常退出恢复、关机/注销清理。
- **卡片仪表盘主视图**：40px 标题栏 + 232px 侧栏（仪表盘 / 节点 / 连接 / 设置 / 日志）；四块卡片（当前节点、内核状态、三张速率卡、流量折线）；顶栏常驻「规则 / 全局 / 直连」模式切换。
- **连接页**：`/connections?interval=500` 的 WS 快照 + 60 秒环形缓冲；六列连接列表、行内详情、搜索与「只看活跃」。
- 命令面板、三套空状态、原生托盘菜单。
- **开机自启进入 M1**：系统代理是持久设置，重启后若无人监听会切断用户网络，自启是安全网。
- 设计约束落地：深色卡片式（14px 圆角 / 13px 主字号）、tokens 零裸值（lint 强制）、键盘六任务全覆盖。

明确不做（属于后续里程碑）：TUN、域名预演 HUD、订阅定时刷新、规则编辑器、macOS/Linux 系统代理、Android、自动更新、macOS 公证、Windows 代码签名。

## Capabilities

### New Capabilities

- `proxy-core-lifecycle`: mihomo sidecar 的启动、停止、健康检查、动态端口与 secret 分配、崩溃重启与退避、孤儿内核识别与清理。
- `config-pipeline`: 配置导入（本地 YAML / 一次性 URL）、三层文件模型、逐键合并策略、校验、引用完整性检查、热重载与回滚。
- `system-proxy`: Windows 系统代理的启用/禁用、PAC/WPAD 处理、原状态快照与还原、异常退出与关机恢复、平台接口抽象。
- `connection-inspector`: 连接快照的采集与规范化（`chains` 反转）、60 秒环形缓冲、行模型、排序与筛选、详情字段。
- `desktop-shell`: 侧栏与 Windows 外壳、卡片仪表盘、模式切换、键盘可达、命令面板、空状态、托盘、令牌约束。
- `app-lifecycle`: 开机自启、启动时残留检测、退出清理、单实例行为（M1 不做锁，仅定义退出路径）。

### Modified Capabilities

无（全新项目，`openspec/specs/` 为空）。

## Impact

- **新增代码**：`src/main`（主进程、内核管理、配置管线、代理所有权）、`src/renderer`（React 界面）、`src/native`（Rust + napi-rs 系统代理插件）、`tokens/`（设计 tokens）。
- **新增依赖**：Electron 45、React 19、TypeScript 5、electron-vite、Zustand、TanStack Query、cmdk、Radix 原语、TanStack Virtual、napi-rs 工具链、Rust 工具链。
- **随包分发的二进制**：`mihomo.exe` v1.19.32（SHA-256 锁定）、`Country.mmdb`、`geosite.dat`；需要 `THIRD_PARTY_NOTICES.md` 承载 GPL-3.0 义务。
- **系统影响**：写入 `HKCU\...\Internet Settings`，无需管理员权限；会在用户网络设置中短暂改变代理状态，必须有可验证的还原路径。
- **不影响**：macOS / Linux / Android 的任何功能（M1 只做 Windows）。
