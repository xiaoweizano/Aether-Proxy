# M1 内核与代理底座 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付一个无界面但可验证的 Electron 主进程底座：导入 Clash YAML、按逐键策略合并出 runtime 配置、启动并守护 mihomo、接管 Windows 系统代理，并在任意异常退出后把用户网络恢复原状。

**Architecture:** 主进程按职责拆成五块——`core`（进程与 HTTP/WS 客户端）、`config`（导入、合并、校验、原子写）、`proxy`（平台接口与所有权快照）、`lifecycle`（启动/退出编排）、`ipc`（下一份计划消费）。所有平台相关能力藏在 `PlatformProxy` 接口后，Windows 实现由 koffi 直接调用 Win32 API，测试用内存假实现。mihomo 的真实进程在单测里由 `test/fixtures/fake-mihomo.mjs` 替代，只有最后的冒烟测试用真二进制。

**Tech Stack:** Electron 45 / Node 24（随 Electron）/ TypeScript 5 strict / electron-vite / Vitest / `yaml` / koffi（Windows 注册表与 WinINet）。

**Spec:** `openspec/changes/add-m1-windows-vertical-slice/`（proposal、design、specs、tasks），产品与视觉约束见 `docs/design/2026-10-23-aether-proxy.md`、`docs/design/2026-10-23-ui-pivot-dashboard.md`、`DESIGN.md`。

## Global Constraints

- Electron 45.x；TypeScript 5.x，`strict: true`；Node 版本随 Electron 内置，不单独安装。
- mihomo **v1.19.32**，二进制在仓库内以 SHA-256 锁定；不得升级版本而不更新哈希。
- 只支持 Windows x64；macOS / Linux / Android 不在本计划内。
- Windows 系统代理写入 `HKCU`，**全程不得触发 UAC**。
- controller 只绑定 `127.0.0.1`，secret 每次启动随机生成，**不得离开主进程**。
- 配置目录：`<userData>/profiles/<id>/`，其中 `upstream.yaml` 只读、`runtime.yaml` 与它同目录。
- 内核启动命令固定为 `mihomo -d <profiles/<id>> -f <profiles/<id>/runtime.yaml`；`mihomo -t` 必须使用同一个 `-d`。
- 注入项覆盖上游：`mixed-port`、`external-controller`、`secret`、`find-process-mode: always`、`tun.enable: false`，并删除 `redir-port` / `tproxy-port`。
- 退出顺序固定：**先还原系统代理，再终止内核**。
- 所有写配置的操作必须原子写（临时文件 + rename），失败时不得应用代理。
- UI 文案不在本计划内；本计划不产生任何渲染层代码。

## Review Focus

这些是规格隐含、但没有单个测试天然覆盖的失败面。每一条都在对应任务里配了测试。

1. **真实订阅带 `proxy-providers` / `dns` / `use` 策略组**——合并错不会报错，只会让某个组变空或分流跑偏；Task 4 与 Task 5 用真实结构样本钉住。
2. **上游配置自带 `tun.enable: true`**——透传会让 mihomo 申请驱动和权限，违反无 TUN 约束；Task 4 用该配置做断言。
3. **崩溃或关机后代理残留**——用户重启后整台机器断网；Task 9 用"快照存在且进程已死"的模拟钉住启动还原。
4. **端口冲突与孤儿内核**——另选端口 vs 干扰别人，判错就是删掉用户正在跑的内核；Task 8 用旧 secret 探测的两个分支钉住。
5. **配置校验失败时仍然应用代理**——会留下一个指向死端口的代理；Task 11 用"配置错误 → 不调 setSystemProxy"的断言钉住。

---

## 文件结构

```
package.json                      脚本、依赖、版本锁定
tsconfig.json                     strict、路径别名
electron.vite.config.ts           主进程/预加载构建
vitest.config.ts                  只跑 node 环境
src/shared/types.ts               Mode / ProxyState / CoreInfo / ConnectionView
src/shared/ipc.ts                 IPC 通道常量（下一份计划消费）
src/main/core/ports.ts            allocatePort
src/main/core/secret.ts           newSecret
src/main/core/binary.ts           mihomo 二进制路径解析（开发/打包）
src/main/core/backoff.ts          nextRestart 纯函数
src/main/core/supervisor.ts       启动/停止/健康检查/退避重启
src/main/core/orphan.ts           孤儿内核判定
src/main/config/paths.ts          profiles 目录解析
src/main/config/atomic.ts         原子写（临时文件 + rename），供 runtime 与 import 共用
src/main/config/import.ts         本地/URL 导入
src/main/config/merge.ts          逐键合并
src/main/config/references.ts     引用完整性
src/main/config/runtime.ts        原子写 runtime.yaml
src/main/config/validate.ts       mihomo -t 封装
src/main/config/reload.ts         PUT /configs 热重载与回滚
src/main/proxy/platform.ts        PlatformProxy 接口
src/main/proxy/ownership.ts       快照/还原/冲突判定
src/main/proxy/fake.ts            测试用内存实现
src/main/proxy/win32.ts           koffi 调用 advapi32 / wininet
src/main/lifecycle.ts             startup / shutdown 编排
src/main/index.ts                 Electron 入口（最小可运行）
test/fixtures/fake-mihomo.mjs     假内核：/version、-t、可注入失败
test/fixtures/subscription.yaml   脱敏真实订阅样本
scripts/proxy-check.mjs           真机注册表往返验证（Task 10）
scripts/smoke.mjs                 真 mihomo 端到端冒烟（Task 12）
```

每个文件一个职责；`core` 与 `proxy` 互不 import，只通过接口在 `lifecycle` 汇合——这是"将来能搬进独立守护进程"的前提。

---

### Task 1: 工程骨架与测试基线

**Files:**
- Create: `package.json`, `tsconfig.json`, `electron.vite.config.ts`, `vitest.config.ts`, `src/main/index.ts`, `src/shared/types.ts`, `src/shared/ipc.ts`, `.gitignore`

**Interfaces:**
- Produces: `npm run build`、`npm test`、`npm run dev` 三个脚本可用；`src/shared/types.ts` 导出后续任务使用的类型。

- [ ] **Step 1: 写 `package.json`**

```json
{
  "name": "aether-proxy",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "yaml": "^2.6.1"
  },
  "devDependencies": {
    "electron": "45.0.0",
    "electron-vite": "^4.0.0",
    "typescript": "^5.6.0",
    "vite": "^7.0.0",
    "vitest": "^3.0.0",
    "@types/node": "^24.0.0"
  }
}
```

- [ ] **Step 2: 写 TypeScript 与构建配置**

`tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "types": ["node"],
    "baseUrl": ".",
    "paths": { "@shared/*": ["src/shared/*"] }
  },
  "include": ["src", "test"]
}
```

`electron.vite.config.ts`：

```ts
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: { build: { rollupOptions: { input: 'src/main/index.ts' } } },
  preload: {
    build: {
      rollupOptions: {
        input: 'src/preload/index.ts',
        // 沙箱化的 preload 只能以 CommonJS 运行，必须显式产出 .cjs
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: { build: { rollupOptions: { input: 'src/renderer/index.html' } } }
})
```

`vitest.config.ts`：

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'], passWithNoTests: true }
})
```

- [ ] **Step 3: 写共享类型**

`src/shared/types.ts`：

```ts
export type Mode = 'rule' | 'global' | 'direct'

export interface ProxyState {
  enabled: boolean
  server?: string
  bypass?: string[]
  autoConfigUrl?: string
  autoDetect?: boolean
}

export interface CoreInfo {
  pid: number
  version: string
  controllerPort: number
  startedAt: number
}

export type CoreStatus = 'stopped' | 'starting' | 'running' | 'error'

