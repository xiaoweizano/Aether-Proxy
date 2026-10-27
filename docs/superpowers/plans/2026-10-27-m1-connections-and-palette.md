# M1 连接页与命令面板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 M1 的差异功能——连接页（路由透视），含主进程连接采集、日志采集与拨号失败计数、节点页、页面导航与命令面板。

**Architecture:** 主进程新增 `connections`（`/connections?interval=500` WS + 60 秒环形缓冲 + 2000 条上限）、`logs`（`/logs` WS + 拨号失败滚动计数）。两者都只把规范化视图模型推给渲染层，secret 与 controller 地址不出主进程。渲染层新增页面路由（侧栏驱动）、连接表、节点页与命令面板，全部沿用既有 `tokens.css`。

**Tech Stack:** Electron 45 / React 19 / TypeScript 5 strict / electron-vite / Vitest + jsdom + @testing-library/react / `ws`（已就位）。

**Spec:** `openspec/changes/add-m1-windows-vertical-slice/specs/connection-inspector/spec.md`（主）、`desktop-shell/spec.md`（导航 / 键盘 / 命令面板）、`docs/design/2026-10-23-aether-proxy.md`「行解剖」「排序与筛选」「键盘」。

## Global Constraints

- 只支持 Windows x64；不得触发 UAC。
- controller 只绑定 `127.0.0.1`；`secret` 只在主进程内，**不得经 IPC、不得写日志、不得进渲染层**。
- 渲染进程安全基线：`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`、禁止新窗口与导航。
- 所有颜色、字号、间距、圆角来自 `src/renderer/styles/tokens.css`；渲染层不得出现裸色值/裸 px 字号（`scripts/check-tokens.mjs` 强制）。
- 所有面向用户的文案为简体中文，且集中在 `src/renderer/copy.ts`。
- 未知值一律 `—`，不得用 0 冒充（`DESIGN.md`「Unknown Is An Em Dash Rule」）。
- 每个任务结束前 `npm test`（含 token 检查）与 `npx tsc --noEmit` 必须为绿。

## 已核实的 API 契约（2026-10-27 用 `vendor/mihomo.exe` 实测）

这些是写代码时的事实依据，**不要凭猜测改**。

1. `ws://127.0.0.1:<controllerPort>/connections?interval=500`，带 `Authorization: Bearer <secret>`。
   每帧都是**完整快照**，不是差分：
   ```json
   { "downloadTotal": 0, "uploadTotal": 0, "connections": [], "memory": 27544 }
   ```
2. 单条连接（实测字段）：
   ```json
   {
     "id": "92189997-…",
     "metadata": {
       "network": "tcp", "type": "HTTPS",
       "sourceIP": "127.0.0.1", "sourcePort": "7608",
       "destinationIP": "", "destinationPort": "443",
       "inboundIP": "127.0.0.1", "inboundPort": "17891", "inboundName": "DEFAULT-MIXED",
       "host": "example.com", "dnsMode": "normal", "uid": 0,
       "process": "curl.exe", "processPath": "D:\\Git\\Git\\mingw64\\bin\\curl.exe",
       "remoteDestination": "172.66.147.243", "sniffHost": ""
     },
     "upload": 841, "download": 5374,
     "start": "2026-10-27T11:07:07.5185055+08:00",
     "chains": ["DIRECT"],
     "providerChains": [""],
     "rule": "Match", "rulePayload": ""
   }
   ```
   注意：`sourcePort` / `destinationPort` 是**字符串**；`chains[0]` 是**实际出站**，反转后才是「最外层策略组 ▸ … ▸ 实际出站」；`metadata.host` 可能为空（非 HTTP 连接），此时退回 `remoteDestination` 或 `destinationIP`。
3. `ws://127.0.0.1:<controllerPort>/logs?level=warning` 每帧 `{ "type": "warning", "payload": "…" }`。
   拨号失败实测形态（**无版本化契约，只能按前缀与关键词匹配**）：
   ```
   [TCP] dial Proxy (match Match/) 127.0.0.1:8608(curl.exe) --> example.com:80 error: 127.0.0.1:9 connect error: dial tcp 127.0.0.1:9: connectex: No connection could be made because the target machine actively refused it.
   ```
   判定规则：`type === 'warning'` 且 `payload` 以 `[TCP] dial ` 或 `[UDP] dial ` 开头且包含 ` error: `。

