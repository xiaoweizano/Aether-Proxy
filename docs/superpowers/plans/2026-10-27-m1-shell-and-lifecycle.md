# M1 外壳与生命周期 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 M1 从「能跑的窗口」补成「桌面常驻代理」：原生托盘、窗口关闭即销毁、真实窗口按钮、开机自启、孤儿内核识别、崩溃退避重启、关机还原，以及对应的验收脚本。

**Architecture:** 全部在主进程侧。托盘、窗口生命周期、自启、`powerMonitor` 都集中在 `src/main/index.ts` 与新增的 `src/main/shell/`；孤儿识别接线复用已实现的 `core/orphan.ts`，退避重启复用已实现的 `core/restarter.ts` + `core/backoff.ts`（这两个模块目前没有任何调用方）。

**Tech Stack:** Electron 45（`Tray`、`Menu`、`nativeImage`、`powerMonitor`、`app.setLoginItemSettings`）/ TypeScript 5 strict / Vitest / `taskkill`。

**Spec:** `openspec/changes/add-m1-windows-vertical-slice/specs/app-lifecycle/spec.md`（主）、`desktop-shell/spec.md`（托盘与键盘）、`proxy-core-lifecycle/spec.md`（孤儿识别、退避重启）、`system-proxy/spec.md`。

## 现状（本计划开始前已实现）

- 内核监督、配置管线、系统代理所有权、退出清理（含在途重启取消与首次启动取消）。
- 仪表盘、四套状态、页面路由、连接页、节点页（计划 3 的 Task 7）、命令面板（计划 3 的 Task 8）。
- **已实现但零调用方**：`src/main/core/orphan.ts`（`classifyOrphan`）、`src/main/core/restarter.ts`（`CoreRestarter`）、`src/main/core/backoff.ts`（`nextRestart`）。
- **完全缺失**：托盘、窗口关闭即销毁、真实窗口按钮（当前保留原生边框且已去掉假按钮）、开机自启、`powerMonitor`、单实例提示、内存测量、8 小时长稳。

## Global Constraints

- 只支持 Windows x64；不得触发 UAC。
- controller 只绑定 `127.0.0.1`；secret 只在主进程内，不得经 IPC、不得写日志、不得进渲染层。
- 退出路径必须保证：还原系统代理 → 终止内核 → 确认不存在 → 退出。顺序不得颠倒。
- 托盘不刷新速率（避免每秒重建菜单）。
- 所有颜色/字号/间距/圆角来自 `tokens.css`；文案集中在 `copy.ts`（本计划大部分是主进程，GUI 文案在托盘菜单里，直接用中文常量并集中在 `src/main/shell/copy.ts`）。
- 每个任务结束前 `npm test` 与 `npx tsc --noEmit` 必须为绿。

## Review Focus

1. **退出顺序**——任何新路径（托盘退出、关机、注销、崩溃清理）都不得颠倒「先还原代理、后终止内核」，也不得绕过确认。
2. **不留下孤儿**——托盘退出、`session-end`、`powerMonitor` 三条路径都必须真正终止内核。
3. **自启的诚实**——关闭自启时的断网警告必须真的出现；自启项失败时不得假装成功。
4. **托盘不撒谎**——托盘只显示主进程已知的事实，不得显示它没有的速率或健康度。
5. **重复启动**——M1 明确**不做**单实例锁，只能提示，不能阻止。

---

## 文件结构

```
src/main/shell/tray.ts               托盘图标与菜单构建
src/main/shell/tray.test.ts
src/main/shell/autostart.ts          开机自启读写
src/main/shell/autostart.test.ts
src/main/shell/window.ts             窗口创建/销毁与真实窗口按钮
src/main/shell/power.ts              powerMonitor / session-end 接线
src/main/shell/copy.ts               主进程侧中文文案（托盘 / 对话框）
src/main/bootstrap.ts                +孤儿识别接线、+退避重启接线
src/renderer/components/TitleBar.tsx 窗控按钮接入（frame: false）
src/preload/index.ts                 +windowControls 通道
scripts/measure-memory.mjs           内存测量脚本
scripts/soak.mjs                     长稳采样脚本
```

---

### Task 1: 孤儿内核识别接线

**Files:**
- Modify: `src/main/bootstrap.ts`, `src/main/bootstrap.test.ts`
- Read (do not rewrite): `src/main/core/orphan.ts`, `src/main/core/state.ts`

