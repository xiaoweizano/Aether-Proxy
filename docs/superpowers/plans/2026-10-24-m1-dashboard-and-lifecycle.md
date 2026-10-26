# M1 接线与仪表盘 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把已实现的内核、配置、代理底座接进 Electron 应用，并交付第一版可运行界面：侧栏 + 卡片仪表盘（当前节点、内核、速率、流量图）+ 规则/全局/直连切换 + 三套状态。

**Architecture:** 主进程新增 `bootstrap`（路径与依赖装配）、`ipc`（白名单 handler）、`stats`（`/traffic` WS 采集与 60 点环形缓冲）。渲染层 React 19 + 纯 CSS tokens，从 `DESIGN.md` 取值，不引入组件库。IPC 只暴露结构化视图模型；secret 与配置原文永不出主进程。

**Tech Stack:** Electron 45 / React 19 / TypeScript 5 strict / electron-vite / Vitest + jsdom + @testing-library/react / koffi（已就位）。

**Spec:** `openspec/changes/add-m1-windows-vertical-slice/`（尤其 `specs/desktop-shell/spec.md`），视觉见 `DESIGN.md` 与 `docs/design/mockups/variants/a-cards.html`。

## Global Constraints

- 只支持 Windows x64；不得触发 UAC。
- controller 只绑定 `127.0.0.1`；`secret` 只在主进程内，**不得经 IPC、不得写日志、不得进渲染层**。
- 渲染进程安全基线：`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`、禁止新窗口与导航。
- 所有颜色、字号、间距、圆角来自 `tokens.css`；渲染层不得出现裸色值/裸 px 字号（由 `scripts/check-tokens.mjs` 强制）。
- 视觉基准是 `DESIGN.md`：`#0A0B0D` 地面、`#141619` 卡片、`#4A8CFF` 线蓝、`#2F6FE0` 填充蓝、`#34D399` 健康绿、13px 正文、14px 卡片圆角。
- 空状态不得阻断侧栏；内核错误必须显示可操作的两个动作。
- 所有面向用户的文案为简体中文，且集中在 `src/renderer/copy.ts`。
- 每个任务结束前 `npm test` 与 `npx tsc --noEmit` 必须为绿。

## Review Focus

1. **Secret 泄漏**——任何 IPC 返回值、日志、错误消息中出现 controller secret 或上游凭据即 Critical；Task 2 用「序列化后的白名单字段」断言。
2. **启动失败后的窗口状态**——无配置/配置错误/内核错误时界面必须说清原因且不假装在线；Task 6 用三套状态测试钉住。
3. **模式切换的失败回滚**——`PATCH /configs` 失败时选中态必须回到原模式；Task 4 用拒绝的 fake 断言。
4. **渲染层越权**——渲染层不得直接 `fetch` 到 controller；Task 2 的 preload 只暴露白名单方法。
5. **裸值漂移**——Task 3 的 token 检查脚本必须在 CI/测试中跑，否则三个月后视觉必然漂移。

---

## 文件结构

```
src/main/bootstrap.ts            路径解析与依赖装配（profile、geodata、config、core、proxy）
src/main/bootstrap.test.ts
src/main/ipc.ts                  IPC handler 注册，只返回视图模型
src/main/ipc.test.ts
src/main/stats.ts                /traffic WS 采集 + 60 点环形缓冲
src/main/stats.test.ts
src/main/index.ts                应用入口：bootstrap → 窗口 → IPC → 退出钩子
src/shared/ipc.ts                通道常量与视图模型类型
src/preload/index.ts             contextBridge 白名单 API
src/renderer/index.html
src/renderer/main.tsx
src/renderer/App.tsx
src/renderer/copy.ts             全部中文文案
src/renderer/styles/tokens.css   来自 DESIGN.md 的 token
src/renderer/styles/app.css      布局与组件样式
src/renderer/hooks/useStatus.ts
src/renderer/hooks/useStats.ts
src/renderer/components/TopBar.tsx
src/renderer/components/ModeSwitch.tsx
src/renderer/components/NodeCard.tsx
src/renderer/components/CoreCard.tsx
src/renderer/components/StatCards.tsx
src/renderer/components/TrafficChart.tsx
src/renderer/components/StatePanel.tsx
scripts/check-tokens.mjs
```

