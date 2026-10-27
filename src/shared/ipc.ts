import type { Mode } from './types'

/** 渲染层拿到的状态：白名单字段，绝不含 secret、上游原文或本地路径。 */
export interface AppStatusView {
  status: 'no-config' | 'ready' | 'config-error' | 'core-error' | 'in-use'
  restore: 'none' | 'restored' | 'conflict' | 'in-use'
  mode: Mode
  proxyEnabled: boolean
  /** `proxyPort` 是 mixed-port（用户真正走的端口）；controller 端口永不下发。 */
  core?: { version: string; proxyPort: number; startedAt: number }
  profile?: { nodeCount: number; groupCount: number }
}

export interface ProxyGroupView {
  name: string
  type: string
  now: string
  nodes: { name: string; delay?: number }[]
}

export interface TrafficView {
  up: number
  down: number
  upTotal: number
  downTotal: number
}

/** 主进程规范化后的单条连接；渲染层只读，不含 secret 或 controller 地址。 */
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

/** 拨号失败的滚动窗口计数；界面用它显示「最近 N 分钟失败 M 次」。 */
export interface DialFailureCounts {
  /** 最近 `windowMs` 内的拨号失败次数。 */
  recent: number
  /**
   * 窗口长度（毫秒）。**界面必须由它生成文案**（默认 60 分钟 = 一小时），
   * 不要照抄注释或设计稿里的分钟数——窗口改过一次，硬编码就会说谎。
   * 另外计数只在「新的失败到达」时推送；失败滚出窗口没有推送，消费方必须轮询。
   */
  windowMs: number
}

export interface ModeSetResult {
  ok: boolean
  status: number
}

/** 节点切换入参；`group` 是策略组名，`node` 是该组内的节点名。 */
export interface NodeSwitchInput {
  group: string
  node: string
}

/** 与 `ModeSetResult` 同形：内核状态码，传输失败为 0。 */
export interface NodeSwitchResult {
  ok: boolean
  status: number
}

export interface SimpleResult {
  ok: boolean
  message?: string
}

export interface ImportResult {
  ok: boolean
  needsRestart?: boolean
  message?: string
}

/** 渲染层只能发起「选文件」；路径由主进程的原生对话框产生。 */
export type PickImportResult =
  | { ok: true; needsRestart: true }
  | { ok: false; cancelled?: true; message?: string }

export interface StatsHistorySample {
  up: number
  down: number
}

export interface StatsSample extends TrafficView {
  /** 内核内存（字节），取不到时为 undefined。 */
  memory?: number
  /** 主进程维护的最近 60 个速率点；窗口重建后用它补齐曲线。 */
  history?: StatsHistorySample[]
}

export const IPC = {
  statusGet: 'app:status',
  proxiesGet: 'core:proxies',
  modeSet: 'config:mode',
  proxyEnable: 'proxy:enable',
  proxyDisable: 'proxy:disable',
  coreRestart: 'core:restart',
  configImport: 'config:import',
  configPickImport: 'config:pick-import',
  statsPush: 'app:stats',
  connectionsGet: 'connections:get',
  connectionsPush: 'connections:push',
  logsCountsGet: 'logs:counts',
  logsCountsPush: 'logs:counts-push',
  nodeSwitch: 'proxies:switch',
  configOpenDir: 'config:open-dir'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

/** preload 暴露给渲染层的全部能力；除此之外渲染层没有任何内核访问途径。 */
export interface AetherApi {
  getStatus(): Promise<AppStatusView>
  getProxies(): Promise<ProxyGroupView[]>
  setMode(mode: Mode): Promise<ModeSetResult>
  enableProxy(): Promise<SimpleResult>
  disableProxy(): Promise<SimpleResult>
  restartCore(): Promise<SimpleResult>
  /** 主进程弹原生文件选择框；渲染层拿不到也不该拿本地路径。 */
  importConfig(): Promise<PickImportResult>
  /** 订阅流量推送；返回取消订阅函数。 */
  onStats(cb: (sample: StatsSample) => void): () => void

  /** 连接缓冲的当前快照；窗口重建后用它补首屏。 */
  getConnections(): Promise<ConnectionsSnapshot>
  /** 订阅每次内核快照；返回取消订阅函数。窗口销毁期间采集不中断，只是没有推送。 */
  onConnections(cb: (snapshot: ConnectionsSnapshot) => void): () => void

  /**
   * 拨号失败计数的惰性滚动值；内核未运行（没有计数来源）时为 null。
   *
   * **必须与 `onLogCounts` 一起用，而且必须轮询**：推送只在**新失败到达**时触发，
   * 失败滚出窗口时没有任何回调。只订阅推送会让界面无限期显示过期的非零计数。
   * 建议的用法是订阅推送负责即时更新，同时以不超过窗口量级的间隔调本方法兜底。
   */
  getLogCounts(): Promise<DialFailureCounts | null>
  /** 订阅新失败到达时的计数；到期不会推送，见 `getLogCounts` 的注释。 */
  onLogCounts(cb: (counts: DialFailureCounts) => void): () => void

  /** 在指定策略组里切换节点；失败只回 `{ok:false}`，不抛错。 */
  switchNode(input: NodeSwitchInput): Promise<NodeSwitchResult>
  /** 打开主进程自己的配置目录；不接受路径参数。 */
  openConfigDir(): Promise<SimpleResult>
}