## Review Focus

1. **Secret 泄漏**——连接与日志视图模型里不得出现 `secret`、controller 端口或 `processPath` 之外的本地路径。`processPath` 是规格明确要求显示的（行内详情「进程」组），可下发；其它路径不行。
2. **缓冲正确性**——离开快照的连接标「已结束」而不是删除；60 秒后移除；超过 2000 条优先淘汰最早结束的。
3. **常量分摊**——每帧全量快照，不能每帧重建整个 React 列表；未变化的行必须复用（`id` 做 key，行组件 memo）。
4. **未知值诚实**——缺 `process` / `host` / `rule` 时显示 `—`，不得渲染空字符串或 `undefined`。
5. **键盘可达**——规格要求六个核心任务全键盘可完成，不能只在鼠标路径上测过。

---

## 文件结构

```
src/main/connections.ts           /connections WS 采集 + 环形缓冲 + 视图模型
src/main/connections.test.ts
src/main/logs.ts                  /logs WS 采集 + 拨号失败滚动计数
src/main/logs.test.ts
src/main/ipc.ts                   +connections:get/push、logs:get/counts、nodes:switch、app:open-config-dir
src/shared/ipc.ts                 +ConnectionView、ConnectionGroupView、LogCountsView、NodeSwitchResult
src/preload/index.ts              +onConnections、getConnections、switchNode、openConfigDir
src/renderer/pages/ConnectionsPage.tsx
src/renderer/pages/NodesPage.tsx
src/renderer/components/ConnectionRow.tsx
src/renderer/components/ConnectionDetail.tsx
src/renderer/components/CommandPalette.tsx
src/renderer/hooks/useConnections.ts
src/renderer/hooks/useLogCounts.ts
src/renderer/selectors.ts         +filterConnections、sortConnections、connectionHeaders
src/renderer/copy.ts              +连接页 / 节点页 / 命令面板文案
src/renderer/styles/app.css       +表格、行详情、命令面板、节点页样式
src/renderer/App.tsx              页面路由（侧栏驱动）
src/renderer/components/Sidebar.tsx  受控选中态
scripts/check-tokens.mjs          扩到裸 px / 裸圆角
```

---

### Task 1: 连接采集（主进程）

**Files:**
- Create: `src/main/connections.ts`, `src/main/connections.test.ts`
- Modify: `src/shared/ipc.ts`

**Interfaces:**

```ts
// src/shared/ipc.ts
export interface ConnectionView {
  /** 内核给的不透明 id，渲染层只当 key 用。 */
  id: string
  /** 建立时刻（毫秒）。解析失败时为 null。 */
  startedAt: number | null
  /** 已反转：最外层策略组在前，实际出站在后。空数组表示内核没给。 */
  chains: string[]
  rule: string | null
  rulePayload: string | null
  host: string | null
  process: string | null
  processPath: string | null
  network: string | null
  destinationIp: string | null
  destinationPort: string | null
  sourceIp: string | null
  sourcePort: string | null
  upload: number
  download: number
  /** 已离开快照：界面降权显示，60 秒后移除。 */
  ended: boolean
  /** 离开快照的时刻（毫秒）；活跃时为 null。 */
  endedAt: number | null
}

export interface ConnectionsSnapshot {
  items: ConnectionView[]
  /** 内核上报的内存（字节）；缺省为 null，不得填 0。 */
  memory: number | null
  /** 快照生成时刻（主进程时钟，毫秒）。 */
  at: number
}
```

```ts
// src/main/connections.ts
export interface ConnectionsOptions {
  url: string          // ws://127.0.0.1:<port>/connections?interval=500
  secret: string
  connect?: StatsConnect            // 复用 stats.ts 的连接抽象
  /** 已结束连接的保留时长，默认 60_000。 */
  retainEndedMs?: number
  /** 总条目上限，默认 2000。 */
  maxEntries?: number
  /** 推送节流，默认 500ms（与内核推送间隔一致）。 */
  now?: () => number
}

export class ConnectionsCollector {
  constructor(opts: ConnectionsOptions)
  start(onSnapshot?: (s: ConnectionsSnapshot) => void): void
  stop(): void
  snapshot(): ConnectionsSnapshot
}
```