`core/orphan.ts` 的 `classifyOrphan({ port, oldSecret, fetchFn })` 已实现并测试过，返回 `'ours' | 'foreign' | 'none'`。`core/state.ts` 的 `readCoreState` 已实现但没人调用。

- [ ] **Step 1: 失败测试**

```ts
it('上次留下的是我们自己的内核：识别出来并终止它，再启动新的', async () => {
  // 1) 先用 harness 启动一次，拿到 core-state.json（含 pid/port/secret）
  // 2) 不调用 stopAll，直接丢弃 context（模拟被 taskkill /F）
  // 3) 用同一个 userDataDir 再 bootstrap 一次，注入一个假的 fetchFn：
  //    - 旧 port 的 /version 返回 200  → 'ours'
  // 4) 断言：旧 pid 被终止（注入 killFn 记录调用）、日志/状态里带 restored 或提示
})

it('旧端口属于其它程序：不干扰它，另选端口启动', async () => {
  // 旧 port 的 /version 返回 401 → 'foreign'
  // 断言：没有任何 kill，新的 mixed/controller 端口与旧的不同
})

it('没有 core-state.json：不探测，正常启动', async () => {})
```

- [ ] **Step 2: 实现**

启动流程中、`startCore()` 之前插入：

```
const stale = await readCoreState(coreStateFile)
if (stale !== null) {
  const verdict = await classifyOrphan({ port: stale.port, oldSecret: stale.secret, fetchFn })
  if (verdict === 'ours') → 终止 stale.pid（taskkill /F /PID，仅在确认 pid 仍存活且进程名是 mihomo 时）
  if (verdict === 'foreign' || verdict === 'none') → 不动它，另选端口（现有 allocatePort 已保证）
  然后清掉 core-state.json
}
```

- 终止前必须校验 **pid 身份**（`core-state.json` 里已有 pid；用 `process.kill(pid, 0)` 判存活，并校验可执行文件名，避免 pid 复用误杀）。
- 终止与校验失败都不得阻断启动：记一条 warning，继续。
- `restore` 状态里新增语义值时必须同步 `AppStatusView.restore` 的联合类型与渲染层文案（或明确不加，在报告里说明）。
- kill 通过注入的 `killFn` 以便测试（与既有 `spawnFn` / `validateFn` 注入模式一致）。

- [ ] **Step 3: 测试绿 + tsc**
- [ ] **Step 4: 提交** — `feat(main): 启动时识别并清理上次遗留的内核`

---

### Task 2: 崩溃退避重启接线

**Files:**
- Modify: `src/main/bootstrap.ts`, `src/main/bootstrap.test.ts`
- Read: `src/main/core/restarter.ts`, `src/main/core/backoff.ts`

`nextRestart`（1s / 2s / 4s，10 分钟 3 次）与 `CoreRestarter` 已实现并测试过，零调用方。`handleCoreExit`（计划 2 的 I2 修复）目前只把状态转成 `core-error`。

- [ ] **Step 1: 失败测试**
  - 内核意外退出 → 按 1s 调度重启（注入 `schedule`，断言延迟与调用次数）。
  - 10 分钟内第 4 次退出 → 不再调度，保持 `core-error`，并提供手动重启入口。
  - **用户主动退出（`stopAll`）后立即退出**：`CoreRestarter.cancel()` 被调用，不得再拉起内核。
  - 重启成功后 `CoreRestarter.attempts` 是否清空：按规格，10 分钟窗口内计数，成功不清零（见报告说明）。

- [ ] **Step 2: 实现**

在 `handleCoreExit` 里：

```
ctx.startupStatus = 'reconnecting'          // 新增状态，见下
restarter.notifyExit()                      // 返回 {scheduled, delayMs}
```

- `AppStatusView.status` 增加 `'reconnecting'`，渲染层显示「内核重连中」而不是「内核异常」，且**不得**在此期间显示速率。
- `startAll`（重启）成功后把状态改回 `ready`；失败则按退避继续，直到 `onGiveUp` → `core-error`。
- `stopAll` 第一件事就是 `restarter.cancel()`。

- [ ] **Step 3: 测试绿 + tsc + `npm run shot` 仍通过**
- [ ] **Step 4: 提交** — `feat(main): 内核崩溃后按退避自动重启`

---

### Task 3: 托盘