---

### Task 1: 主进程装配（bootstrap）

**Files:**
- Create: `src/main/bootstrap.ts`, `src/main/bootstrap.test.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- Produces:
```ts
export interface BootstrapOptions {
  userDataDir: string
  isPackaged: boolean
  resourcesPath: string
  repoRoot: string
  spawnFn?: typeof import('node:child_process').spawn
  fetchFn?: typeof fetch
}

export interface AppContext {
  profileDir: string | null
  supervisor: CoreSupervisor
  controller: SystemProxyController
  ownership: ProxyOwnership
  mode: Mode
  startupStatus: 'no-config' | 'ready' | 'config-error' | 'core-error' | 'in-use'
  restore: 'none' | 'restored' | 'conflict' | 'in-use'
  stopAll(): Promise<void>
}

export async function bootstrap(opts: BootstrapOptions): Promise<AppContext>
```
- 路径约定：profile 固定为 `<userDataDir>/profiles/default`；代理状态 `<userDataDir>/proxy-state.json`；内核状态 `<userDataDir>/core-state.json`。
- 无 `upstream.yaml` → 不启动内核、不改代理，`startupStatus: 'no-config'`。
- 有配置：`ensureGeodata(profileDir, <repoRoot>/vendor/geodata)` → 读 YAML → `mergeConfig` → `missingReferences` → `writeRuntime` → `validateConfig` → `core.start` → 记录 `core-state.json` → 若上次代理开则 `controller.enable`。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { bootstrap } from './bootstrap'

async function makeUserDir(withConfig: boolean) {
  const dir = await mkdtemp(path.join(tmpdir(), 'aether-boot-'))
  if (withConfig) {
    const p = path.join(dir, 'profiles', 'default')
    await mkdir(p, { recursive: true })
    await writeFile(path.join(p, 'upstream.yaml'), 'proxies: []\nproxy-groups:\n  - { name: Proxy, type: select, proxies: [DIRECT] }\nrules:\n  - MATCH,DIRECT\n')
  }
  return dir
}

describe('bootstrap', () => {
  it('无配置时返回 no-config 且不启动内核', async () => {
    const dir = await makeUserDir(false)
    const ctx = await bootstrap({ userDataDir: dir, isPackaged: false, resourcesPath: dir, repoRoot: process.cwd() })
    expect(ctx.startupStatus).toBe('no-config')
    expect(ctx.supervisor.status).toBe('stopped')
    await ctx.stopAll()
  })
})
```

- [ ] **Step 2: 运行并确认失败** — `npm test -- src/main/bootstrap.test.ts` → `Cannot find module './bootstrap'`

- [ ] **Step 3: 实现 bootstrap**