行为：
- 每帧是完整快照。以 `id` 对齐：出现的连接更新流量并清 `ended`；消失的连接标 `ended = true`、记 `endedAt = now`，**保留**。
- 已结束条目在 `now - endedAt >= retainEndedMs` 时移除。
- 总条目超过 `maxEntries` 时，优先移除**最早结束**的已结束条目；仍然超额才移除最早的活跃条目。
- `chains` 反转后存（`[...raw].reverse()`），单元素数组不加分隔符。
- `start` 幂等：已连接时只替换回调。
- 解析失败的单条记录跳过，不中断整帧。
- 不推送时也保留缓冲：`snapshot()` 随时可读（窗口重建后用它补首屏）。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { ConnectionsCollector } from './connections'

function frame(ids: string[]): string {
  return JSON.stringify({
    downloadTotal: 0,
    uploadTotal: 0,
    memory: 28000,
    connections: ids.map((id) => ({
      id,
      metadata: { host: `${id}.example.com`, process: 'curl.exe', network: 'tcp' },
      upload: 1,
      download: 2,
      start: '2026-10-27T11:07:07.5185055+08:00',
      chains: ['HK-01', 'Auto', 'Proxy'],
      rule: 'Match',
      rulePayload: ''
    }))
  })
}

it('离开快照的连接标为已结束并保留，60 秒后移除', () => {
  let now = 1_000
  const sent: ConnectionsSnapshot[] = []
  const c = new ConnectionsCollector({ url: 'ws://x', secret: 'unused', connect: fakeConnect(), now: () => now })
  c.start((s) => sent.push(s))
  push(frame(['a', 'b']))
  push(frame(['a']))
  expect(c.snapshot().items.map((i) => [i.id, i.ended])).toEqual([['a', false], ['b', true]])
  now += 59_999
  expect(c.snapshot().items).toHaveLength(2)
  now += 1
  expect(c.snapshot().items.map((i) => i.id)).toEqual(['a'])
})

it('chains 反转后存储', () => {
  // 原始 ["HK-01","Auto","Proxy"] → ["Proxy","Auto","HK-01"]
})
```

- [ ] **Step 2: 运行并确认失败** — `npx vitest run src/main/connections.test.ts` → `Cannot find module './connections'`

- [ ] **Step 3: 实现**

复用 `stats.ts` 已有的 `StatsConnect` / `WebSocketLike` / `toText`（若未导出就抽到 `src/main/ws.ts` 并让 `stats.ts` 改用它，不要复制粘贴）。

- [ ] **Step 4: 测试绿 + tsc**

- [ ] **Step 5: 提交** — `feat(main): 采集 /connections 快照并维护 60 秒环形缓冲`

---

### Task 2: 日志采集与拨号失败计数（主进程）

**Files:**
- Create: `src/main/logs.ts`, `src/main/logs.test.ts`
- Modify: `src/shared/ipc.ts`

**Interfaces:**

```ts
// src/shared/ipc.ts
export interface DialFailureCounts {
  /** 最近 `windowMs` 内的拨号失败次数。 */
  recent: number
  /** 窗口长度（毫秒）；界面必须由它生成文案，不要硬编码分钟数。 */
  windowMs: number
}
```

```ts
// src/main/logs.ts
export interface LogsOptions {
  url: string        // ws://127.0.0.1:<port>/logs?level=warning
  secret: string
  connect?: StatsConnect
  /** 计数窗口，默认 60 分钟（按 connection-inspector 规格）。 */
  windowMs?: number
  /** 环形缓冲条数，默认 200（错误面板与「查看日志」页用）。 */
  maxEntries?: number
  now?: () => number
}

export interface LogEntry { at: number; level: string; payload: string }