**Files:**
- Create: `src/main/shell/tray.ts`, `src/main/shell/tray.test.ts`, `src/main/shell/copy.ts`
- Modify: `src/main/index.ts`

菜单结构（规格 `desktop-shell` / 设计文档「托盘菜单（M1）」）：

```
当前节点 · 模式          （只读，disabled）
─────────────────────
系统代理            ✓ / （无勾）
切换节点            ▸  策略组 → 节点
打开主窗口
退出
```

- 托盘图标来自 `resources/tray.png`（本次需要新增一个 16×16 与 32×32 的资源；用 `nativeImage` 从已有 `docs/design` 资产缩放，或生成一个简单的单色图标并说明来源）。
- **菜单只在状态变化时重建**：节点变了、模式变了、代理开关变了。速率每秒变化不得触发重建。
- 「切换节点」子菜单来自 `toProxyGroups` 的视图模型；`GLOBAL` 组不列（与仪表盘一致）。
- 菜单项调用与渲染层同一套 IPC 处理逻辑（直接调 `ctx`，不经 IPC 往返）。
- 托盘点击左键 → 打开/聚焦主窗口。

- [ ] **Step 1: 失败测试** — 给定一个 `AppContext` 假体，断言菜单标签与勾选态；断言速率变化不重建（用构建次数计数）；断言 `GLOBAL` 不在子菜单里。
- [ ] **Step 2: 实现**
- [ ] **Step 3: 测试绿 + tsc**
- [ ] **Step 4: 提交** — `feat(main): 原生托盘菜单`

---

### Task 4: 窗口关闭即销毁与真实窗口按钮

**Files:**
- Create: `src/main/shell/window.ts`
- Modify: `src/main/index.ts`, `src/renderer/components/TitleBar.tsx`, `src/preload/index.ts`, `src/shared/ipc.ts`, `src/renderer/copy.ts`, `src/renderer/styles/app.css`

规格：关闭主窗口 → `win.destroy()`，托盘保留，代理与内核继续运行；重新打开时重建窗口并恢复状态。

- `BrowserWindow` 改为 `frame: false`，标题栏由渲染层绘制。
- 窗控按钮通过 `windowControls:minimize|maximize|close` 通道；**close 是销毁而不是退出应用**。
- `close` 事件里 `preventDefault()` + `destroy()`，并停止 stats 推送（既有行为）但**不停采集器**（账本已有裁决）。
- 点击托盘「打开主窗口」时若窗口已销毁则重建，并把首屏数据（状态、连接快照、流量历史）通过既有的 `*Get` 通道补齐——渲染层的 `useStats` / `useConnections` 已实现首屏补拉，验证这一点即可。
- 双显示器/还原位置：窗口上次的位置与尺寸存进 `settings.json`（`windowBounds`），重建时恢复；越界（例如显示器被拔掉）时回落到居中默认尺寸。

- [ ] **Step 1: 失败测试** — 关闭不退出应用；重建后状态仍在；`windowBounds` 往返；越界边界回落到默认。
- [ ] **Step 2: 实现**
- [ ] **Step 3: 测试绿 + tsc + `npm run shot` 仍通过**（`--shot` 走 `frame:false` 后截图仍应可用）
- [ ] **Step 4: 提交** — `feat(main): 窗口关闭即销毁与真实窗口按钮`

---

### Task 5: 开机自启

**Files:**
- Create: `src/main/shell/autostart.ts`, `src/main/shell/autostart.test.ts`
- Modify: `src/main/index.ts`, `src/renderer/pages/SettingsPage.tsx`（新建，替换 Placeholder）, `src/shared/ipc.ts`, `src/preload/index.ts`

规格：默认启用；用户关闭时**必须**显示「重启后若系统代理仍处于开启状态，需要手动启动 Aether」的警告。

- `app.setLoginItemSettings({ openAtLogin, path })`；开发态（`!app.isPackaged`）不注册，但设置项仍可读写并如实显示「仅打包版生效」。
- `settings.json` 增加 `autostart: boolean`（默认 `true`）。
- 设置页至少包含：开机自启开关 + 关闭时的警告文案。这一页是本计划唯一的新 UI 页。
- 读取真实状态：`app.getLoginItemSettings().openAtLogin`，与持久化值不一致时以系统实际为准并提示。