```ts
import path from 'node:path'
import { readFile, mkdir } from 'node:fs/promises'
import YAML from 'yaml'
import type { ChildProcess } from 'node:child_process'
import { allocatePort } from './core/ports'
import { newSecret } from './core/secret'
import { CoreSupervisor } from './core/supervisor'
import { resolveMihomoBinary } from './core/binary'
import { writeCoreState, clearCoreState } from './core/state'
import { mergeConfig } from './config/merge'
import { missingReferences } from './config/references'
import { writeRuntime } from './config/runtime'
import { validateConfig } from './config/validate'
import { ensureGeodata } from './config/geodata'
import { ProxyOwnership } from './proxy/ownership'
import { SystemProxyController } from './proxy/controller'
import { loadWindowsProxy } from './proxy/win32'
import { FakePlatformProxy } from './proxy/fake'
import type { Mode } from '../shared/types'

export interface BootstrapOptions { /* 如上 */ }
export interface AppContext { /* 如上 */ }

export async function bootstrap(opts: BootstrapOptions): Promise<AppContext> {
  const profileDir = path.join(opts.userDataDir, 'profiles', 'default')
  const proxyStateFile = path.join(opts.userDataDir, 'proxy-state.json')
  const coreStateFile = path.join(opts.userDataDir, 'core-state.json')
  const binary = resolveMihomoBinary({ isPackaged: opts.isPackaged, resourcesPath: opts.resourcesPath, repoRoot: opts.repoRoot })
  const pp = process.platform === 'win32' ? loadWindowsProxy() : new FakePlatformProxy({ enabled: false })
  const ownership = new ProxyOwnership(pp, proxyStateFile)
  const controller = new SystemProxyController(pp, ownership)

  let upstreamText: string | null = null
  try { upstreamText = await readFile(path.join(profileDir, 'upstream.yaml'), 'utf8') } catch { upstreamText = null }

  if (upstreamText === null) {
    const sup = new CoreSupervisor({ binary, homeDir: profileDir, configPath: path.join(profileDir, 'runtime.yaml'), controllerPort: 1, secret: 'unused' })
    return { profileDir: null, supervisor: sup, controller, ownership, mode: 'rule', startupStatus: 'no-config', restore: 'none', stopAll: async () => {} }
  }

  await mkdir(profileDir, { recursive: true })
  await ensureGeodata(profileDir, path.join(opts.repoRoot, 'vendor', 'geodata'))

  const upstream = YAML.parse(upstreamText)
  const mixedPort = await allocatePort()
  const controllerPort = await allocatePort()
  const secret = newSecret()
  const merged = mergeConfig(upstream, {}, { mixedPort, controllerPort, secret })
  const missing = missingReferences(merged)
  if (missing.length) throw new Error(`引用缺失：${missing.join(', ')}`)
  const configPath = await writeRuntime(profileDir, merged)
  const validated = await validateConfig(binary, profileDir, configPath)
  if (!validated.ok) {
    return { profileDir, supervisor: new CoreSupervisor({ binary, homeDir: profileDir, configPath, controllerPort, secret }), controller, ownership, mode: 'rule', startupStatus: 'config-error', restore: 'none', stopAll: async () => {} }
  }

  const supervisor = new CoreSupervisor({ binary, homeDir: profileDir, configPath, controllerPort, secret, spawn: opts.spawnFn, fetchFn: opts.fetchFn })
  const restore = await ownership.restoreOnStartupIfStale()
  if (restore === 'in-use') {
    return { profileDir, supervisor, controller, ownership, mode: 'rule', startupStatus: 'in-use', restore, stopAll: async () => {} }
  }

  try {
    const info = await supervisor.start()
    await writeCoreState(coreStateFile, { pid: info.pid, port: controllerPort, secret })
  } catch {
    return { profileDir, supervisor, controller, ownership, mode: 'rule', startupStatus: 'core-error', restore, stopAll: async () => { await clearCoreState(coreStateFile) } }
  }

  await controller.enable(`127.0.0.1:${mixedPort}`)
  const mode = (merged.mode as Mode) ?? 'rule'
  return {
    profileDir, supervisor, controller, ownership, mode, startupStatus: 'ready', restore,
    stopAll: async () => { await controller.disable(); await clearCoreState(coreStateFile); await supervisor.stop() }
  }
}
```

- [ ] **Step 4: 运行测试** — `npm test -- src/main/bootstrap.test.ts` → PASS；随后全量 `npm test` 与 `npx tsc --noEmit`

- [ ] **Step 5: 改 `src/main/index.ts` 使用 bootstrap**

`app.whenReady()` 后：`bootstrap({ userDataDir: app.getPath('userData'), isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, repoRoot: path.resolve(__dirname, '../..') })`；把 `startupStatus` 传给窗口（通过查询参数或 IPC）；`before-quit` 调用 `context.stopAll()`。窗口隐藏即销毁留给后续计划，本任务保持现有窗口行为。

- [ ] **Step 6: 提交** — `feat(main): 装配内核、配置与代理并接入应用启动`

---

### Task 2: IPC 与 preload 白名单

**Files:**
- Modify: `src/shared/ipc.ts`
- Create: `src/main/ipc.ts`, `src/main/ipc.test.ts`, `src/preload/index.ts`（重写）

