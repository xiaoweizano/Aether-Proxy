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

export interface ModeSetResult {
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
  statsPush: 'app:stats'
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
}
