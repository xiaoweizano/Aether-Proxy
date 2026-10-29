import type { Mode } from './types'

/** 渲染层拿到的状态：白名单字段，绝不含 secret、上游原文或本地路径。 */
export interface AppStatusView {
  /**
   * `reconnecting` 表示内核意外退出、正在按退避自动重启：既不是健康状态，
   * 也不该递出「重启内核」——那会让用户和后台定时器抢着拉起内核。
   */
  status: 'no-config' | 'ready' | 'config-error' | 'core-error' | 'in-use' | 'reconnecting'
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
  /**
   * 用户在自动组（URLTest / Fallback / LoadBalance）里钉住的节点；空串或缺失表示没有钉住。
   * 这些组的 `PUT /proxies/<group>` 返回 204 但**不会**改 `now`，只把 `fixed` 设为所选节点
   * （2026-10-27 对 mihomo v1.19.32 实测）。因此「界面上的选中节点」必须是 `fixed || now`。
   */
  fixed?: string
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
  /**
   * 内核上报的内存，单位是**字节**；缺省为 null，不得填 0。
   *
   * 单位已实测：`/connections` 帧的 `memory` 与 `/memory` 的 `inuse` 同为字节，
   * 2026-10-27 对 mihomo v1.19.32 测得 24,944,640，与该进程 `WorkingSet64`
   * 24,571,904 相差 1.5%。界面用 `formatBytes` 直接格式化，不要再除 1024。
   */
  memory: number | null
  /**
   * 已结束连接在快照里保留的时长（毫秒）；采集器不存在（内核未运行）时为 null。
   * 界面必须由它推导「最近 N」窗口文案，不要照抄设计稿里的秒数。
   */
  retainMs: number | null
  /** 快照生成时刻（主进程时钟，毫秒）。 */
  at: number
}

/** 拨号失败的滚动窗口计数；界面用它显示「最近 N 分钟失败 M 次」。 */
/** 日志缓冲里的一条；`payload` 是内核原文，不做截断或改写。 */
export interface LogEntryView {
  /** 到达时刻（主进程时钟）。 */
  at: number
  /** 内核给的级别（实测只有 `warning`）。 */
  level: string
  payload: string
}

export interface LogsSnapshot {
  /** 最多 200 条，按到达顺序，最新在最后。 */
  entries: LogEntryView[]
  /** 累计追加条数（单调递增）；环形缓冲淘汰不会让它回退。 */
  revision: number
}

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

/**
 * 导入成功之后配置所处的状态。
 *
 * - `reloaded`：内核在运行，已热重载并接受了新配置，不用重启；
 * - `pending-restart`：已写入，但内核没在跑——重启内核后生效；
 * - `reload-failed`：已写入，内核在跑却拒绝了新配置（附原因）。重启同样可能失败，
 *   界面必须把原因一起显示，不能只说「已导入」。
 */
export type ImportApplied = 'reloaded' | 'pending-restart' | 'reload-failed'

export interface ImportResult {
  ok: boolean
  applied?: ImportApplied
  cancelled?: boolean
  message?: string
}

/** 渲染层只能发起「选文件」；路径由主进程的原生对话框产生。 */
export type PickImportResult =
  | { ok: true; applied: ImportApplied; message?: string }
  | { ok: false; cancelled?: true; message?: string }

/** 订阅 URL 导入。URL 由渲染层提供（用户输入的地址，不含本地路径）。 */
export type UrlImportResult =
  | { ok: true; applied: ImportApplied; message?: string }
  | { ok: false; message: string }

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

/** 主进程可以执行的窗口动作。`close` 是销毁窗口，不是退出应用。 */
export type WindowAction = 'minimize' | 'maximize' | 'close'

/** 窗口状态推送。标题栏据此在「最大化」与「还原」之间切换按钮语义。 */
export interface WindowStateView {
  maximized: boolean
}

/**
 * 开机自启的当前状态。全部字段都是事实，渲染层只负责显示：
 * - `enabled` 是开关唯一允许显示的位置（打包态 = Windows 的实际启动项）；
 * - `appliesToSystem` 为 false 时（开发态）开关只是意向，界面必须写「仅打包版生效」；
 * - `systemDiffers` 为 true 时系统实际值与持久化意向不一致，界面以系统为准并提示；
 * - `error` 是主进程给出的短句（读取/写入失败），缺省表示没有异常。
 */