**Interfaces:**
```ts
// src/shared/ipc.ts
export interface AppStatusView {
  status: 'no-config' | 'ready' | 'config-error' | 'core-error' | 'in-use'
  restore: 'none' | 'restored' | 'conflict' | 'in-use'
  mode: Mode
  proxyEnabled: boolean
  core?: { version: string; port: number; startedAt: number }
  profile?: { nodeCount: number; groupCount: number }
}
export interface ProxyGroupView { name: string; type: string; now: string; nodes: { name: string; delay?: number }[] }
export interface TrafficView { up: number; down: number; upTotal: number; downTotal: number }
export const IPC = {
  statusGet: 'app:status',
  proxiesGet: 'core:proxies',
  modeSet: 'config:mode',
  proxyEnable: 'proxy:enable',
  proxyDisable: 'proxy:disable',
  coreRestart: 'core:restart',
  configImport: 'config:import',
  statsPush: 'app:stats'
} as const
```
- `coreRestart`：调用 `supervisor.stop()` → `start()` → 写 `core-state.json`；失败返回 `{ ok: false, message }`。
- `configImport`：入参 `{ sourcePath: string }`，调用 `importFromFile`，成功后返回 `{ ok: true, needsRestart: true }`；本轮不自动重启（状态页会提示重启）。
- preload 暴露 `window.aether = { getStatus, getProxies, setMode, enableProxy, disableProxy, restartCore, importConfig, onStats(cb): () => void }`。

- [ ] **Step 1: 失败测试** — 断言 `statusGet` 的返回值不含 `secret`/`upstream`/`configPath` 字段；断言 mode 失败时抛错给渲染层（IPC 返回 `{ ok: false }` 而不是崩溃）。

```ts
it('status 视图不包含敏感字段', async () => {
  const ctx = fakeContext()
  const view = buildStatusView(ctx)
  const json = JSON.stringify(view)
  expect(json).not.toMatch(/secret|upstream|password|token/i)
})
```

- [ ] **Step 2: 实现 `buildStatusView/serialize` + handlers + preload**
- [ ] **Step 3: 测试绿 + tsc**
- [ ] **Step 4: 提交** — `feat(ipc): 白名单状态与代理视图通道`

---

### Task 3: 渲染层骨架与 tokens

**Files:**
- Create: `src/renderer/{index.html,main.tsx,App.tsx,copy.ts}`, `styles/tokens.css`, `styles/app.css`, `scripts/check-tokens.mjs`
- Modify: `package.json`（`dev` 前置 token 检查）

**Interfaces:**
- `tokens.css` 必须定义且只使用这些名字（后续任务只允许引用它们）：`--bg #0A0B0D`、`--sidebar #0C0D10`、`--card #141619`、`--card-2 #181B1F`、`--border #23262B`、`--border-2 #2C3037`、`--text #E8E9EB`、`--text-dim #9AA0A6`、`--text-faint #7E858C`、`--accent #4A8CFF`、`--accent-strong #2F6FE0`、`--success #34D399`、`--danger #F87171`；`--radius-card 14px`、`--radius-chip 6px`、`--radius-control 10px`；`--fs-body 13px`、`--fs-label 12px`、`--fs-micro 11px`、`--fs-title 26px`、`--fs-node 30px`、`--fs-stat 28px`；`--space-1 4px` … `--space-6 24px`（4/8/12/16/20/24）。
- `App.tsx`：`<div class="app"><TitleBar/><Sidebar/><main/></div>`。
- `check-tokens.mjs`：扫描 `src/renderer/**/*.{ts,tsx,css}`，除 `tokens.css` 外出现 `#[0-9a-f]{3,8}` 或 `font-size:\s*\d+px` 即退出 1。

- [ ] **Step 1: 写 token 检查脚本与失败样例**
- [ ] **Step 2: 写 tokens.css / app.css / 骨架组件**
- [ ] **Step 3: `node scripts/check-tokens.mjs` 通过、`npm run build` 通过**
- [ ] **Step 4: 提交** — `feat(renderer): 应用外壳与设计 tokens`

---

### Task 4: 顶栏与模式切换

**Files:** `components/TopBar.tsx`, `components/ModeSwitch.tsx`, `hooks/useStatus.ts`, tests.

**Interfaces:**
- `useStatus()`：1s 轮询 `getStatus`，返回 `{ status, refresh }`。
- `ModeSwitch({ value, onChange })`：三段；点击调用 `setMode`，先乐观更新，`{ ok: false }` 或抛错时回滚并显示一行错误。
- 顶栏右侧：模式分段 + 代理 pill（开/关），点击 pill 调 `enableProxy/disableProxy`。