export interface ConnectionView {
  id: string
  start: string
  process?: string
  processPath?: string
  host: string
  network: string
  rule: string
  rulePayload: string
  chains: string[]        // 已反转：最外层策略组在前，实际出站在后
  upload: number
  download: number
  destinationIP?: string
  destinationPort?: string
  ended: boolean
  endedAt?: number
}
```

`src/shared/ipc.ts`：

```ts
export const IPC = {
  coreStatus: 'core:status',
  coreRestart: 'core:restart',
  proxyGet: 'proxy:get',
  proxyEnable: 'proxy:enable',
  proxyDisable: 'proxy:disable',
  modeSet: 'config:mode',
  connections: 'connections:update',
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
```

- [ ] **Step 4: 写最小主进程入口（安全基线）**

`src/main/index.ts`：

```ts
import { app, BrowserWindow } from 'electron'
import path from 'node:path'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#0A0B0D',
    webPreferences: {
      // 沙箱化 preload 由构建产出为 CommonJS（.cjs），不能用 .mjs
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) win.loadURL(devUrl)
  else win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
```

- [ ] **Step 5: 写 preload 与 renderer 占位**

`src/preload/index.ts`：

```ts
import { contextBridge } from 'electron'

contextBridge.exposeInMainWorld('aether', {})
```

`src/renderer/index.html`：

```html
<!doctype html>
<html lang="zh-CN">
  <head><meta charset="utf-8" /><title>Aether</title></head>
  <body style="margin:0;background:#0A0B0D"></body>
</html>
```

- [ ] **Step 6: 加 `.gitignore` 并跑构建**

`.gitignore`：

```
node_modules/
out/
dist/
vendor/*.zip
.impeccable/review/
```

Run: `npm install && npm run build`
Expected: 构建成功，`out/main/index.js` 存在。

- [ ] **Step 7: 提交**

```bash
git add package.json package-lock.json tsconfig.json electron.vite.config.ts vitest.config.ts src .gitignore
git commit -m "chore: 初始化 Electron + TypeScript 工程与安全基线"
```

---

### Task 2: 空闲端口与随机 secret

**Files:**
- Create: `src/main/core/ports.ts`, `src/main/core/secret.ts`, `src/main/core/ports.test.ts`

**Interfaces:**
- Produces: `allocatePort(): Promise<number>`、`newSecret(): string`。

- [ ] **Step 1: 写失败测试**

`src/main/core/ports.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import net from 'node:net'
import { allocatePort } from './ports'
import { newSecret } from './secret'

describe('allocatePort', () => {
  it('返回一个当前可绑定的端口', async () => {
    const port = await allocatePort()
    expect(port).toBeGreaterThan(0)
    await new Promise<void>((resolve, reject) => {
      const srv = net.createServer()
      srv.once('error', reject)
      srv.listen(port, '127.0.0.1', () => srv.close(() => resolve()))
    })
  })

  it('连续两次分配不返回同一个端口', async () => {
    const a = await allocatePort()
    const b = await allocatePort()
    expect(a).not.toBe(b)
  })
})

describe('newSecret', () => {
  it('返回 32 位十六进制且每次不同', () => {
    const a = newSecret()
    const b = newSecret()
    expect(a).toMatch(/^[0-9a-f]{32}$/)
    expect(a).not.toBe(b)
  })
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `npm test -- src/main/core/ports.test.ts`
Expected: FAIL，`Cannot find module './ports'`

- [ ] **Step 3: 实现**

`src/main/core/ports.ts`：

```ts
import net from 'node:net'

export function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr && typeof addr === 'object') {
        const { port } = addr
        srv.close(() => resolve(port))
      } else {
        srv.close(() => reject(new Error('无法获取空闲端口')))
      }
    })
  })
}
```

`src/main/core/secret.ts`：

```ts
import { randomBytes } from 'node:crypto'

export function newSecret(): string {
  return randomBytes(16).toString('hex')
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `npm test -- src/main/core/ports.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/main/core
git commit -m "feat(core): 空闲端口分配与随机 secret"
```

---

### Task 3: 重启退避状态机

**Files:**
- Create: `src/main/core/backoff.ts`, `src/main/core/backoff.test.ts`

**Interfaces:**
- Produces: `nextRestart(attempts: number[], now: number, policy?: RestartPolicy): { delayMs: number } | null`。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { nextRestart, DEFAULT_POLICY } from './backoff'

describe('nextRestart', () => {
  it('按 1s / 2s / 4s 递增', () => {
    const now = 1_000_000
    expect(nextRestart([], now)?.delayMs).toBe(1000)
    expect(nextRestart([now - 1000], now)?.delayMs).toBe(2000)
    expect(nextRestart([now - 3000, now - 1000], now)?.delayMs).toBe(4000)
  })

  it('10 分钟内第 4 次返回 null', () => {
    const now = 1_000_000
    const attempts = [now - 9000, now - 6000, now - 3000]
    expect(nextRestart(attempts, now)).toBeNull()
  })

  it('窗口外的旧尝试不计入', () => {
    const now = 1_000_000
    const attempts = [now - DEFAULT_POLICY.windowMs - 1, now - 1000, now - 500]
    expect(nextRestart(attempts, now)?.delayMs).toBe(4000)
  })
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `npm test -- src/main/core/backoff.test.ts`
Expected: FAIL，`Cannot find module './backoff'`

- [ ] **Step 3: 实现**

```ts
export interface RestartPolicy {
  maxAttempts: number
  windowMs: number
  delaysMs: number[]
}

export const DEFAULT_POLICY: RestartPolicy = {
  maxAttempts: 3,
  windowMs: 10 * 60_000,
  delaysMs: [1000, 2000, 4000]
}

export function nextRestart(
  attempts: number[],
  now: number,
  policy: RestartPolicy = DEFAULT_POLICY
): { delayMs: number } | null {
  const recent = attempts.filter((t) => now - t < policy.windowMs)
  if (recent.length >= policy.maxAttempts) return null
  const idx = Math.min(recent.length, policy.delaysMs.length - 1)
  return { delayMs: policy.delaysMs[idx] ?? policy.delaysMs[policy.delaysMs.length - 1]! }
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `npm test -- src/main/core/backoff.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/main/core/backoff.ts src/main/core/backoff.test.ts
git commit -m "feat(core): 内核崩溃重启的退避策略"
```

---

### Task 4: 逐键配置合并

**Files:**
- Create: `src/main/config/merge.ts`, `src/main/config/merge.test.ts`

**Interfaces:**
- Produces: `mergeConfig(upstream: unknown, overrides: unknown, inject: Inject): Record<string, unknown>`。
- `Inject = { mixedPort: number; controllerPort: number; secret: string }`。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { mergeConfig } from './merge'

const inject = { mixedPort: 5566, controllerPort: 5567, secret: 'abc123' }

describe('mergeConfig', () => {
  it('rules 前后插入，顺序正确', () => {
    const out = mergeConfig(
      { rules: ['MATCH,DIRECT'] },
      { rules: { prepend: ['DOMAIN,a.com,DIRECT'], append: ['GEOIP,CN,DIRECT'] } },
      inject
    )
    expect(out.rules).toEqual(['DOMAIN,a.com,DIRECT', 'MATCH,DIRECT', 'GEOIP,CN,DIRECT'])
  })

  it('proxies 与 proxy-groups 按 name 合并，同名整条替换', () => {
    const out = mergeConfig(
      { proxies: [{ name: 'HK', type: 'ss', server: 'old' }], 'proxy-groups': [{ name: 'Proxy', type: 'select', proxies: ['HK'] }] },
      { proxies: [{ name: 'HK', type: 'ss', server: 'new' }] },
      inject
    )
    expect(out.proxies).toEqual([{ name: 'HK', type: 'ss', server: 'new' }])
    expect((out['proxy-groups'] as any[])[0].proxies).toEqual(['HK'])
  })

  it('dns 深合并，nameserver-policy 按 key 合并', () => {
    const out = mergeConfig(
      { dns: { enable: true, 'nameserver-policy': { 'geosite:cn': '223.5.5.5' } } },
      { dns: { 'nameserver-policy': { 'geosite:geolocation-!cn': '1.1.1.1' } } },
      inject
    ) as any
    expect(out.dns.enable).toBe(true)
    expect(out.dns['nameserver-policy']).toEqual({
      'geosite:cn': '223.5.5.5',
      'geosite:geolocation-!cn': '1.1.1.1'
    })
  })

  it('强制关闭 tun 并清空 redir/tproxy', () => {
    const out = mergeConfig(
      { tun: { enable: true, stack: 'gvisor' }, 'redir-port': 7892, 'tproxy-port': 7893 },
      {},
      inject
    ) as any
    expect(out.tun.enable).toBe(false)
    expect(out.tun.stack).toBe('gvisor')
    expect(out['redir-port']).toBeUndefined()
    expect(out['tproxy-port']).toBeUndefined()
  })

  it('注入端口、控制器、secret 与 find-process-mode', () => {
    const out = mergeConfig({ 'mixed-port': 7890 }, {}, inject) as any
    expect(out['mixed-port']).toBe(5566)
    expect(out['external-controller']).toBe('127.0.0.1:5567')
    expect(out.secret).toBe('abc123')
    expect(out['find-process-mode']).toBe('always')
  })

  it('proxy-providers / rule-providers 按 name 合并（对象 map，不是数组）', () => {
    const out = mergeConfig(
      { 'proxy-providers': { 'prov-a': { type: 'http' } } },
      { 'proxy-providers': { 'prov-b': { type: 'file' } }, 'rule-providers': { 'rp-a': { type: 'http' } } },
      inject
    ) as any
    expect(Object.keys(out['proxy-providers']).sort()).toEqual(['prov-a', 'prov-b'])
    expect(out['rule-providers']).toEqual({ 'rp-a': { type: 'http' } })
  })

  it('未知顶层键原样透传', () => {
    const out = mergeConfig({ 'geodata-mode': true }, {}, inject) as any
    expect(out['geodata-mode']).toBe(true)
  })
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `npm test -- src/main/config/merge.test.ts`
Expected: FAIL，`Cannot find module './merge'`

- [ ] **Step 3: 实现**

```ts
export interface Inject {
  mixedPort: number
  controllerPort: number
  secret: string
}

const ARRAY_MAP_KEYS = ['proxies', 'proxy-groups'] as const
const DICT_MAP_KEYS = ['proxy-providers', 'rule-providers'] as const
const DEEP_MERGE_KEYS = ['dns', 'sniffer', 'profile'] as const

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isObject(base) || !isObject(patch)) return structuredClone(patch)
  const out: Record<string, unknown> = structuredClone(base)
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isObject(v) && isObject(out[k]) ? deepMerge(out[k], v) : structuredClone(v)
  }
  return out
}

function mergeArrayByName(base: unknown, add: unknown): unknown {
  const list = Array.isArray(base) ? [...base] : []
  const additions = Array.isArray(add) ? add : []
  if (additions.length === 0) return list
  const byName = new Map<string, unknown>()
  for (const item of list) byName.set(String((item as any)?.name), item)
  for (const item of additions) byName.set(String((item as any)?.name), item)
  return [...byName.values()]
}

function mergeDict(base: unknown, add: unknown): unknown {
  const out = isObject(base) ? structuredClone(base) : {}
  if (isObject(add)) Object.assign(out, structuredClone(add))
  return out
}

export function mergeConfig(
  upstream: unknown,
  overrides: unknown,
  inject: Inject
): Record<string, unknown> {
  const base = isObject(upstream) ? structuredClone(upstream) : {}
  const ov = isObject(overrides) ? overrides : {}

  const baseRules = Array.isArray(base.rules) ? base.rules : []
  const prepend = Array.isArray((ov as any).rules?.prepend) ? (ov as any).rules.prepend : []
  const append = Array.isArray((ov as any).rules?.append) ? (ov as any).rules.append : []
  base.rules = [...prepend, ...baseRules, ...append]

  for (const key of ARRAY_MAP_KEYS) {
    if (key in ov) base[key] = mergeArrayByName(base[key], ov[key])
  }

  for (const key of DICT_MAP_KEYS) {
    if (key in ov) base[key] = mergeDict(base[key], ov[key])
  }

  for (const key of DEEP_MERGE_KEYS) {
    if (key in ov) base[key] = deepMerge(base[key], ov[key])
  }

  base['mixed-port'] = inject.mixedPort
  base['external-controller'] = `127.0.0.1:${inject.controllerPort}`
  base.secret = inject.secret
  base['find-process-mode'] = 'always'

  const tun = isObject(base.tun) ? base.tun : {}
  base.tun = { ...tun, enable: false }
  delete base['redir-port']
  delete base['tproxy-port']

  return base
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `npm test -- src/main/config/merge.test.ts`
Expected: PASS（6 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/main/config/merge.ts src/main/config/merge.test.ts
git commit -m "feat(config): 逐键合并策略与注入项"
```

---

### Task 5: 引用完整性检查

**Files:**
- Create: `src/main/config/references.ts`, `src/main/config/references.test.ts`

**Interfaces:**
- Produces: `missingReferences(config: unknown): string[]`，返回形如 `Proxy:HK-99` 或 `Auto:provider:prov-a` 的字符串；空数组代表通过。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { missingReferences } from './references'

describe('missingReferences', () => {
  it('引用存在的节点时不报错，组名互引也合法', () => {
    const cfg = {
      proxies: [{ name: 'HK' }],
      'proxy-groups': [
        { name: 'Proxy', proxies: ['HK', 'DIRECT'] },
        { name: 'Auto', proxies: ['Proxy'] }
      ]
    }
    expect(missingReferences(cfg)).toEqual([])
  })

  it('引用不存在的节点时报出组名与缺失名', () => {
    const cfg = {
      proxies: [{ name: 'HK' }],
      'proxy-groups': [{ name: 'Proxy', proxies: ['HK', 'JP-99'] }]
    }
    expect(missingReferences(cfg)).toEqual(['Proxy:JP-99'])
  })

  it('use 引用不存在的 provider 时报错', () => {
    const cfg = {
      proxies: [],
      'proxy-providers': { 'prov-a': {} },
      'proxy-groups': [{ name: 'Auto', use: ['prov-a', 'prov-b'] }]
    }
    expect(missingReferences(cfg)).toEqual(['Auto:provider:prov-b'])
  })
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `npm test -- src/main/config/references.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
const BUILTIN = new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'GLOBAL'])

export function missingReferences(config: unknown): string[] {
  const cfg = (config ?? {}) as any
  const nodeNames = new Set<string>((cfg.proxies ?? []).map((p: any) => String(p?.name)))
  const groupNames = new Set<string>((cfg['proxy-groups'] ?? []).map((g: any) => String(g?.name)))
  const providers = new Set<string>(Object.keys(cfg['proxy-providers'] ?? {}))

  const missing: string[] = []
  for (const group of cfg['proxy-groups'] ?? []) {
    for (const ref of group?.proxies ?? []) {
      const name = String(ref)
      if (!nodeNames.has(name) && !groupNames.has(name) && !BUILTIN.has(name)) {
        missing.push(`${group.name}:${name}`)
      }
    }
    for (const provider of group?.use ?? []) {
      if (!providers.has(String(provider))) missing.push(`${group.name}:provider:${provider}`)
    }
  }
  return missing
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `npm test -- src/main/config/references.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/main/config/references.ts src/main/config/references.test.ts
git commit -m "feat(config): 策略组引用完整性检查"
```

---

### Task 6: 原子写 runtime 配置

**Files:**
- Create: `src/main/config/runtime.ts`, `src/main/config/runtime.test.ts`

**Interfaces:**
- Produces: `writeRuntime(profileDir: string, config: unknown): Promise<string>`，返回 `runtime.yaml` 的绝对路径；`readRuntime(profileDir: string): Promise<Record<string, unknown> | null>`。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { writeRuntime, readRuntime } from './runtime'

let dir: string
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'aether-')) })

describe('writeRuntime', () => {
  it('写到与 upstream 相同的目录，并可读回', async () => {
    await writeFile(path.join(dir, 'upstream.yaml'), 'proxies: []\n')
    const file = await writeRuntime(dir, { 'mixed-port': 5566, tun: { enable: false } })
    expect(path.dirname(file)).toBe(dir)
    const text = await readFile(file, 'utf8')
    expect(text).toContain('mixed-port: 5566')
    expect(await readRuntime(dir)).toMatchObject({ 'mixed-port': 5566 })
  })

  it('多次写入不留下临时文件', async () => {
    await writeRuntime(dir, { a: 1 })
    await writeRuntime(dir, { a: 2 })
    const entries = await readFile(path.join(dir, 'runtime.yaml'), 'utf8')
    expect(entries).toContain('a: 2')
  })
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `npm test -- src/main/config/runtime.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
import { randomBytes } from 'node:crypto'
import { readFile, rename, writeFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'

const FILE = 'runtime.yaml'

export async function writeRuntime(profileDir: string, config: unknown): Promise<string> {
  const target = path.join(profileDir, FILE)
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await writeFile(tmp, YAML.stringify(config), 'utf8')
    await rename(tmp, target)
  } catch (err) {
    await unlink(tmp).catch(() => {})
    throw err
  }
  return target
}

export async function readRuntime(profileDir: string): Promise<Record<string, unknown> | null> {
  try {
    return YAML.parse(await readFile(path.join(profileDir, FILE), 'utf8')) ?? null
  } catch {
    return null
  }
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `npm test -- src/main/config/runtime.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/main/config/runtime.ts src/main/config/runtime.test.ts
git commit -m "feat(config): runtime.yaml 原子写入"
```

---

### Task 6A: Profile 目录与配置导入

**Files:**
- Create: `src/main/config/paths.ts`, `src/main/config/import.ts`, `src/main/config/import.test.ts`

**Interfaces:**
- Produces:
  - `createProfile(rootDir: string, id: string): Promise<{ dir: string; upstreamPath: string }>`
  - `importFromFile(profileDir: string, sourcePath: string): Promise<void>`
  - `importFromUrl(profileDir: string, url: string, fetchFn?: typeof fetch): Promise<void>`
- 两者都先校验内容是可解析的 YAML 且含 `proxies` 或 `proxy-groups`，校验通过才写入 `upstream.yaml`；失败时抛错且不改动已有文件。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { importFromFile, importFromUrl } from './import'
import { createProfile } from './paths'

let root: string
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'aether-import-')) })

const good = 'proxies:\n  - { name: HK, type: ss, server: 127.0.0.1, port: 9, cipher: aes-128-gcm, password: x }\n'

describe('createProfile', () => {
  it('创建目录并返回 upstream 路径', async () => {
    const p = await createProfile(root, 'p1')
    expect(p.upstreamPath).toBe(path.join(root, 'profiles', 'p1', 'upstream.yaml'))
  })
})

describe('importFromFile', () => {
  it('把合法文件原样复制为 upstream.yaml', async () => {
    const { dir } = await createProfile(root, 'p1')
    const src = path.join(root, 'src.yaml')
    await writeFile(src, good, 'utf8')
    await importFromFile(dir, src)
    expect(await readFile(path.join(dir, 'upstream.yaml'), 'utf8')).toBe(good)
  })

  it('非法内容抛错且不覆盖已有配置', async () => {
    const { dir } = await createProfile(root, 'p1')
    const src = path.join(root, 'src.yaml')
    await writeFile(src, good, 'utf8')
    await importFromFile(dir, src)
    const bad = path.join(root, 'bad.yaml')
    await writeFile(bad, 'just a string', 'utf8')
    await expect(importFromFile(dir, bad)).rejects.toThrow('不是合法的 Clash 配置')
    expect(await readFile(path.join(dir, 'upstream.yaml'), 'utf8')).toBe(good)
  })
})

describe('importFromUrl', () => {
  it('200 且内容合法时写入', async () => {
    const { dir } = await createProfile(root, 'p1')
    const fetchFn = (async () => new Response(good, { status: 200 })) as any
    await importFromUrl(dir, 'https://example.com/sub', fetchFn)
    expect(await readFile(path.join(dir, 'upstream.yaml'), 'utf8')).toBe(good)
  })

  it('非 200 时抛错且不写入', async () => {
    const { dir } = await createProfile(root, 'p1')
    const fetchFn = (async () => new Response('nope', { status: 403 })) as any
    await expect(importFromUrl(dir, 'https://example.com/sub', fetchFn)).rejects.toThrow('返回 403')
  })
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `npm test -- src/main/config/import.test.ts`
Expected: FAIL，`Cannot find module './import'`

- [ ] **Step 3: 实现**

`src/main/config/atomic.ts`：

```ts
import { randomBytes } from 'node:crypto'
import { rename, unlink, writeFile } from 'node:fs/promises'

export async function writeFileAtomic(target: string, data: string): Promise<void> {
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await writeFile(tmp, data, 'utf8')
    await rename(tmp, target)
  } catch (err) {
    await unlink(tmp).catch(() => {})
    throw err
  }
}
```

`src/main/config/paths.ts`：

```ts
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

export async function createProfile(rootDir: string, id: string) {
  const dir = path.join(rootDir, 'profiles', id)
  await mkdir(dir, { recursive: true })
  return { dir, upstreamPath: path.join(dir, 'upstream.yaml') }
}
```

`src/main/config/import.ts`：

```ts
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'
import { writeFileAtomic } from './atomic'

function assertClashConfig(text: string): void {
  let parsed: unknown
  try {
    parsed = YAML.parse(text)
  } catch {
    throw new Error('不是合法的 Clash 配置：YAML 解析失败')
  }
  const cfg = parsed as Record<string, unknown>
  const hasProxies = Array.isArray(cfg?.proxies)
  const hasGroups = Array.isArray(cfg?.['proxy-groups'])
  if (!hasProxies && !hasGroups) throw new Error('不是合法的 Clash 配置：缺少 proxies 或 proxy-groups')
}

export async function importFromFile(profileDir: string, sourcePath: string): Promise<void> {
  const text = await readFile(sourcePath, 'utf8')
  assertClashConfig(text)
  await writeFileAtomic(path.join(profileDir, 'upstream.yaml'), text)
}

export async function importFromUrl(
  profileDir: string,
  url: string,
  fetchFn: typeof fetch = fetch
): Promise<void> {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`订阅地址返回 ${res.status}`)
  const text = await res.text()
  assertClashConfig(text)
  await writeFileAtomic(path.join(profileDir, 'upstream.yaml'), text)
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `npm test -- src/main/config/import.test.ts`
Expected: PASS（5 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/main/config/paths.ts src/main/config/import.ts src/main/config/import.test.ts
git commit -m "feat(config): profile 目录与本地/URL 导入"
```

---

### Task 6B: 配置校验与热重载

**Files:**
- Create: `src/main/config/validate.ts`, `src/main/config/reload.ts`, `src/main/config/validate.test.ts`, `src/main/config/reload.test.ts`

**Interfaces:**
- Produces:
  - `validateConfig(binary: string, homeDir: string, configPath: string): Promise<{ ok: boolean; output: string }>`
  - `reloadConfig(controllerPort: number, secret: string, configPath: string, fetchFn?: typeof fetch): Promise<{ ok: boolean; status: number }>`

- [ ] **Step 1: 写失败测试**

`src/main/config/validate.test.ts`：

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { validateConfig } from './validate'

let dir: string
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'aether-validate-')) })

const fake = process.execPath
const fakeArgs = [path.resolve('test/fixtures/fake-mihomo.mjs')]

describe('validateConfig', () => {
  it('合法配置返回 ok', async () => {
    const cfg = path.join(dir, 'runtime.yaml')
    await writeFile(cfg, 'proxies: []\n', 'utf8')
    const res = await validateConfig(fake, dir, cfg, fakeArgs)
    expect(res.ok).toBe(true)
    expect(res.output).toContain('successful')
  })

  it('非法配置返回 ok=false 并带回内核输出', async () => {
    const cfg = path.join(dir, 'runtime.yaml')
    await writeFile(cfg, '__INVALID__\n', 'utf8')
    const res = await validateConfig(fake, dir, cfg, fakeArgs)
    expect(res.ok).toBe(false)
    expect(res.output).toContain('parse error')
  })
})
```

`src/main/config/reload.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { reloadConfig } from './reload'

describe('reloadConfig', () => {
  it('PUT /configs 返回 204 时 ok', async () => {
    const fetchFn = (async (_url: string, init: RequestInit) => {
      expect((init.method ?? '').toUpperCase()).toBe('PUT')
      expect(String(init.body)).toContain('runtime.yaml')
      return new Response(null, { status: 204 })
    }) as any
    const res = await reloadConfig(5567, 's', '/tmp/profiles/p1/runtime.yaml', fetchFn)
    expect(res).toEqual({ ok: true, status: 204 })
  })

  it('返回 400 时 ok=false，由调用方回滚', async () => {
    const fetchFn = (async () => new Response('bad', { status: 400 })) as any
    const res = await reloadConfig(5567, 's', '/tmp/runtime.yaml', fetchFn)
    expect(res).toEqual({ ok: false, status: 400 })
  })

  it('传输失败返回 ok=false/status=0，不抛异常', async () => {
    const fetchFn = (async () => { throw new Error('ECONNREFUSED') }) as any
    const res = await reloadConfig(5567, 's', '/tmp/runtime.yaml', fetchFn)
    expect(res).toEqual({ ok: false, status: 0 })
  })
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `npm test -- src/main/config/validate.test.ts src/main/config/reload.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现**

`src/main/config/validate.ts`：

```ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

export async function validateConfig(
  binary: string,
  homeDir: string,
  configPath: string,
  argsPrefix: string[] = []
): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await run(binary, [...argsPrefix, '-t', '-d', homeDir, '-f', configPath], {
      windowsHide: true,
      timeout: 15_000
    })
    return { ok: true, output: `${stdout}${stderr}` }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string }
    return { ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}${e.message}` }
  }
}
```

`src/main/config/reload.ts`：

```ts
export async function reloadConfig(
  controllerPort: number,
  secret: string,
  configPath: string,
  fetchFn: typeof fetch = fetch
): Promise<{ ok: boolean; status: number }> {
  try {
    const res = await fetchFn(`http://127.0.0.1:${controllerPort}/configs?force=true`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${secret}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ path: configPath }),
      signal: AbortSignal.timeout(10_000)
    })
    return { ok: res.ok, status: res.status }
  } catch {
    return { ok: false, status: 0 }
  }
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `npm test -- src/main/config/validate.test.ts src/main/config/reload.test.ts`
Expected: PASS（4 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/main/config/validate.ts src/main/config/reload.ts src/main/config/validate.test.ts src/main/config/reload.test.ts
git commit -m "feat(config): mihomo -t 校验与 PUT /configs 热重载"
```

---

### Task 7: 假内核与进程守护

**Files:**
- Create: `test/fixtures/fake-mihomo.mjs`, `src/main/core/supervisor.ts`, `src/main/core/supervisor.test.ts`

**Interfaces:**
- Produces:
  - `interface CoreSupervisorOptions { binary: string; homeDir: string; configPath: string; controllerPort: number; secret: string; argsPrefix?: string[]; env?: Record<string, string>; spawn?: typeof import('node:child_process').spawn; fetchFn?: typeof fetch }`
  - `class CoreSupervisor { start(): Promise<CoreInfo>; stop(): Promise<void>; checkHealth(): Promise<boolean>; readonly status: CoreStatus }`

- [ ] **Step 1: 写假内核**

`test/fixtures/fake-mihomo.mjs`：

```js
#!/usr/bin/env node
import http from 'node:http'

const args = process.argv.slice(2)
const get = (flag) => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

if (args.includes('-t')) {
  const file = get('-f')
  const fs = await import('node:fs')
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  if (text.includes('__INVALID__')) { console.error('parse error'); process.exit(1) }
  console.log('configuration file test is successful')
  process.exit(0)
}

const controller = get('-f') ? process.env.FAKE_CONTROLLER : undefined
const port = Number(process.env.FAKE_PORT ?? 0)
const secret = process.env.FAKE_SECRET ?? ''
if (process.env.FAKE_CRASH_AFTER_MS) {
  setTimeout(() => process.exit(1), Number(process.env.FAKE_CRASH_AFTER_MS))
}

const server = http.createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${secret}`) {
    res.writeHead(401).end()
    return
  }
  if (req.url === '/version') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ version: 'v1.19.32-fake', meta: true }))
    return
  }
  res.writeHead(404).end()
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`listening ${server.address().port}\n`)
})

process.on('SIGTERM', () => server.close(() => process.exit(0)))
```

- [ ] **Step 2: 写失败测试**

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { allocatePort } from './ports'
import { newSecret } from './secret'
import { CoreSupervisor } from './supervisor'

const running: CoreSupervisor[] = []
afterEach(async () => { await Promise.all(running.splice(0).map((s) => s.stop())) })

async function makeSupervisor() {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'aether-core-'))
  const controllerPort = await allocatePort()
  const secret = newSecret()
  const sup = new CoreSupervisor({
    binary: process.execPath,
    homeDir,
    configPath: path.join(homeDir, 'runtime.yaml'),
    controllerPort,
    secret,
    env: { FAKE_PORT: String(controllerPort), FAKE_SECRET: secret },
    argsPrefix: ['test/fixtures/fake-mihomo.mjs']
  })
  running.push(sup)
  return sup
}

describe('CoreSupervisor', () => {
  it('启动后握手成功并返回信息', async () => {
    const sup = await makeSupervisor()
    const info = await sup.start()
    expect(info.controllerPort).toBeGreaterThan(0)
    expect(info.version).toContain('v1.19.32')
    expect(sup.status).toBe('running')
  })

  it('stop 之后进程不存在', async () => {
    const sup = await makeSupervisor()
    const info = await sup.start()
    await sup.stop()
    expect(sup.status).toBe('stopped')
    expect(() => process.kill(info.pid, 0)).toThrow()
  })

  it('连续 3 次健康检查失败进入 error', async () => {
    let calls = 0
    const fetchFn = (async () => {
      calls += 1
      if (calls <= 2) return new Response(JSON.stringify({ version: 'x' }), { status: 200 })
      return new Response('nope', { status: 401 })
    }) as any
    const homeDir = await mkdtemp(path.join(tmpdir(), 'aether-core-'))
    const controllerPort = await allocatePort()
    const sup = new CoreSupervisor({
      binary: process.execPath,
      homeDir,
      configPath: path.join(homeDir, 'runtime.yaml'),
      controllerPort,
      secret: 's',
      env: { FAKE_PORT: String(controllerPort), FAKE_SECRET: 's' },
      argsPrefix: ['test/fixtures/fake-mihomo.mjs'],
      fetchFn
    })
    running.push(sup)
    await sup.start()
    await sup.checkHealth()
    await sup.checkHealth()
    await sup.checkHealth()
    expect(sup.status).toBe('error')
  })

  it('二进制不存在时 start 拒绝而不是崩溃', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'aether-core-'))
    const sup = new CoreSupervisor({
      binary: 'aether-no-such-binary-xyz',
      homeDir,
      configPath: path.join(homeDir, 'runtime.yaml'),
      controllerPort: 1,
      secret: 's'
    })
    await expect(sup.start()).rejects.toThrow()
    expect(sup.status).toBe('stopped')
  })
})
```

- [ ] **Step 3: 运行，确认失败**

Run: `npm test -- src/main/core/supervisor.test.ts`
Expected: FAIL，`Cannot find module './supervisor'`

- [ ] **Step 4: 实现**

```ts
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import type { CoreInfo, CoreStatus } from '../../shared/types'

export interface CoreSupervisorOptions {
  binary: string
  homeDir: string
  configPath: string
  controllerPort: number
  secret: string
  argsPrefix?: string[]
  env?: Record<string, string>
  spawn?: typeof nodeSpawn
  fetchFn?: typeof fetch
}

export class CoreSupervisor {
  private child: ChildProcess | null = null
  private state: CoreStatus = 'stopped'
  private failures = 0
  private readonly spawnFn: typeof nodeSpawn
  private readonly fetchFn: typeof fetch

  constructor(private readonly opts: CoreSupervisorOptions) {
    this.spawnFn = opts.spawn ?? nodeSpawn
    this.fetchFn = opts.fetchFn ?? fetch
  }

  get status(): CoreStatus { return this.state }

  async start(): Promise<CoreInfo> {
    this.state = 'starting'
    const args = [
      ...(this.opts.argsPrefix ?? []),
      '-d', this.opts.homeDir,
      '-f', this.opts.configPath
    ]
    const child = this.spawnFn(this.opts.binary, args, {
      env: { ...process.env, ...this.opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.child = child
    let spawnError: Error | null = null
    child.once('error', (err) => {
      spawnError = err
      this.state = 'error'
    })
    child.once('exit', () => {
      if (this.state !== 'stopped') this.state = 'error'
      this.child = null
    })

    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      if (spawnError) {
        await this.stop()
        throw spawnError
      }
      if (await this.checkHealth()) {
        this.failures = 0
        let version = 'unknown'
        try {
          version = await this.version()
        } catch {
          version = 'unknown'
        }
        this.state = 'running'
        return {
          pid: child.pid ?? -1,
          version,
          controllerPort: this.opts.controllerPort,
          startedAt: Date.now()
        }
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    await this.stop()
    throw new Error('内核握手超时')
  }

  async checkHealth(): Promise<boolean> {
    try {
      const res = await this.fetchFn(`http://127.0.0.1:${this.opts.controllerPort}/version`, {
        headers: { authorization: `Bearer ${this.opts.secret}` },
        signal: AbortSignal.timeout(1500)
      })
      if (!res.ok) {
        this.markFailure()
        return false
      }
      this.failures = 0
      return true
    } catch {
      this.markFailure()
      return false
    }
  }

  private markFailure(): void {
    this.failures += 1
    if (this.failures >= 3 && this.state === 'running') this.state = 'error'
  }

  private async version(): Promise<string> {
    const res = await this.fetchFn(`http://127.0.0.1:${this.opts.controllerPort}/version`, {
      headers: { authorization: `Bearer ${this.opts.secret}` },
      signal: AbortSignal.timeout(1500)
    })
    const body = (await res.json()) as { version?: string }
    return body.version ?? 'unknown'
  }

  async stop(): Promise<void> {
    const child = this.child
    this.state = 'stopped'
    this.child = null
    if (!child || child.exitCode !== null) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 3000)
      child.once('exit', () => { clearTimeout(timer); resolve() })
      child.kill('SIGTERM')
    })
  }
}
```

- [ ] **Step 5: 运行，确认通过**

Run: `npm test -- src/main/core/supervisor.test.ts`
Expected: PASS（2 个用例）

- [ ] **Step 6: 提交**

```bash
git add test/fixtures/fake-mihomo.mjs src/main/core/supervisor.ts src/main/core/supervisor.test.ts
git commit -m "feat(core): 内核进程守护与握手"
```

---

### Task 7A: 二进制路径解析与崩溃重启集成

**Files:**
- Create: `src/main/core/binary.ts`, `src/main/core/restarter.ts`, `src/main/core/binary.test.ts`, `src/main/core/restarter.test.ts`

**Interfaces:**
- Produces:
  - `resolveMihomoBinary(input: { isPackaged: boolean; resourcesPath: string; repoRoot: string }): string`
  - `class CoreRestarter { constructor(opts: { start(): Promise<unknown>; now?: () => number; schedule?: (fn: () => void, ms: number) => void; policy?: RestartPolicy; onGiveUp?: () => void; onStartError?: (err: unknown) => void }); notifyExit(): { scheduled: boolean; delayMs?: number }; readonly attempts: number[] }`

- [ ] **Step 1: 写失败测试**

`src/main/core/binary.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { resolveMihomoBinary } from './binary'

describe('resolveMihomoBinary', () => {
  it('开发态用仓库 vendor 目录', () => {
    const p = resolveMihomoBinary({ isPackaged: false, resourcesPath: '/res', repoRoot: '/repo' })
    expect(p).toBe(path.join('/repo', 'vendor', 'mihomo.exe'))
  })

  it('打包态用 resources 目录', () => {
    const p = resolveMihomoBinary({ isPackaged: true, resourcesPath: '/res', repoRoot: '/repo' })
    expect(p).toBe(path.join('/res', 'mihomo', 'mihomo.exe'))
  })
})
```

`src/main/core/restarter.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest'
import { CoreRestarter } from './restarter'

describe('CoreRestarter', () => {
  it('首次退出按 1s 调度重启', async () => {
    const schedule = vi.fn()
    const r = new CoreRestarter({ start: vi.fn(async () => ({})), schedule, now: () => 1000 })
    expect(r.notifyExit()).toEqual({ scheduled: true, delayMs: 1000 })
    expect(schedule).toHaveBeenCalledOnce()
  })

  it('10 分钟内第 4 次退出不再调度', () => {
    let now = 0
    const schedule = vi.fn()
    const onGiveUp = vi.fn()
    const r = new CoreRestarter({ start: vi.fn(async () => ({})), schedule, now: () => now, onGiveUp })
    now = 1000; expect(r.notifyExit().scheduled).toBe(true)
    now = 2000; expect(r.notifyExit().scheduled).toBe(true)
    now = 3000; expect(r.notifyExit().scheduled).toBe(true)
    now = 4000; expect(r.notifyExit()).toEqual({ scheduled: false })
    expect(schedule).toHaveBeenCalledTimes(3)
    expect(onGiveUp).toHaveBeenCalledOnce()
  })

  it('重启失败不产生未处理拒绝，并回调 onStartError', async () => {
    const onStartError = vi.fn()
    let scheduled: (() => void) | null = null
    const r = new CoreRestarter({
      start: vi.fn(async () => { throw new Error('boom') }),
      now: () => 0,
      schedule: (fn) => { scheduled = fn },
      onStartError
    })
    r.notifyExit()
    scheduled!()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(onStartError).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `npm test -- src/main/core/binary.test.ts src/main/core/restarter.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`src/main/core/binary.ts`：

```ts
import path from 'node:path'

export function resolveMihomoBinary(input: {
  isPackaged: boolean
  resourcesPath: string
  repoRoot: string
}): string {
  return input.isPackaged
    ? path.join(input.resourcesPath, 'mihomo', 'mihomo.exe')
    : path.join(input.repoRoot, 'vendor', 'mihomo.exe')
}
```

`src/main/core/restarter.ts`：

```ts
import { nextRestart, type RestartPolicy } from './backoff'

export interface RestarterOptions {
  start(): Promise<unknown>
  now?: () => number
  schedule?: (fn: () => void, ms: number) => void
  policy?: RestartPolicy
  onGiveUp?: () => void
  onStartError?: (err: unknown) => void
}

export class CoreRestarter {
  private readonly now: () => number
  private readonly schedule: (fn: () => void, ms: number) => void
  readonly attempts: number[] = []

  constructor(private readonly opts: RestarterOptions) {
    this.now = opts.now ?? Date.now
    this.schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms))
  }

  notifyExit(): { scheduled: boolean; delayMs?: number } {
    const now = this.now()
    const decision = nextRestart(this.attempts, now, this.opts.policy)
    if (!decision) {
      this.opts.onGiveUp?.()
      return { scheduled: false }
    }
    this.attempts.push(now)
    this.schedule(() => {
      void this.opts.start().catch((err) => { this.opts.onStartError?.(err) })
    }, decision.delayMs)
    return { scheduled: true, delayMs: decision.delayMs }
  }
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `npm test -- src/main/core/binary.test.ts src/main/core/restarter.test.ts`
Expected: PASS（4 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/main/core/binary.ts src/main/core/restarter.ts src/main/core/binary.test.ts src/main/core/restarter.test.ts
git commit -m "feat(core): 二进制路径解析与重启调度接入"
```

---

### Task 8: 孤儿内核识别

**Files:**
- Create: `src/main/core/orphan.ts`, `src/main/core/orphan.test.ts`

**Interfaces:**
- Produces: `classifyOrphan(input: { port: number; oldSecret: string; fetchFn?: typeof fetch }): Promise<'ours' | 'foreign' | 'none'>`
- 判定依据是**旧 secret 是否被接受**：mihomo 的 `/version` 不返回配置哈希，但只有我们上次启动的内核知道这个 128 位随机 secret。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, vi } from 'vitest'
import { classifyOrphan } from './orphan'

function fakeFetch(status: number, body: unknown = {}) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }))
}

describe('classifyOrphan', () => {
  it('旧 secret 通过 → ours', async () => {
    const fetchFn = fakeFetch(200, { version: 'v1.19.32' })
    const kind = await classifyOrphan({ port: 5000, oldSecret: 's', fetchFn: fetchFn as any })
    expect(kind).toBe('ours')
  })

  it('401 → foreign', async () => {
    const fetchFn = fakeFetch(401)
    const kind = await classifyOrphan({ port: 5000, oldSecret: 's', fetchFn: fetchFn as any })
    expect(kind).toBe('foreign')
  })

  it('404 → foreign', async () => {
    const fetchFn = fakeFetch(404)
    const kind = await classifyOrphan({ port: 5000, oldSecret: 's', fetchFn: fetchFn as any })
    expect(kind).toBe('foreign')
  })

  it('连接被拒 → none', async () => {
    const fetchFn = vi.fn(async () => { throw new Error('ECONNREFUSED') })
    const kind = await classifyOrphan({ port: 5000, oldSecret: 's', fetchFn: fetchFn as any })
    expect(kind).toBe('none')
  })

  it('只对 /version 发 GET，并带 Bearer 头', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 200 }))
    await classifyOrphan({ port: 5000, oldSecret: 's', fetchFn: fetchFn as any })
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit]
    expect(String(url)).toBe('http://127.0.0.1:5000/version')
    expect(init.method ?? 'GET').toBe('GET')
    expect(init.headers).toMatchObject({ authorization: 'Bearer s' })
  })

  it('500 → foreign', async () => {
    const fetchFn = fakeFetch(500)
    const kind = await classifyOrphan({ port: 5000, oldSecret: 's', fetchFn: fetchFn as any })
    expect(kind).toBe('foreign')
  })
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `npm test -- src/main/core/orphan.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
export interface OrphanInput {
  port: number
  oldSecret: string
  fetchFn?: typeof fetch
}

export async function classifyOrphan(input: OrphanInput): Promise<'ours' | 'foreign' | 'none'> {
  const fetchFn = input.fetchFn ?? fetch
  let res: Response
  try {
    res = await fetchFn(`http://127.0.0.1:${input.port}/version`, {
      headers: { authorization: `Bearer ${input.oldSecret}` },
      signal: AbortSignal.timeout(1500)
    })
  } catch {
    // 超时同样落到 none：调用方不能把 none 当成"端口空闲"，应另选端口。
    return 'none'
  }
  return res.ok ? 'ours' : 'foreign'
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `npm test -- src/main/core/orphan.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/main/core/orphan.ts src/main/core/orphan.test.ts
git commit -m "feat(core): 孤儿内核判定（仅凭旧 secret）"
```

---

### Task 9: 平台代理接口与所有权快照

**Files:**
- Create: `src/main/proxy/platform.ts`, `src/main/proxy/fake.ts`, `src/main/proxy/ownership.ts`, `src/main/proxy/ownership.test.ts`

**Interfaces:**
- Produces:
  - `interface PlatformProxy { getSystemProxy(): Promise<ProxyState>; setSystemProxy(opts: { server: string; bypass: string[] }): Promise<void>; clearSystemProxy(): Promise<void>; restore(state: ProxyState): Promise<void> }`
  - `class ProxyOwnership { snapshotBeforeApply(state: ProxyState, appliedServer: string): Promise<void>; restoreOnStartupIfStale(): Promise<'none' | 'restored' | 'conflict'>; restoreOnExit(): Promise<void> }`
- Consumes: `ProxyState` from `src/shared/types.ts`。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FakePlatformProxy } from './fake'
import { ProxyOwnership } from './ownership'

let dir: string
let pp: FakePlatformProxy
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'aether-proxy-'))
  pp = new FakePlatformProxy({
    enabled: true,
    server: 'corp:8080',
    bypass: ['*.corp.local'],
    autoConfigUrl: 'http://pac.local/proxy.pac',
    autoDetect: false
  })
})

describe('ProxyOwnership', () => {
  it('快照包含 PAC 字段并落盘', async () => {
    const own = new ProxyOwnership(pp, path.join(dir, 'proxy-state.json'))
    await own.snapshotBeforeApply(await pp.getSystemProxy(), '127.0.0.1:5566')
    const saved = JSON.parse(await readFile(path.join(dir, 'proxy-state.json'), 'utf8'))
    expect(saved.autoConfigUrl).toBe('http://pac.local/proxy.pac')
    expect(saved.owner).toBe('aether')
  })

  it('正常退出按快照完整还原', async () => {
    const own = new ProxyOwnership(pp, path.join(dir, 'proxy-state.json'))
    const before = await pp.getSystemProxy()
    await own.snapshotBeforeApply(before, '127.0.0.1:5566')
    await pp.setSystemProxy({ server: '127.0.0.1:5566', bypass: ['localhost', '127.0.0.0/8'] })
    await own.restoreOnExit()
    expect(await pp.getSystemProxy()).toEqual(before)
  })

  it('启动时发现残留且状态未被改动 → restored', async () => {
    const stateFile = path.join(dir, 'proxy-state.json')
    const first = new ProxyOwnership(pp, stateFile)
    await first.snapshotBeforeApply(await pp.getSystemProxy(), '127.0.0.1:5566')
    await pp.setSystemProxy({ server: '127.0.0.1:5566', bypass: [] })

    const second = new ProxyOwnership(pp, stateFile)
    expect(await second.restoreOnStartupIfStale()).toBe('restored')
    expect((await pp.getSystemProxy()).server).toBe('corp:8080')
  })

  it('状态被他人修改 → conflict，且不覆盖', async () => {
    const stateFile = path.join(dir, 'proxy-state.json')
    const first = new ProxyOwnership(pp, stateFile)
    await first.snapshotBeforeApply(await pp.getSystemProxy(), '127.0.0.1:5566')
    await pp.setSystemProxy({ server: '127.0.0.1:5566', bypass: [] })
    await pp.setSystemProxy({ server: 'other:9999', bypass: [] })

    const second = new ProxyOwnership(pp, stateFile)
    expect(await second.restoreOnStartupIfStale()).toBe('conflict')
    expect((await pp.getSystemProxy()).server).toBe('other:9999')
  })

  it('快照不属于 Aether 时忽略并返回 none', async () => {
    const stateFile = path.join(dir, 'proxy-state.json')
    await writeFile(stateFile, JSON.stringify({ owner: 'someone-else', enabled: true }), 'utf8')
    const own = new ProxyOwnership(pp, stateFile)
    expect(await own.restoreOnStartupIfStale()).toBe('none')
  })

  it('已有快照时重复调用不会覆盖原状态', async () => {
    const own = new ProxyOwnership(pp, path.join(dir, 'proxy-state.json'))
    await own.snapshotBeforeApply(await pp.getSystemProxy(), '127.0.0.1:5566')
    await pp.setSystemProxy({ server: '127.0.0.1:5566', bypass: [] })
    await own.snapshotBeforeApply(await pp.getSystemProxy(), '127.0.0.1:5566')
    await own.restoreOnExit()
    expect((await pp.getSystemProxy()).server).toBe('corp:8080')
  })

  it('退出时若代理已被他人修改则不覆盖', async () => {
    const own = new ProxyOwnership(pp, path.join(dir, 'proxy-state.json'))
    await own.snapshotBeforeApply(await pp.getSystemProxy(), '127.0.0.1:5566')
    await pp.setSystemProxy({ server: '127.0.0.1:5566', bypass: [] })
    await pp.setSystemProxy({ server: 'other:9999', bypass: [] })
    await own.restoreOnExit()
    expect((await pp.getSystemProxy()).server).toBe('other:9999')
  })
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `npm test -- src/main/proxy/ownership.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现平台接口与假实现**

`src/main/proxy/platform.ts`：

```ts
import type { ProxyState } from '../../shared/types'

export interface PlatformProxy {
  getSystemProxy(): Promise<ProxyState>
  setSystemProxy(opts: { server: string; bypass: string[] }): Promise<void>
  clearSystemProxy(): Promise<void>
  restore(state: ProxyState): Promise<void>
}
```

`src/main/proxy/fake.ts`：

```ts
import type { ProxyState } from '../../shared/types'
import type { PlatformProxy } from './platform'

export class FakePlatformProxy implements PlatformProxy {
  constructor(private state: ProxyState) {}

  async getSystemProxy(): Promise<ProxyState> {
    return structuredClone(this.state)
  }

  async setSystemProxy(opts: { server: string; bypass: string[] }): Promise<void> {
    this.state = { enabled: true, server: opts.server, bypass: [...opts.bypass] }
  }

  async clearSystemProxy(): Promise<void> {
    this.state = { enabled: false }
  }

  async restore(state: ProxyState): Promise<void> {
    this.state = structuredClone(state)
  }
}
```

- [ ] **Step 4: 实现所有权**

`src/main/proxy/ownership.ts`：

```ts
import { readFile, rm } from 'node:fs/promises'
import type { ProxyState } from '../../shared/types'
import type { PlatformProxy } from './platform'
import { writeFileAtomic } from '../config/atomic'

interface SavedState extends ProxyState {
  owner: 'aether'
  pid: number
  at: number
  appliedServer: string
}

export class ProxyOwnership {
  constructor(
    private readonly pp: PlatformProxy,
    private readonly stateFile: string,
    private readonly now: () => number = Date.now,
    private readonly pid: number = process.pid
  ) {}

  async snapshotBeforeApply(state: ProxyState, appliedServer: string): Promise<void> {
    // 已有本应用的快照时不再覆盖：第二次调用拿到的"原状态"已经是 Aether 写入的地址。
    if (await this.hasSnapshot()) return
    const saved: SavedState = { ...state, owner: 'aether', pid: this.pid, at: this.now(), appliedServer }
    await writeFileAtomic(this.stateFile, JSON.stringify(saved, null, 2))
  }

  private async load(): Promise<SavedState | null> {
    try {
      const parsed = JSON.parse(await readFile(this.stateFile, 'utf8')) as SavedState
      return parsed.owner === 'aether' ? parsed : null
    } catch {
      return null
    }
  }

  async restoreOnStartupIfStale(): Promise<'none' | 'restored' | 'conflict'> {
    const saved = await this.load()
    if (!saved) return 'none'
    const current = await this.pp.getSystemProxy()
    const untouched = current.enabled === true && current.server === saved.appliedServer
    if (!untouched) {
      await rm(this.stateFile, { force: true })
      return 'conflict'
    }
    await this.pp.restore(toProxyState(saved))
    await rm(this.stateFile, { force: true })
    return 'restored'
  }

  async restoreOnExit(): Promise<void> {
    const saved = await this.load()
    if (!saved) return
    const current = await this.pp.getSystemProxy()
    // 会话期间若别的程序改了代理，不要覆盖它；只清理自己的标记。
    if (current.enabled && current.server === saved.appliedServer) {
      await this.pp.restore(toProxyState(saved))
    }
    await rm(this.stateFile, { force: true })
  }
}
```

- [ ] **Step 5: 运行，确认通过**

Run: `npm test -- src/main/proxy/ownership.test.ts`
Expected: PASS（4 个用例）

- [ ] **Step 6: 提交**

```bash
git add src/main/proxy
git commit -m "feat(proxy): 平台代理接口与所有权快照/还原"
```

---

### Task 9A: 系统代理控制器（快照与切换的顺序保证）

**Files:**
- Create: `src/main/proxy/controller.ts`, `src/main/proxy/controller.test.ts`
- Modify: `src/main/proxy/ownership.ts`（新增 `hasSnapshot()`）

**Interfaces:**
- Consumes: `PlatformProxy`、`ProxyOwnership`
- Produces: `class SystemProxyController { constructor(pp: PlatformProxy, ownership: ProxyOwnership); enable(server: string): Promise<void>; disable(): Promise<void> }`
- `DEFAULT_BYPASS = ['localhost', '127.0.0.0/8', '::1', '<local>']`
- `enable` 的顺序固定：读取当前状态 → **若没有快照则先落盘** → 再设置代理。重复调用不得把 Aether 自己写入的地址当成"原状态"保存。

- [ ] **Step 1: 给 `ProxyOwnership` 加 `hasSnapshot()`**

在 `src/main/proxy/ownership.ts` 的类里新增：

```ts
  async hasSnapshot(): Promise<boolean> {
    return (await this.load()) !== null
  }

  async getAppliedServer(): Promise<string | null> {
    return (await this.load())?.appliedServer ?? null
  }

  async repointAppliedServer(server: string): Promise<void> {
    const saved = await this.load()
    if (!saved) return
    await writeFileAtomic(this.stateFile, JSON.stringify({ ...saved, appliedServer: server }, null, 2))
  }
```

- [ ] **Step 2: 写失败测试**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FakePlatformProxy } from './fake'
import { ProxyOwnership } from './ownership'
import { SystemProxyController } from './controller'

let dir: string
let pp: FakePlatformProxy
let ownership: ProxyOwnership
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'aether-ctl-'))
  pp = new FakePlatformProxy({ enabled: true, server: 'corp:8080', bypass: ['*.corp.local'] })
  ownership = new ProxyOwnership(pp, path.join(dir, 'proxy-state.json'))
})

describe('SystemProxyController', () => {
  it('enable 先落快照再设置代理，disable 后恢复原值', async () => {
    const ctl = new SystemProxyController(pp, ownership)
    await ctl.enable('127.0.0.1:5566')
    expect((await pp.getSystemProxy()).server).toBe('127.0.0.1:5566')
    await ctl.disable()
    expect((await pp.getSystemProxy()).server).toBe('corp:8080')
  })

  it('重复 enable 不会把 Aether 的地址写成新快照', async () => {
    const ctl = new SystemProxyController(pp, ownership)
    await ctl.enable('127.0.0.1:5566')
    await ctl.enable('127.0.0.1:5566')
    await ctl.disable()
    expect((await pp.getSystemProxy()).server).toBe('corp:8080')
  })

  it('bypass 使用固定的回环与局域网列表', async () => {
    const ctl = new SystemProxyController(pp, ownership)
    await ctl.enable('127.0.0.1:5566')
    expect((await pp.getSystemProxy()).bypass).toEqual(['localhost', '127.0.0.0/8', '::1', '<local>'])
  })

  it('切换端口后仍能在退出时还原原状态', async () => {
    const ctl = new SystemProxyController(pp, ownership)
    await ctl.enable('127.0.0.1:5566')
    await ctl.enable('127.0.0.1:7890')
    await ctl.disable()
    expect((await pp.getSystemProxy()).server).toBe('corp:8080')
  })
})
```

- [ ] **Step 3: 运行，确认失败**

Run: `npm test -- src/main/proxy/controller.test.ts`
Expected: FAIL，`Cannot find module './controller'`

- [ ] **Step 4: 实现**

```ts
import type { PlatformProxy } from './platform'
import type { ProxyOwnership } from './ownership'

export const DEFAULT_BYPASS = ['localhost', '127.0.0.0/8', '::1', '<local>'] as const

export class SystemProxyController {
  constructor(
    private readonly pp: PlatformProxy,
    private readonly ownership: ProxyOwnership
  ) {}

  async enable(server: string): Promise<void> {
    const current = await this.pp.getSystemProxy()
    if (!(await this.ownership.hasSnapshot())) {
      await this.ownership.snapshotBeforeApply(current, server)
    } else {
      const applied = await this.ownership.getAppliedServer()
      if (applied !== null && applied !== server) {
        await this.ownership.repointAppliedServer(server)
      }
    }
    await this.pp.setSystemProxy({ server, bypass: [...DEFAULT_BYPASS] })
  }

  async disable(): Promise<void> {
    await this.ownership.restoreOnExit()
  }
}
```

- [ ] **Step 5: 运行，确认通过**

Run: `npm test -- src/main/proxy/controller.test.ts src/main/proxy/ownership.test.ts`
Expected: 全部 PASS

- [ ] **Step 6: 提交**

```bash
git add src/main/proxy/controller.ts src/main/proxy/controller.test.ts src/main/proxy/ownership.ts
git commit -m "feat(proxy): 系统代理控制器保证快照先于切换"
```

---

### Task 10: Windows 原生层（koffi Node-FFI）

**Files:**
- Create: `src/main/proxy/win32.ts`, `scripts/proxy-check.mjs`
- Modify: `package.json`（新增 `koffi` 与 `tsx`）

**Interfaces:**
- Produces: `loadWindowsProxy(): PlatformProxy`，实现与 Task 9 相同的四个方法。
- 决策变更：D20 由 Rust + napi-rs 改为 koffi，见 `docs/design/2026-10-26-native-proxy-koffi.md`。

- [ ] **Step 1: 安装依赖**

Run: `npm i koffi && npm i -D tsx`
Expected: `package.json` 的 dependencies 中出现 `koffi`，devDependencies 中出现 `tsx`；安装成功。

- [ ] **Step 2: 实现 win32.ts**

```ts
import koffi from 'koffi'
import type { ProxyState } from '../../shared/types'
import type { PlatformProxy } from './platform'

const HKEY_CURRENT_USER = 0x80000001
const KEY_QUERY_VALUE = 0x0001
const KEY_SET_VALUE = 0x0002
const REG_SZ = 1
const REG_EXPAND_SZ = 2
const REG_DWORD = 4
const INTERNET_OPTION_REFRESH = 37
const INTERNET_OPTION_SETTINGS_CHANGED = 39
const SUBKEY = 'Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

const advapi = koffi.load('advapi32.dll')
const wininet = koffi.load('wininet.dll')

const RegOpenKeyExW = advapi.func(
  'int RegOpenKeyExW(uintptr_t hKey, str16 lpSubKey, uint32 ulOptions, uint32 samDesired, _Out_ uintptr_t *phkResult)'
)
const RegCloseKey = advapi.func('int RegCloseKey(uintptr_t hKey)')
const RegQueryValueExW = advapi.func(
  'int RegQueryValueExW(uintptr_t hKey, str16 lpValueName, void *lpReserved, _Out_ uint32 *lpType, _Out_ uint8 *lpData, _Inout_ uint32 *lpcbData)'
)
const RegSetValueExW = advapi.func(
  'int RegSetValueExW(uintptr_t hKey, str16 lpValueName, uint32 Reserved, uint32 dwType, uint8 *lpData, uint32 cbData)'
)
const RegDeleteValueW = advapi.func('int RegDeleteValueW(uintptr_t hKey, str16 lpValueName)')
const InternetSetOptionW = wininet.func(
  'int InternetSetOptionW(void *hInternet, uint32 dwOption, void *lpBuffer, uint32 dwBufferLength)'
)

function openKey(): number {
  const out = [0]
  const rc = RegOpenKeyExW(HKEY_CURRENT_USER, SUBKEY, 0, KEY_QUERY_VALUE | KEY_SET_VALUE, out)
  if (rc !== 0) throw new Error(`RegOpenKeyExW 失败：${rc}`)
  return out[0] as number
}

function readRaw(hkey: number, name: string): { type: number; data: Buffer } | null {
  const type = [0]
  const size = [4096]
  const buf = Buffer.alloc(4096)
  const rc = RegQueryValueExW(hkey, name, null, type, buf, size)
  if (rc !== 0) return null
  const bytes = size[0] as number
  return { type: type[0] as number, data: buf.subarray(0, bytes) }
}

function readString(hkey: number, name: string): string | undefined {
  const raw = readRaw(hkey, name)
  if (!raw || (raw.type !== REG_SZ && raw.type !== REG_EXPAND_SZ)) return undefined
  return raw.data.toString('utf16le').replace(/\0+$/, '')
}

function readDword(hkey: number, name: string): number | undefined {
  const raw = readRaw(hkey, name)
  if (!raw || raw.type !== REG_DWORD || raw.data.length < 4) return undefined
  return raw.data.readUInt32LE(0)
}

function writeString(hkey: number, name: string, value: string): void {
  const data = Buffer.from(`${value}\0`, 'utf16le')
  const rc = RegSetValueExW(hkey, name, 0, REG_SZ, data, data.length)
  if (rc !== 0) throw new Error(`写入 ${name} 失败：${rc}`)
}

function writeDword(hkey: number, name: string, value: number): void {
  const data = Buffer.alloc(4)
  data.writeUInt32LE(value)
  const rc = RegSetValueExW(hkey, name, 0, REG_DWORD, data, 4)
  if (rc !== 0) throw new Error(`写入 ${name} 失败：${rc}`)
}

function broadcast(): void {
  InternetSetOptionW(null, INTERNET_OPTION_SETTINGS_CHANGED, null, 0)
  InternetSetOptionW(null, INTERNET_OPTION_REFRESH, null, 0)
}

export function loadWindowsProxy(): PlatformProxy {
  return {
    async getSystemProxy(): Promise<ProxyState> {
      const hkey = openKey()
      try {
        const bypass = readString(hkey, 'ProxyOverride')
        return {
          enabled: readDword(hkey, 'ProxyEnable') === 1,
          server: readString(hkey, 'ProxyServer'),
          bypass: bypass ? bypass.split(';').filter(Boolean) : undefined,
          autoConfigUrl: readString(hkey, 'AutoConfigURL'),
          autoDetect: readDword(hkey, 'AutoDetect') === 1
        }
      } finally {
        RegCloseKey(hkey)
      }
    },

    async setSystemProxy({ server, bypass }) {
      const hkey = openKey()
      try {
        writeDword(hkey, 'ProxyEnable', 1)
        writeString(hkey, 'ProxyServer', server)
        writeString(hkey, 'ProxyOverride', bypass.join(';'))
        RegDeleteValueW(hkey, 'AutoConfigURL')
        writeDword(hkey, 'AutoDetect', 0)
      } finally {
        RegCloseKey(hkey)
      }
      broadcast()
    },

    async clearSystemProxy() {
      const hkey = openKey()
      try {
        writeDword(hkey, 'ProxyEnable', 0)
      } finally {
        RegCloseKey(hkey)
      }
      broadcast()
    },

    async restore(state) {
      const hkey = openKey()
      try {
        writeDword(hkey, 'ProxyEnable', state.enabled ? 1 : 0)
        if (state.server) writeString(hkey, 'ProxyServer', state.server)
        if (state.bypass) writeString(hkey, 'ProxyOverride', state.bypass.join(';'))
        if (state.autoConfigUrl) writeString(hkey, 'AutoConfigURL', state.autoConfigUrl)
        else RegDeleteValueW(hkey, 'AutoConfigURL')
        writeDword(hkey, 'AutoDetect', state.autoDetect ? 1 : 0)
      } finally {
        RegCloseKey(hkey)
      }
      broadcast()
    }
  }
}
```

- [ ] **Step 3: 写真实往返脚本**

`scripts/proxy-check.mjs`：

```js
import { execFileSync } from 'node:child_process'

const { loadWindowsProxy } = await import('../src/main/proxy/win32.ts')
const pp = loadWindowsProxy()

const RAW_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
const dumpRaw = () => execFileSync('reg', ['query', RAW_KEY], { encoding: 'utf8' })

const before = await pp.getSystemProxy()
console.log('before', before)
const rawBefore = dumpRaw()

try {
  await pp.setSystemProxy({ server: '127.0.0.1:5566', bypass: ['localhost', '127.0.0.0/8'] })
  const during = await pp.getSystemProxy()
  console.log('during', during)
  if (!during.enabled || during.server !== '127.0.0.1:5566') throw new Error('设置未生效')
  if (during.autoConfigUrl !== undefined) throw new Error('PAC 未被清除')
} finally {
  await pp.restore(before)
  const after = await pp.getSystemProxy()
  const rawAfter = dumpRaw()
  console.log('after', after)
  console.log('--- raw before ---')
  console.log(rawBefore)
  console.log('--- raw after ---')
  console.log(rawAfter)
  if (after.enabled !== before.enabled || after.server !== before.server) throw new Error('还原失败')
}

console.log('proxy-check ok')
```

- [ ] **Step 4: 运行真机验证**

Run: `npx tsx scripts/proxy-check.mjs`
Expected: 依次打印 `before` / `during` / `after` 与两段原始注册表输出；`during` 指向 `127.0.0.1:5566` 且无 PAC；`after` 与原值一致；最后 `proxy-check ok`。**全程不应出现 UAC 弹窗。** 若失败，必须先手动还原代理再报告。

- [ ] **Step 5: 提交**

```bash
git add package.json package-lock.json src/main/proxy/win32.ts scripts/proxy-check.mjs
git commit -m "feat(proxy): koffi 实现 Windows 系统代理读写"
```

### Task 11: 启动与退出编排

**Files:**
- Create: `src/main/lifecycle.ts`, `src/main/lifecycle.test.ts`

**Interfaces:**
- Produces:
  - `startup(deps: StartupDeps): Promise<StartupResult>`，`StartupResult = { status: 'ready' | 'config-error' | 'core-error'; restore: 'none' | 'restored' | 'conflict' }`
  - `shutdown(deps: ShutdownDeps): Promise<void>`
  - `StartupDeps = { ownership, loadConfig(): Promise<{ ok: boolean; error?: string }>, core: { start(): Promise<unknown> }, proxy: { enable(server: string): Promise<void>; disable(): Promise<void> }, server: string, lastProxyEnabled: boolean }`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, vi } from 'vitest'
import { startup, shutdown } from './lifecycle'

function deps(overrides: Partial<Parameters<typeof startup>[0]> = {}) {
  const calls: string[] = []
  return {
    calls,
    ownership: {
      restoreOnStartupIfStale: vi.fn(async () => { calls.push('restore'); return 'none' as const }),
      restoreOnExit: vi.fn(async () => { calls.push('restore-exit') })
    },
    loadConfig: vi.fn(async () => { calls.push('config'); return { ok: true } }),
    core: { start: vi.fn(async () => { calls.push('core'); return {} }) },
    proxy: {
      enable: vi.fn(async () => { calls.push('proxy-on') }),
      disable: vi.fn(async () => { calls.push('proxy-off') })
    },
    server: '127.0.0.1:5566',
    lastProxyEnabled: true,
    ...overrides
  }
}

describe('startup', () => {
  it('按 残留还原 → 读配置 → 启动内核 → 恢复代理 的顺序执行', async () => {
    const d = deps()
    const result = await startup(d as any)
    expect(d.calls).toEqual(['restore', 'config', 'core', 'proxy-on'])
    expect(result.status).toBe('ready')
  })

  it('配置错误时不启动内核、不应用代理', async () => {
    const d = deps({ loadConfig: vi.fn(async () => { d.calls.push('config'); return { ok: false, error: 'bad yaml' } }) as any })
    const result = await startup(d as any)
    expect(d.calls).toEqual(['restore', 'config'])
    expect(result.status).toBe('config-error')
  })

  it('内核启动失败时不应用代理', async () => {
    const d = deps()
    ;(d.core.start as any).mockImplementationOnce(async () => {
      d.calls.push('core')
      throw new Error('boom')
    })
    const result = await startup(d as any)
    expect(d.calls).toEqual(['restore', 'config', 'core'])
    expect(result.status).toBe('core-error')
  })

  it('上次代理为关时不自动开启', async () => {
    const d = deps({ lastProxyEnabled: false })
    await startup(d as any)
    expect(d.calls).toEqual(['restore', 'config', 'core'])
  })
})

describe('shutdown', () => {
  it('先还原代理，再终止内核', async () => {
    const calls: string[] = []
    const d = {
      ownership: { restoreOnExit: vi.fn(async () => { calls.push('restore-exit') }) },
      proxy: { disable: vi.fn(async () => { calls.push('proxy-off') }) },
      core: { stop: vi.fn(async () => { calls.push('core-stop') }) }
    }
    await shutdown(d as any)
    expect(calls).toEqual(['proxy-off', 'restore-exit', 'core-stop'])
  })

  it('关闭代理失败时仍会还原标记并终止内核', async () => {
    const calls: string[] = []
    const d = {
      ownership: { restoreOnExit: vi.fn(async () => { calls.push('restore-exit') }) },
      proxy: { disable: vi.fn(async () => { calls.push('proxy-off'); throw new Error('boom') }) },
      core: { stop: vi.fn(async () => { calls.push('core-stop') }) }
    }
    await expect(shutdown(d as any)).rejects.toThrow('boom')
    expect(calls).toEqual(['proxy-off', 'restore-exit', 'core-stop'])
  })
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `npm test -- src/main/lifecycle.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
export interface StartupDeps {
  ownership: {
    restoreOnStartupIfStale(): Promise<'none' | 'restored' | 'conflict'>
  }
  loadConfig(): Promise<{ ok: boolean; error?: string }>
  core: { start(): Promise<unknown> }
  proxy: { enable(server: string): Promise<void> }
  server: string
  lastProxyEnabled: boolean
}

export interface StartupResult {
  status: 'ready' | 'config-error' | 'core-error'
  restore: 'none' | 'restored' | 'conflict'
}

export async function startup(deps: StartupDeps): Promise<StartupResult> {
  const restore = await deps.ownership.restoreOnStartupIfStale()

  const cfg = await deps.loadConfig()
  if (!cfg.ok) return { status: 'config-error', restore }

  try {
    await deps.core.start()
  } catch {
    return { status: 'core-error', restore }
  }

  if (deps.lastProxyEnabled) await deps.proxy.enable(deps.server)
  return { status: 'ready', restore }
}

export interface ShutdownDeps {
  ownership: { restoreOnExit(): Promise<void> }
  proxy: { disable(): Promise<void> }
  core: { stop(): Promise<void> }
}

export async function shutdown(deps: ShutdownDeps): Promise<void> {
  const errors: unknown[] = []
  try { await deps.proxy.disable() } catch (err) { errors.push(err) }
  try { await deps.ownership.restoreOnExit() } catch (err) { errors.push(err) }
  try { await deps.core.stop() } catch (err) { errors.push(err) }
  if (errors.length > 0) throw errors[0]
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `npm test -- src/main/lifecycle.test.ts`
Expected: PASS（5 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/main/lifecycle.ts src/main/lifecycle.test.ts
git commit -m "feat(lifecycle): 启动与退出顺序编排"
```

---

### Task 11A: 关机/注销清理钩子

**Files:**
- Create: `src/main/shutdown-hooks.ts`, `src/main/shutdown-hooks.test.ts`

**Interfaces:**
- Produces: `registerShutdownHooks(source: { on(event: string, cb: () => void): void }, shutdown: () => Promise<void>): void` —— 多个事件只触发一次清理。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, vi } from 'vitest'
import { registerShutdownHooks } from './shutdown-hooks'

function fakeSource() {
  const handlers = new Map<string, Array<() => void>>()
  return {
    on(event: string, cb: () => void) {
      const list = handlers.get(event) ?? []
      list.push(cb)
      handlers.set(event, list)
    },
    emit(event: string) { for (const cb of handlers.get(event) ?? []) cb() }
  }
}

describe('registerShutdownHooks', () => {
  it('shutdown 与 before-quit 同时到达只执行一次清理', async () => {
    const source = fakeSource()
    const shutdown = vi.fn(async () => {})
    registerShutdownHooks(source, shutdown)
    source.emit('shutdown')
    source.emit('before-quit')
    await new Promise((r) => setTimeout(r, 0))
    expect(shutdown).toHaveBeenCalledTimes(1)
  })

  it('普通退出事件也能触发清理', async () => {
    const source = fakeSource()
    const shutdown = vi.fn(async () => {})
    registerShutdownHooks(source, shutdown)
    source.emit('before-quit')
    await new Promise((r) => setTimeout(r, 0))
    expect(shutdown).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `npm test -- src/main/shutdown-hooks.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
export interface ShutdownSource {
  on(event: string, cb: () => void): void
}

export function registerShutdownHooks(source: ShutdownSource, shutdown: () => Promise<void>): void {
  let running: Promise<void> | null = null
  const run = (): Promise<void> => {
    running ??= shutdown().catch(() => {})
    return running
  }
  source.on('shutdown', () => { void run() })
  source.on('before-quit', () => { void run() })
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `npm test -- src/main/shutdown-hooks.test.ts`
Expected: PASS（2 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/main/shutdown-hooks.ts src/main/shutdown-hooks.test.ts
git commit -m "feat(lifecycle): 关机与注销的幂等清理钩子"
```

> 说明：真实进程的 `taskkill /F` 强杀验证需要完整应用，放在下一份计划的端到端验收里，用脚本执行「开代理 → 强杀 → 重启 → 断言代理已还原」。

---

### Task 12: 真实内核冒烟测试

**Files:**
- Create: `vendor/.gitkeep`, `scripts/smoke.mjs`, `test/fixtures/subscription.yaml`

**Interfaces:**
- Consumes: Task 4–7 的 `mergeConfig` / `writeRuntime` / `CoreSupervisor`。
- Produces: `node scripts/smoke.mjs` 在真实 mihomo 下完成"导入 → 合并 → 启动 → 通过代理发请求"。

- [ ] **Step 1: 下载并锁定内核**

```bash
mkdir -p vendor
curl -L -o vendor/mihomo.zip \
  https://github.com/MetaCubeX/mihomo/releases/download/v1.19.32/mihomo-windows-amd64-v1.19.32.zip
unzip -o vendor/mihomo.zip -d vendor
mv vendor/mihomo-windows-amd64.exe vendor/mihomo.exe 2>/dev/null || true
sha256sum vendor/mihomo.exe > vendor/mihomo.sha256
cat vendor/mihomo.sha256
```

Expected: 输出一行哈希；把该哈希写进 `vendor/mihomo.sha256` 并提交。若 release 资产名不同，用 `curl -s https://api.github.com/repos/MetaCubeX/mihomo/releases/tags/v1.19.32` 查看 `assets[].name` 后修正命令。

- [ ] **Step 2: 写脱敏订阅样本**

`test/fixtures/subscription.yaml`（节点指向本地不可达地址，只验证结构）：

```yaml
mixed-port: 7890
mode: rule
dns:
  enable: true
  enhanced-mode: fake-ip
  nameserver-policy:
    geosite:cn: 223.5.5.5
sniffer:
  enable: true
proxy-providers:
  prov-a:
    type: http
    url: http://127.0.0.1:9/prov.yaml
    interval: 3600
proxies:
  - { name: HK-01, type: ss, server: 127.0.0.1, port: 9, cipher: aes-128-gcm, password: x }
proxy-groups:
  - name: Proxy
    type: select
    proxies: [HK-01]
  - name: Auto
    type: url-test
    use: [prov-a]
    url: http://www.gstatic.com/generate_204
    interval: 300
rules:
  - DOMAIN-SUFFIX,github.com,Proxy
  - MATCH,DIRECT
tun:
  enable: true
```

- [ ] **Step 3: 写冒烟脚本**

`scripts/smoke.mjs`：

```js
import { mkdtemp, mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import YAML from 'yaml'

const fixture = path.join('test', 'fixtures', 'subscription.yaml')
const upstream = YAML.parse(await readFile(fixture, 'utf8'))

const profileDir = await mkdtemp(path.join(tmpdir(), 'aether-smoke-'))
await copyFile(fixture, path.join(profileDir, 'upstream.yaml'))

// 复用编译后的合并逻辑：用 tsx 直接导入 TS 源码
const { mergeConfig } = await import('../src/main/config/merge.ts')
const { writeRuntime } = await import('../src/main/config/runtime.ts')
const { allocatePort } = await import('../src/main/core/ports.ts')
const { newSecret } = await import('../src/main/core/secret.ts')

const mixedPort = await allocatePort()
const controllerPort = await allocatePort()
const secret = newSecret()
const merged = mergeConfig(upstream, {}, { mixedPort, controllerPort, secret })
if (merged.tun?.enable !== false) throw new Error('tun 未被强制关闭')
await writeRuntime(profileDir, merged)

const test = execFileSync('vendor/mihomo.exe', ['-t', '-d', profileDir, '-f', path.join(profileDir, 'runtime.yaml')], { encoding: 'utf8' })
console.log(test.trim())

const child = spawn('vendor/mihomo.exe', ['-d', profileDir, '-f', path.join(profileDir, 'runtime.yaml')], {
  windowsHide: true,
  stdio: 'ignore'
})

try {
  const deadline = Date.now() + 10_000
  let version = null
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${controllerPort}/version`, { headers: { authorization: `Bearer ${secret}` } })
      if (res.ok) { version = await res.json(); break }
    } catch {}
    await new Promise((r) => setTimeout(r, 200))
  }
  if (!version) throw new Error('内核握手失败')
  console.log('version', version)

  const out = execFileSync('curl', ['-s', '-x', `http://127.0.0.1:${mixedPort}`, 'http://www.gstatic.com/generate_204', '-o', 'NUL', '-w', '%{http_code}'])
  console.log('through-proxy status', out.toString())
} finally {
  child?.kill('SIGTERM')
}

console.log('smoke ok', profileDir)
```

> 说明：`tsx` 未列入依赖；在本步骤前运行 `npm i -D tsx` 并把它加入 `devDependencies`。脚本用 `tsx scripts/smoke.mjs` 执行。

- [ ] **Step 4: 运行冒烟**

Run: `npm i -D tsx && npx tsx scripts/smoke.mjs`
Expected: 打印 `configuration file test is successful`、`version v1.19.32`、一个 HTTP 状态码（`204` 或节点不可达时的 `000/404` 都算链路跑通，只要进程起来了）；最后打印 `smoke ok`。

- [ ] **Step 5: 记录结果并提交**

把实际输出摘要写进 `docs/superpowers/plans/2026-10-24-m1-core-and-proxy.md` 末尾的「执行记录」小节（新建），然后：

```bash
git add vendor scripts/smoke.mjs test/fixtures/subscription.yaml docs/superpowers/plans
git commit -m "test: 真实 mihomo 冒烟链路"
```

---

## 执行记录

（Task 12 完成于 2026-10-26，真实 mihomo 冒烟已跑通。）

- **内核版本**：`Mihomo Meta v1.19.32 windows amd64 with go1.26.8`（release 资产 `mihomo-windows-amd64-v1.19.32.zip`）。
- **锁定哈希**：zip 为 `1ac84e795b5b915446e20139677fb6cc013a0778e876e8d4c96f994750b4c4a3`，与 GitHub API 的 `assets[].digest` 一致；解包后的 `vendor/mihomo.exe` SHA-256 为 `beb9878924d7bd38c67176b441ab5e668cc378bfe751c8dc8fef3eb5aaf566d5`（写入 `vendor/mihomo.sha256`）。
- **配置校验**：`mihomo -t` 输出 `configuration file ... test is successful`。
- **握手**：约 243 ms 拿到 `{ meta: true, version: 'v1.19.32' }`。
- **通过代理请求**：`curl -x http://127.0.0.1:<mixed-port> http://www.gstatic.com/generate_204` 返回 `502`（代理进程已接管请求，上游不可达是预期结果），脚本最后打印 `smoke ok`。
- **清理**：spawn 的内核在 `finally` 中 SIGTERM 退出（输出 `core exited SIGTERM`），事后按命令行确认无 `aether-smoke` 残留进程。
- **偏差**：① 直连 GitHub release 资产速度约 15 KB/s，改走 `ghfast.top` 镜像下载，并用 GitHub API 的官方 digest 校验通过；② 样本中的 `nameserver-policy: geosite:cn` 会触发 GeoSite.dat 在线下载并等待 90 秒超时，改为等价的 `'+.cn'` 字面后缀，保持样本脱敏且离线可跑；③ 冒烟脚本用绝对路径定位内核与样本，并在 `finally` 中等待子进程真正退出。

---


## 覆盖对照

| tasks.md | 本计划 | 说明 |
|---|---|---|
| 1.1 / 1.2 / 1.6 | Task 1 | 脚手架、安全基线、Vitest |
| 1.3 / 1.4 / 1.5 | 下一份计划 | IPC 白名单、tokens 与 lint、Zustand/Query 属于渲染层 |
| 2.1 | Task 7A + Task 12 | 路径解析 + 真实二进制下载与哈希锁定 |
| 2.2 | Task 2 | 端口与 secret |
| 2.3 | Task 1（runtime 写）+ Task 7 | 启动命令 |
| 2.4 | Task 7 | 握手与健康检查 |
| 2.5 | Task 3 + Task 7A | 退避策略 + 调度接入 |
| 2.6 / 2.7 / 2.8 | Task 7 / Task 8 / 各任务测试 | Task 8 只产出判定函数；接入启动流程需要 userData 与上次内核状态，划入下一份计划的启动集成 |
| 3.1 / 3.2 / 3.3 | Task 6A | profile 与导入 |
| 3.4 / 3.5 | Task 4 | 合并与注入 |
| 3.6 | Task 6 | 原子写 |
| 3.7 / 3.9 | Task 6B | `mihomo -t` 与热重载 |
| 3.8 | Task 5 | 引用完整性 |
| 3.10 | Task 12 | 订阅样本 |
| 3.11 | Task 4 / 5 / 6 / 6A / 6B | 分散在各任务的测试 |
| 4.1 – 4.7 | Task 9 + Task 9A + Task 10 | 接口、所有权、快照顺序保证、Windows 插件 |
| 4.8 | Task 11A | 钩子已实现；接入 Electron `powerMonitor` 在下一份计划 |
| 4.9 | Task 10 Step 5 | 真机注册表往返 |
| 4.10 | 下一份计划 | `taskkill /F` 需要完整应用，放在端到端验收 |
| 7.4 / 7.5 | Task 11 | 顺序逻辑已实现；Electron 事件接入在下一份计划 |
| 第 5 – 8 组 | 下一份计划 | 连接采集、界面、生命周期外壳、端到端 |

## 下一份计划

`2026-10-24-m1-dashboard-and-lifecycle.md`，依赖本计划产出的 `PlatformProxy`、`CoreSupervisor`、`mergeConfig`、`startup/shutdown` 四个接口，覆盖：IPC 白名单与 preload、React 外壳与侧栏、卡片仪表盘（四块 + 折线图）、顶栏模式切换、连接页（六列 + 行内详情 + 搜索/只看活跃）、命令面板、托盘、开机自启、窗口隐藏即销毁、`powerMonitor` 接入、`taskkill /F` 残留验证、内存测量，以及 `tasks.md` 第 8 组的全部端到端验收。

**接线时必须处理（来自 Task 11 审查）**：`registerShutdownHooks` 只做幂等聚合，不保证清理跑完。Electron 不会等待 `before-quit` 里的异步工作，Windows 的注销/关机事件是 `session-end`（不是 `powerMonitor` 的 `shutdown`）。接线时要：在 `will-quit` / `session-end` 里 `event.preventDefault()` → `await shutdown()` → 再调用 `app.quit()`；并给 shutdown 失败加日志，否则代理没还原时没有任何线索。