export interface AutostartStateView {
  enabled: boolean
  persisted: boolean
  appliesToSystem: boolean
  systemDiffers: boolean
  error?: string
}

export interface AutostartSetResult {
  ok: boolean
  /** 动作之后重新读到的真实状态；失败时开关按它回位。 */
  state: AutostartStateView
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
  /** 从订阅 URL 导入（一次性拉取，不做定时刷新）。 */
  configUrlImport: 'config:url-import',
  statsPush: 'app:stats',
  /** 流量环形缓冲的当前快照；窗口重建后用它补首屏，不必等下一个采样点。 */
  statsGet: 'app:stats-get',
  connectionsGet: 'connections:get',
  connectionsPush: 'connections:push',
  logsCountsGet: 'logs:counts',
  logsCountsPush: 'logs:counts-push',
  /** 日志尾巴快照（最多 200 条，最新在最后）。 */
  logsRecentGet: 'logs:recent',
  nodeSwitch: 'proxies:switch',
  configOpenDir: 'config:open-dir',
  /**
   * 窗控：只接受 `minimize` / `maximize` / `close` 三个动作名，不接受任何路径或坐标。
   * `close` 销毁主窗口，代理与内核继续运行（常驻代理）。
   */
  windowControl: 'window:control',
  /** 窗口状态：最大化/还原。主进程单向推送，窗口重建后也会补一份。 */
  windowStatePush: 'window:state-push',
  /** 首屏补拉当前窗口状态（防止推送早于订阅）。 */
  windowStateGet: 'window:state',
  /**
   * 开机自启：读取实际状态 / 设置。读取在打包态回 `getLoginItemSettings().openAtLogin`，
   * 开发态回持久化意向并标注 `appliesToSystem: false`（不写注册表，见账本 Ruling）。
   */
  autostartGet: 'startup:get',
  autostartSet: 'startup:set'
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
  /**
   * 从订阅地址一次性拉取配置。只接受 http/https，主进程会校验协议，
   * 避免渲染层把它当成任意协议的发起点。
   */
  importConfigFromUrl(url: string): Promise<UrlImportResult>
  /** 订阅流量推送；返回取消订阅函数。 */
  onStats(cb: (sample: StatsSample) => void): () => void
  /**
   * 流量缓冲的当前快照（含 60 点 history）；窗口重建后用它补首屏。
   * 采集器不存在（内核未运行）时为 null——没有数据来源，不能编一条零样本出来。
   */
  getStats(): Promise<StatsSample | null>

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
  /**
   * 日志尾巴快照；内核未运行（没有采集器）时为 null。
   *
   * 轮询用：主进程只在**有新日志**时让 `revision` 变化，界面据此跳过无意义的重渲染。
   * 返回 null 不等于「没有日志」——那是「没有来源」，界面必须分开说。
   */
  getLogs(): Promise<LogsSnapshot | null>

  /** 在指定策略组里切换节点；失败只回 `{ok:false}`，不抛错。 */
  switchNode(input: NodeSwitchInput): Promise<NodeSwitchResult>
  /** 打开主进程自己的配置目录；不接受路径参数。 */
  openConfigDir(): Promise<SimpleResult>
  /**
   * 窗口按钮。只传动作名，不传任何几何或路径；`close` 销毁窗口而不是退出应用，
   * 代理与内核继续在托盘里运行。
   */
  windowControl(action: WindowAction): Promise<SimpleResult>
  /** 当前是否最大化；按钮文字与图标据此切换。 */
  getWindowState(): Promise<WindowStateView>
  /** 订阅最大化状态变化；返回取消订阅函数。 */
  onWindowState(cb: (state: WindowStateView) => void): () => void
  /** 开机自启的实际状态；开发态回持久化意向并带 `appliesToSystem: false`。 */
  getAutostart(): Promise<AutostartStateView>
  /**
   * 设置开机自启。返回动作之后重新读到的状态：失败时 `ok: false` 且 `state`
   * 是真实状态，渲染层据此把开关拨回去，不保留一个假的「已开启」。
   */
  setAutostart(enabled: boolean): Promise<AutostartSetResult>
}