- [ ] **Step 1: 失败测试** — 关闭开关触发警告文案；持久化往返；`isPackaged: false` 时不调用 `setLoginItemSettings` 但仍显示状态。
- [ ] **Step 2: 实现**
- [ ] **Step 3: 测试绿 + tsc**
- [ ] **Step 4: 提交** — `feat(main): 开机自启设置`

---

### Task 6: 关机与会话结束还原

**Files:**
- Create: `src/main/shell/power.ts`, `src/main/shell/power.test.ts`
- Modify: `src/main/index.ts`

规格 4.8：接入 `powerMonitor` 的关机/注销事件，尽力还原。

- `powerMonitor.on('shutdown')` 与 `app.on('session-end')`（Windows 两者都要）→ 同步或短超时地执行 `stopAll()`。
- Electron 在关机事件里不会等太久：必须给 `stopAll` 一个上限（例如 2.5s），超时也要退出，并在日志里记「关机还原超时」。
- 这两个事件里**不得**弹对话框（关机期间没有用户交互）。

- [ ] **Step 1: 失败测试** — 注入假的 `powerMonitor`，触发两个事件各一次 → `stopAll` 被调用且只调用一次；超时路径不抛错；不弹对话框。
- [ ] **Step 2: 实现**
- [ ] **Step 3: 测试绿 + tsc**
- [ ] **Step 4: 提交** — `feat(main): 关机与注销时还原代理并终止内核`

---

### Task 7: 重复启动提示与内存测量

**Files:**
- Create: `scripts/measure-memory.mjs`
- Modify: `src/main/index.ts`

规格 7.7：M1 **不做**单实例锁；检测到已有实例时 SHOULD 提示，不阻止第二个实例。

- 用 `app.requestSingleInstanceLock()` 只能拿到「有没有另一个实例」，但它本身就会阻止第二个实例——**规格明确不做单实例锁**，所以不能用它。
- 现有机制已经够用：`ProxyOwnership.restoreOnStartupIfStale()` 读 `proxy-state.json` 的 owner pid，用 `process.kill(pid, 0)` 判存活（`EPERM` 也按存活算），返回 `'in-use'`；渲染层已有 `copy.state.inUse`。**已验证**，本任务不需要新检测机制。
- 需要改的是**措辞与语义**：现在写的是「同一时间只能有一个 Aether 实例占用配置与系统代理。关闭另一个实例后再试。」——这暗示第二个实例被阻止了，与规格「M1 不做单实例锁，只提示」矛盾。改为如实说明：第二个实例可以继续运行，但不会接管系统代理与内核；同一用户下可能存在多个内核。
- `scripts/measure-memory.mjs`：用 PowerShell `Get-Process` 汇总 `Aether.exe` 全部进程 + `mihomo.exe` 的 Working Set，打印总量与分项，并在超过 150 MB 时退出 1。

- [ ] **Step 1: 失败测试** — 内存脚本的解析函数对给定 `Get-Process` 输出返回正确的总量（纯函数，可单测）。
- [ ] **Step 2: 实现**
- [ ] **Step 3: 跑一次真实测量并记录数字到报告**
- [ ] **Step 4: 提交** — `test(tooling): 内存测量脚本与重复启动提示`

---

### Task 8: 端到端验收脚本

**Files:**
- Create: `scripts/e2e.mjs`, `scripts/soak.mjs`

- `scripts/e2e.mjs`：导入配置 → 切节点 → 开系统代理 → 用 `curl -x` 访问一个受控 URL 验证出口 → 关代理 → 断言注册表复原。**必须用临时 userData**，不得碰真实配置；系统代理读写前后都要快照并在 `finally` 里还原。
- `scripts/soak.mjs`：预热 30 分钟，之后每 5 分钟采样一次内存，输出 CSV；末小时中位数超过首小时 110% 时退出 1。

- [ ] **Step 1: 实现（脚本本身不需要单测，但要用一次真实运行证明它工作）**
- [ ] **Step 2: 跑 `scripts/e2e.mjs` 一次，记录结果**
- [ ] **Step 3: 提交** — `test(tooling): 端到端与长稳验收脚本`

---

## 明确不在本计划内

- Android 端（独立技术栈，另开计划）。
- TUN 支持（v1 明确不做，一日实测仍未做）。
- 自动更新、macOS 公证、代码签名。
- 打包（`electron-builder` 配置）——需要单独一份计划，本计划只保证开发态与 `--shot` 可用。