export class LogsCollector {
  constructor(opts: LogsOptions)
  start(onCounts?: (c: DialFailureCounts) => void): void
  stop(): void
  counts(): DialFailureCounts
  recent(): LogEntry[]
}
```

`isDialFailure(type, payload)` 抽成导出函数，单独测：`type === 'warning'` 且 `/^\[(TCP|UDP)\] dial /` 且包含 ` error: `。

- [ ] **Step 1: 失败测试** — 推 3 条拨号失败 + 2 条其它 warning → `counts().recent === 3`；推进时钟到窗口外 → 归零；非拨号 warning 不进计数但仍进 `recent()`。
- [ ] **Step 2: 实现**
- [ ] **Step 3: 测试绿 + tsc**
- [ ] **Step 4: 提交** — `feat(main): 订阅 /logs 并统计拨号失败`

---

### Task 3: IPC 与 preload 扩展

**Files:**
- Modify: `src/main/ipc.ts`, `src/preload/index.ts`, `src/shared/ipc.ts`, `src/main/index.ts`, `src/main/bootstrap.ts`

**新增通道：**

```ts
export const IPC = {
  // …既有
  connectionsGet: 'connections:get',
  connectionsPush: 'connections:push',
  logsCountsGet: 'logs:counts',
  logsCountsPush: 'logs:counts-push',
  nodeSwitch: 'proxies:switch',
  configOpenDir: 'config:open-dir'
} as const
```

- `connectionsGet` → `ConnectionsSnapshot`（窗口重建后补首屏）。
- `connectionsPush` / `logsCountsPush` → 主进程主动推送，同 `statsPush` 的模式：只认当前窗口，窗口销毁时不停采集（连接缓冲要继续维护），但推送丢弃。
- `nodeSwitch`：入参 `{ group: string, node: string }`，校验两者都是字符串且非空；调用 `CoreLink` 的 `PUT /proxies/<group>` 换节点，返回 `{ ok, status }`；`ctx.link === null` 时返回 `{ ok:false, status:0 }`。
- `configOpenDir`：`shell.openPath(ctx.configDir)`，返回 `SimpleResult`。**只开配置目录，不接受任意路径入参。**

- [ ] **Step 1: 失败测试** — `buildStatusView` 之外新增：`connectionsGet` 的序列化结果不含 `secret`；`nodeSwitch` 对非字符串入参返回 `{ok:false}` 而不是抛错；`configOpenDir` 不接受入参。
- [ ] **Step 2: 实现**
- [ ] **Step 3: 测试绿 + tsc**
- [ ] **Step 4: 提交** — `feat(ipc): 连接、日志计数、节点切换与配置目录通道`

---

### Task 4: 页面路由与侧栏选中态

**Files:**
- Modify: `src/renderer/App.tsx`, `src/renderer/components/Sidebar.tsx`, `src/renderer/copy.ts`, `src/renderer/styles/app.css`
- Create: `src/renderer/pages/Placeholder.tsx`（节点 / 设置 / 日志三页的临时占位，注明「后续计划」）

**Interfaces:**

```tsx
export type Page = 'dashboard' | 'nodes' | 'connections' | 'settings' | 'logs'
```

- `App` 持有 `const [page, setPage] = useState<Page>('dashboard')`。
- `Sidebar({ status, page, onNavigate })`，导航项变成 `<button>`（不是 `<a>`），`aria-current="page"` 标出当前页。
- 非 ready 状态仍渲染 `StatePanel`（任何页面都显示，导航不受阻）；ready 时按 `page` 渲染 Dashboard / NodesPage / ConnectionsPage / Placeholder。
- **不引入路由器**：五个页面是纯本地状态，不需要 URL。

- [ ] **Step 1: 失败测试** — 点侧栏「连接」后主区出现连接页；点回「仪表盘」恢复；`aria-current` 跟随。
- [ ] **Step 2: 实现**
- [ ] **Step 3: 测试绿 + tokens**
- [ ] **Step 4: 提交** — `feat(renderer): 侧栏驱动的页面路由`

---

### Task 5: 连接页表格

**Files:**
- Create: `src/renderer/pages/ConnectionsPage.tsx`, `src/renderer/components/ConnectionRow.tsx`, `src/renderer/hooks/useConnections.ts`
- Modify: `src/renderer/selectors.ts`, `src/renderer/copy.ts`, `src/renderer/styles/app.css`

**列**（对齐设计文档「行解剖」，宽度用 token）：

| 列 | 内容 | 规则 |
|---|---|---|
| 时间 | `HH:mm:ss` | `startedAt` 为 null 时 `—` |
| 进程 | `process` | 尾部省略；缺省 `—` |
| 域名 | `host`，缺失退回 `destinationIp` | **中间省略** |
| 出站 | `chains` 首尾两段，`A ▸ … ▸ Z`；单段直出 | 缺省 `—` |
| 流量 | `↑upload ↓download` | 复用 `formatBytes` |
| 时长 | `now - startedAt` | 已结束的用 `endedAt` 冻结 |

- 行高 28px、主字号 13px（设计 tokens 已有 `--fs-body`）。
- **已结束**行：40% 不透明度 + 空心圆点；**被拒绝**（`chains` 含 `REJECT` / `REJECT-DROP`）：红色系标记。
- 默认按 `startedAt` 倒序；点表头切换正/倒序。
- 顶部：条数、时间窗口文案、搜索框、只看活跃开关。
- **虚拟滚动**：列表用固定行高 + `transform: translateY` 窗口化；先做成 `useVirtualRows(items, rowHeight, viewportHeight)` 纯函数 hook，可单独测。行数 ≤ 200 时不虚拟化（避免小列表抖动）。
- `ConnectionRow` 用 `memo`，key 用 `id`，只在自身字段变化时重渲染。

- [ ] **Step 1: 失败测试**
  - 空列表：保留列头 + 显示「暂无连接」，不出现空白页。
  - 缺 `process` / `host` 的行显示 `—`，且不出现 `undefined` / `NaN`。
  - 原始 `chains: ['HK','Auto','Proxy']` 渲染为 `Proxy ▸ … ▸ HK`；`['DIRECT']` 渲染为 `DIRECT`。
  - 只看活跃开启后已结束行消失，关闭后回来。
  - 搜索不区分大小写，匹配域名与进程名。
  - `useVirtualRows`：1000 条、视口 600px、行高 28px → 可见区间长度 ≤ 视口行数 + 2。
- [ ] **Step 2: 实现**
- [ ] **Step 3: 测试绿 + tokens**
- [ ] **Step 4: 提交** — `feat(renderer): 连接页六列表格与虚拟滚动`

---

### Task 6: 行内详情与键盘

**Files:**
- Create: `src/renderer/components/ConnectionDetail.tsx`
- Modify: `src/renderer/pages/ConnectionsPage.tsx`, `src/renderer/copy.ts`, `src/renderer/styles/app.css`

展开内容（四组，位置在该行下方）：

1. 完整链路：`Proxy ▸ Auto ▸ HK-01`
2. 命中规则：`rule` 与 `rulePayload`，形如 `DomainSuffix(github.com)`
3. 进程：`process` 与 `processPath`
4. 数据：上下行字节、起止时间、`network`、目标 IP 与端口

键盘（列表获得焦点时，搜索框聚焦时不拦截）：

| 键 | 作用 |
|---|---|
| `↑` `↓` | 移动选中行 |
| `Enter` | 展开 / 收起详情 |
| `A` | 切换「只看活跃」 |
| `/` | 聚焦搜索 |
| `Esc` | 清空搜索（详情已展开时先收起） |

选中行需要 `aria-selected`，行容器 `role="row"`，表格 `role="grid"` / `role="table"` 二选一并保持一致。

- [ ] **Step 1: 失败测试** — `Enter` 展开后四组都出现；再按 `Enter` 收起；`A` 切开关；搜索框聚焦时按 `A` 不切开关。
- [ ] **Step 2: 实现**
- [ ] **Step 3: 测试绿 + tokens**
- [ ] **Step 4: 提交** — `feat(renderer): 连接行内详情与列表键盘操作`

---

### Task 7: 节点页与切换节点

**Files:**
- Create: `src/renderer/pages/NodesPage.tsx`, `src/renderer/components/NodeList.tsx`
- Modify: `src/renderer/copy.ts`, `src/renderer/styles/app.css`, `src/renderer/hooks/useProxies.ts`

- 按策略组分组，组内列节点名与最近延迟（`delay` 缺失显示 `—`）。
- 点击节点调用 `switchNode({ group, node })`；成功后在**下一次轮询**里由 `now` 反映，不做乐观更新（避免内核拒绝时界面说谎）；失败显示一行错误。
- `GLOBAL` 组默认折叠：它只在全局模式下有意义。
- 当前选中节点有明确的选中态（复用 `--accent` 的 12% wash，符合 Wash Ladder）。

- [ ] **Step 1: 失败测试** — 渲染两个组与各自节点；点节点调用 `switchNode` 且入参正确；失败时显示错误且选中态不变。
- [ ] **Step 2: 实现**
- [ ] **Step 3: 测试绿 + tokens**
- [ ] **Step 4: 提交** — `feat(renderer): 节点页与切换节点`

---

### Task 8: 命令面板

**Files:**
- Create: `src/renderer/components/CommandPalette.tsx`, `src/renderer/hooks/useCommands.ts`
- Modify: `src/renderer/App.tsx`, `src/renderer/copy.ts`, `src/renderer/styles/app.css`

- `Ctrl+K`（`metaKey` 在 mac 上等价）打开，`Esc` 关闭；打开时把焦点移到输入框，关闭后焦点回到原元素。
- 内容：节点搜索结果 + 六个动作（开关代理 / 切换模式 / 重启内核 / 打开配置目录 / 查看日志 / 复制当前节点名）。
- 输入框过滤：节点按名字不区分大小写匹配；动作按标题匹配。
- `↑` `↓` 移动、`Enter` 执行。
- 「查看日志」导航到日志页（Task 4 的占位页）。
- 「复制当前节点名」用 `navigator.clipboard.writeText`，失败时静默（不弹错）。
- 面板 `role="dialog"` `aria-modal="true"`，背景遮罩点击关闭。

- [ ] **Step 1: 失败测试** — `Ctrl+K` 打开且焦点在输入框；输入节点名过滤；`Enter` 调 `switchNode`；`Esc` 关闭并把焦点还给触发元素。
- [ ] **Step 2: 实现**
- [ ] **Step 3: 测试绿 + tokens**
- [ ] **Step 4: 提交** — `feat(renderer): 命令面板`

---

### Task 9: 仪表盘接入拨号失败计数

**Files:**
- Create: `src/renderer/hooks/useLogCounts.ts`
- Modify: `src/renderer/components/NodeCard.tsx`, `src/renderer/copy.ts`, `src/renderer/styles/app.css`, `src/main/index.ts`

- 订阅 `logsCountsPush`；`recent === 0` 时保持现有的「最近 60 分钟 —」未知态**不动**（没有失败记录 ≠ 健康，除非真的有过计数来源）。
- 有计数时：`最近 60 分钟 N 次拨号失败`（文案由 `windowMs` 推导，不硬编码），点击跳到日志页。
- **必须同时轮询 `logsCountsGet`（间隔 ≤ 5 秒）**：计数窗口到期不会推送，只订阅 `logsCountsPush` 会让仪表盘长期显示过期的非零计数。
- **这条替换掉 Task 5 遗留的「失败次数没有数据源」**：`NodeCard` 的健康行现在有真实数据源了，按 `DESIGN.md` 更新健康行文案与刻度条的语义（仅当计数来源就绪时）。

- [ ] **Step 1: 失败测试** — 无计数时仍是 `—`；有计数时显示 N 次且可点击导航。
- [ ] **Step 2: 实现**
- [ ] **Step 3: 测试绿 + tokens + `npm run shot` 仍通过**
- [ ] **Step 4: 提交** — `feat(renderer): 仪表盘展示拨号失败计数`

---

### Task 10: token 检查器扩展

**Files:**
- Modify: `scripts/check-tokens.mjs`, `scripts/check-tokens.test.mjs`（若不存在则新建）

规格 6.14 要求「组件中无裸色值、裸 px、裸圆角」。当前检查器只抓十六进制色值与 `font-size: Npx`。

- 扩展：非 `tokens.css` 的文件里出现 `\b\d+px\b` 或 `border-radius:\s*\d` 即失败。
- 先跑一遍统计现有违规数，把**合法例外**（`0px`、`1px` 边框、`50%`）列成白名单常量并写注释说明为什么。
- 若短期内无法清零全部几何值，本任务只把**新增**的裸值挡住：对照现有基线生成一份 `scripts/token-baseline.json`，检查器允许基线内的旧值，新增即失败。

- [ ] **Step 1: 失败测试** — 在临时文件里写入 `border-radius: 5px` → 检查器退出 1；写入 `border-radius: 0` → 通过。
- [ ] **Step 2: 实现**
- [ ] **Step 3: `npm test` 全绿**
- [ ] **Step 4: 提交** — `test(renderer): 令牌检查覆盖裸 px 与裸圆角`

---

## 下一份计划

`2026-10-27-m1-shell-and-lifecycle.md`：托盘原生菜单、窗口关闭即销毁与真实窗口按钮、开机自启（含断网警告）、孤儿内核识别接线（`core/orphan.ts`）、退避重启接线（`core/restarter.ts`）、`powerMonitor` / `session-end` 关机还原、`taskkill /F` 崩溃恢复验证、响应式三档折叠、`restore` 恢复提示与错误摘要、全局模式下当前节点按模式判断、内存测量脚本、8 小时长稳与端到端验收。