- [ ] **Step 1: 失败测试** — 模式切换失败回滚：

```tsx
it('模式切换失败时回滚选中态', async () => {
  const setMode = vi.fn(async () => ({ ok: false, status: 500 }))
  render(<ModeSwitch value="rule" onChange={() => {}} setMode={setMode} />)
  await userEvent.click(screen.getByRole('button', { name: '全局' }))
  expect(await screen.findByText(/切换失败/)).toBeTruthy()
  expect(screen.getByRole('button', { name: '规则' }).getAttribute('aria-pressed')).toBe('true')
})
```
- [ ] **Step 2: 实现**
- [ ] **Step 3: 测试绿 + tokens 检查**
- [ ] **Step 4: 提交** — `feat(renderer): 顶栏与规则/全局/直连切换`

---

### Task 5: 仪表盘卡片与流量图

**Files:** `components/{NodeCard,CoreCard,StatCards,TrafficChart}.tsx`, `hooks/useStats.ts`, tests.

**Interfaces:**
- `useStats()`：订阅 `onStats`，保留最近 60 个样本。
- `NodeCard`：节点名、策略组、健康行（失败次数/延迟）、60 格刻度条；无数据时全部显示 `—`。
- `CoreCard`：版本、端口、策略组数、启动时间、内存。
- `StatCards`：下载/上传/活跃连接（连接数本轮显示 `—`，连接页在下一份计划）。
- `TrafficChart`：SVG 双折线，取最近 60 样本；空数据时显示基线。

- [ ] **Step 1: 失败测试** — 空数据渲染 `—` 且不出现 `NaN`；有数据时图线点数等于样本数。
- [ ] **Step 2: 实现**
- [ ] **Step 3: 测试绿 + tokens 检查**
- [ ] **Step 4: 提交** — `feat(renderer): 仪表盘四块与流量图`

---

### Task 6: 三套状态

**Files:** `components/StatePanel.tsx`, tests.

- `no-config`：说明 + 「导入配置」按钮（本轮按钮打开一个 `<input type=file>`，选择后调用 `importFromFile` 的 IPC 通道，见 Task 2 扩展；若该通道未就绪则禁用并注明）。
- `core-error`：错误摘要 + 「重启内核」（调用 `coreRestart` 通道）+「查看日志」（占位，注明日志面板在下一份计划）。
- `in-use`：说明另一实例在运行，不提供操作。
- 任何状态下侧栏可点击。

- [ ] **Step 1: 失败测试** — 三种状态渲染各自的标题与主操作；`in-use` 不渲染重启按钮。
- [ ] **Step 2: 实现**
- [ ] **Step 3: 测试绿**
- [ ] **Step 4: 提交** — `feat(renderer): 无配置/内核错误/被占用三套状态`

---

### Task 7: 渲染层测试基础设施与应用冒烟

**Files:** `vitest.config.ts`（jsdom 环境 + setup 文件）、`src/renderer/test-setup.ts`、`scripts/app-shot.mjs`、`package.json` scripts.

- 安装 `jsdom @testing-library/react @testing-library/user-event`。
- `vitest.config.ts` 用 environmentMatchGlobs：`src/renderer/**` 用 jsdom，其余 node。
- `scripts/app-shot.mjs`：以 `--shot` 启动 Electron；主进程在窗口加载完成后 `webContents.capturePage()` 保存 `docs/design/mockups/app-smoke.png`，然后退出。用于证明界面真的渲染出来。
- 注意：`--shot` 在无配置时可以只截状态页。

- [ ] **Step 1: 配置测试环境**，跑通 Task 4/5/6 的测试
- [ ] **Step 2: 实现截图冒烟并运行**，确认 PNG 非空白
- [ ] **Step 3: 提交** — `test(renderer): jsdom 测试环境与应用截图冒烟`

---

## 下一份计划

`2026-10-24-m1-connections-and-shell.md`：连接采集（WS 快照 + 60 秒环形缓冲 + `chains` 反转）、连接页（六列、行内详情、搜索/只看活跃）、命令面板、托盘、窗口隐藏即销毁、开机自启、`will-quit`/`session-end` 接线、`taskkill /F` 与端到端验收、内存测量。
