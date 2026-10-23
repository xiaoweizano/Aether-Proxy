# Design: M1 — Windows 垂直切片

## Context

这是一个全新仓库，目前只有设计文档（`docs/design/2026-10-23-aether-proxy.md`，Revision 6）与项目约束（`CLAUDE.md`），没有任何代码。M1 要在 Windows 上交付一个能日常自用的代理客户端：导入配置、切换节点、开启系统代理、观察连接路由。

已锁定的上游决策（不在此重复论证）：代理内核复用 mihomo v1.19.32；桌面栈 Electron 45 + React 19 + TypeScript；三端渲染一致；v1 只做 Windows、只做系统代理；设计方向为 Linear / Raycast 式，深色优先、高密度、键盘可达。

已核实的 API 事实（来自 mihomo 源码 `3f27ef3`）：`/connections` 无延迟/成败字段；`chains[0]` 是实际出站；`/connections?interval=ms` 的 WS 推送完整快照；拨号失败只记 WARN 日志；无规则预演接口；`find-process-mode` 默认 `strict`。

## Goals / Non-Goals

**Goals:**

- 一条完整链路可跑通：导入配置 → 合并校验 → 启动内核 → 切节点 → 开系统代理 → 上网。
- 系统代理的任何异常路径（崩溃、强杀、关机、重启）都不会把用户留在断网状态。
- 卡片仪表盘按「UI 规范（M1）」落地，首屏完整性、键盘、tokens 三条验收可测。
- 主进程与平台相关能力解耦，后续可原样搬进独立守护进程。

**Non-Goals:**

- TUN、域名预演 HUD、订阅定时刷新、规则编辑器。
- macOS / Linux / Android 的系统代理实现。
- 自动更新、代码签名、公证。
- 多语言（M1 只发中文，但字符串外置）。

## Decisions

### D1 · 进程与模块边界

主进程持有全部特权能力：内核生命周期、配置读写、系统代理、IPC 服务。渲染进程只发命令、收视图模型，**不持有 controller secret，也不直接访问 mihomo**。

```
renderer (React)  ──IPC──▶  main
                             ├─ core-link      mihomo REST/WS 客户端（唯一持有 secret）
                             ├─ core-supervisor 进程生命周期、端口、重启
                             ├─ config         三层文件、合并、校验、回滚
                             ├─ platform-proxy PlatformProxy + 所有权快照
                             └─ native         napi-rs：HKCU + WinINet
```

理由：secret 与配置里含凭据，渲染进程是潜在注入面。备选方案（渲染进程直连 `127.0.0.1`）被否决，因为需要把 secret 下发到渲染进程。

### D2 · 内核启动契约

`mihomo -d <profiles/<id>> -f <profiles/<id>/runtime.yaml>`。地理库复制或链接到该 home。`mihomo -t` 使用同一 `-d`。端口用 `net.createServer({port:0})` 取空闲端口后注入 `mixed-port` 与 `external-controller`，secret 每次启动随机生成。

备选：固定 7890/9090。被否决——与其它客户端冲突是最常见的支持问题。

### D3 · 配置合并采用逐键策略

每个顶层键明确策略（prepend/append、按 name 合并、deep-merge、注入覆盖、透传）。合并后先跑 `mihomo -t`，再做引用完整性检查（策略组引用的节点、`use` 引用的 provider 是否存在）。

备选：整份替换用户配置。被否决——会破坏订阅里的 `dns` / `sniffer` / provider 结构。

### D4 · 系统代理由 napi-rs 插件实现

Rust 插件直接写 `HKCU\...\Internet Settings` 的 `ProxyEnable` / `ProxyServer` / `ProxyOverride`，处理 `AutoConfigURL` / `AutoDetect`，并调用 `InternetSetOptionW` 广播。无需管理员权限。

备选：PowerShell / `reg.exe`。被否决——无法可靠广播变更，接受新设置的时间不确定。

### D5 · 代理所有权与恢复

应用代理前，把完整原状态（含 PAC 字段）+ `owner` 标记 + pid + 时间戳写入 `proxy-state.json`。正常退出还原并删除；启动时若发现残留则还原；若当前状态已被他人修改则只提示不覆盖。关机/注销监听 `powerMonitor` 尽力还原。

理由：这是本类产品最危险的事故面——代理指向死端口等于断网。

### D6 · 连接采集用 WS 快照 + 环形缓冲

订阅 `/connections?interval=500`，每次收到完整快照后与上一帧比对，把关闭的连接标记为「已结束」并保留 60 秒，总条目设上限。链路显示时把 `chains` 反转。

备选：1s REST 轮询。被否决（漏采更严重、且需要自建定时器）。备选：解析 `/logs` 作为事件源。推迟——日志 payload 无契约。

### D7 · 失败可见性只做全局计数

订阅 `/logs` 并统计 WARN 行中的拨号失败，在状态栏显示近 5 分钟计数，点击打开日志面板。不把失败逐条并入连接列表。

理由：双源时间线合并的复杂度不该进 M1，且日志格式可能随内核升级变化。

### D8 · 界面结构：侧栏 + 卡片仪表盘

232px 侧栏（仪表盘 / 节点 / 连接 / 设置 / 日志）+ 卡片仪表盘：当前节点、内核状态、三张速率卡、流量折线。连接列表独立成「连接」页。顶栏常驻「规则 / 全局 / 直连」模式切换。

理由：作者提供 Aircan 参考并明确选择全面替换主视图；详见 `docs/design/2026-10-23-ui-pivot-dashboard.md`。

被否决：把 X-Ray 密集网格作为主视图（原方案，mockup 已归档至 `docs/design/mockups/archive/htop-grid/`）。

### D9 · 开机自启属于 M1

系统代理是持久设置，重启后若应用未启动，所有遵守系统代理的程序都会失联。自启在此是安全网而非便利功能。

## Risks / Trade-offs

- **配置合并静默出错** → 逐键策略 + `mihomo -t` + 引用完整性检查 + 一份带 provider 的真实订阅作为固定回归样本。
- **崩溃/关机残留代理** → 快照 + 启动检测 + `powerMonitor` 清理 + `taskkill /F` 自动化测试。
- **WS 快照在大连接量下开销** → 渲染侧虚拟列表；环形缓冲上限；采样 500ms 而非更低。
- **napi-rs 增加构建复杂度** → 固定工具链版本，CI 只构建 Windows x64。
- **未签名安装包触发 SmartScreen** → 已知并接受，README 说明；不影响 M1（内部里程碑不发布）。
- **Electron 安全基线遗漏** → 脚手架第一天即设置 `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`、CSP、禁止导航。

## Migration Plan

不适用（全新项目，无存量数据）。首次运行的配置目录为空时进入「无配置」空状态。

## Open Questions

- `find-process-mode: always` 在高连接速率下的 CPU 开销未实测；M1 期间需要一次基准测量，若过高则退化为 `strict` 并在 UI 上标注「进程列可能为空」。
- 环形缓冲的条目上限取多少（建议先取 2000 条，按内存实测调整）。
