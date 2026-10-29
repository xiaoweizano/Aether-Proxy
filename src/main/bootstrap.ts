import path from 'node:path'
import { readFile, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import YAML from 'yaml'
import { allocatePort } from './core/ports'
import { newSecret } from './core/secret'
import { CoreSupervisor } from './core/supervisor'
import { CoreRestarter, type RestarterOptions } from './core/restarter'
import { resolveMihomoBinary } from './core/binary'
import { classifyOrphan } from './core/orphan'
import { writeCoreState, inspectCoreState, clearCoreState } from './core/state'
import { mergeConfig } from './config/merge'
import { missingReferences } from './config/references'
import { writeRuntime } from './config/runtime'
import { reloadConfig } from './config/reload'
import { writeFileAtomic } from './config/atomic'
import { validateConfig } from './config/validate'
import { ensureGeodata } from './config/geodata'
import { ProxyOwnership } from './proxy/ownership'
import { SystemProxyController } from './proxy/controller'
import { FakePlatformProxy } from './proxy/fake'
import type { PlatformProxy } from './proxy/platform'
import { readSettings, writeSettings } from './settings'
import { CoreLink } from './core/link'
import { TrafficCollector, type StatsConnect, type TrafficSnapshot } from './stats'
import { ConnectionsCollector } from './connections'
import { LogsCollector } from './logs'
import type { ShutdownActions } from './shell/power'
import type { ConnectionsSnapshot, DialFailureCounts } from '../shared/ipc'
import type { Mode, CoreInfo } from '../shared/types'

export interface BootstrapOptions {
  userDataDir: string
  isPackaged: boolean
  resourcesPath: string
  repoRoot: string
  spawnFn?: typeof import('node:child_process').spawn
  fetchFn?: typeof fetch
  /** 测试注入；缺省时 Windows 用 loadWindowsProxy()。 */
  platformProxy?: PlatformProxy
  /** 测试注入；缺省时执行真实的 `mihomo -t`。 */
  validateFn?: (
    binary: string,
    homeDir: string,
    configPath: string
  ) => Promise<{ ok: boolean; output: string }>
  /** 测试注入；缺省时用 `ws` 建立真实连接。 */
  statsConnect?: StatsConnect
  /** `/connections` 采集器的测试注入；缺省时用 `ws` 建立真实连接。 */
  connectionsConnect?: StatsConnect
  /** `/logs` 采集器的测试注入；缺省时用 `ws` 建立真实连接。 */
  logsConnect?: StatsConnect
  /**
   * 孤儿内核身份校验的测试注入；缺省用 `process.kill(pid, 0)` 判断存活
   * （EPERM 说明进程存在但无权探测，仍按存活算）。
   */
  isProcessAliveFn?: (pid: number) => boolean
  /** 孤儿内核身份校验的测试注入；缺省在 Windows 上查 tasklist 映像名 + PowerShell 完整路径。 */
  processPathFn?: (pid: number, binary: string) => Promise<string | null>
  /** 孤儿内核终止的测试注入；缺省在 Windows 上用 `taskkill /F /PID <pid>`。 */
  killFn?: (pid: number) => Promise<void>
  /**
   * 退出取消信号。首次启动还没返回 context 时，上层没有 stopAll 可用，
   * 只能靠它叫停：置位后所有 await 边界放弃，并停掉可能已经 spawn 的内核。
   */
  signal?: AbortSignal
  /**
   * 采样回调。内核可能在窗口之后才起来（无配置 → 导入 → 重启），所以由 bootstrap
   * 在创建采集器时直接接上；窗口侧再调一次 `stats.start()` 只会替换成等价的回调。
   */
  onStatsSample?: (sample: TrafficSnapshot) => void
  /**
   * 连接快照回调。窗口销毁期间采集不能停（已结束连接要保留 60 秒），
   * 所以回调由 bootstrap 持有，窗口重建时再由装配层替换成新窗口的推送函数。
   */
  onConnectionsSnapshot?: (snapshot: ConnectionsSnapshot) => void
  /** 拨号失败计数回调；只在有新失败到达时触发（到期没有通知，见 logs.ts）。 */
  onLogCounts?: (counts: DialFailureCounts) => void
  /**
   * 崩溃后退避重启的测试注入（定时器、时钟、策略）。缺省用真实定时器、
   * 1s / 2s / 4s、10 分钟内 3 次。
   */
  restarter?: Pick<RestarterOptions, 'schedule' | 'now' | 'policy'>
}

export type AppStatus =
  | 'no-config'
  | 'ready'
  | 'config-error'
  | 'core-error'
  | 'in-use'
  /** 内核意外退出、正在按退避自动重启；不是健康状态，也不给手动重启入口。 */
  | 'reconnecting'
export type RestoreStatus = 'none' | 'restored' | 'conflict' | 'in-use'

export interface AppContext {
  /** 有效配置所在目录；尚无配置时为 null。 */
  profileDir: string | null
  /** 配置目录的固定路径，始终存在（导入配置时可能还需要创建）。 */
  configDir: string
  supervisor: CoreSupervisor
  controller: SystemProxyController
  ownership: ProxyOwnership
  mode: Mode
  setMode(mode: Mode): void
  startupStatus: AppStatus
  restore: RestoreStatus
  /** 实际系统代理状态，不是 settings 里的期望值。 */
  proxyEnabled: boolean
  proxyError?: string
  /** 内核写入系统的 mixed-port 地址；内核未运行时为 null。界面上只经 IPC 使用。 */
  proxyServer: string | null
  /** controller 客户端；内核未启动时为 null。 */
  link: CoreLink | null
  /** 当前内核信息；未运行时为 null。 */
  coreInfo: CoreInfo | null
  /** `/traffic` 采集器；内核停止或重启失败后为 null。停止由装配层与 stopAll 负责。 */
  stats: TrafficCollector | null
  /**
   * `/connections` 采集器；内核未运行时为 null。
   * 与 stats 不同：窗口销毁时**不停止**，否则重开窗口会丢掉 60 秒内的已结束连接。
   */
  connections: ConnectionsCollector | null
  /** `/logs` 采集器；内核未运行时为 null。同样不随窗口销毁停止。 */
  logs: LogsCollector | null
  /** 配置摘要（供状态页显示节点/策略组数量）；无配置时为 null。 */
  profile: { nodeCount: number; groupCount: number } | null
  /**
   * 停内核 → 重新读取 upstream.yaml、重新合并/校验 runtime.yaml → 启动 → 重写 core-state.json。
   * 必须重新生成配置：导入新配置后仅重启进程会用旧的 runtime.yaml，导入等于没生效。
   * 失败时上下文被置为对应的错误状态，并抛出可读错误。
   */
  restartCore(): Promise<CoreInfo>
  /**
   * 热重载：重新读 upstream.yaml → 合并并校验 runtime.yaml → `PUT /configs?force=true`。
   *
   * 与 `restartCore` 的分工：重启要停进程、还原再接管系统代理，**整机短暂断网**；
   * 热重载只换内核里的配置，端口、secret、采集器、系统代理都不动。导入订阅这类
   * 高频操作因此不必陪上一次断网。
   *
   * 失败必须可回滚：新配置校验不过或内核拒绝时，runtime.yaml 恢复成重载前的样子
   * （否则下次启动也会起不来），并抛出可读错误——导入本身已经成功，这里只是没生效。
   * 内核未运行时抛错，调用方据此提示「需要重启」。
   */
  reloadCore(): Promise<void>
  /** 内核重启成功后重写 core-state.json 等外部状态。 */
  onCoreRestarted(info: CoreInfo): Promise<void>
  stopAll(): Promise<void>
  /**
   * 关机 / 注销路径的三个动作，顺序由 `shell/power.ts` 的 `createShutdownHandler`
   * 决定，这里只交出「怎么取消重启、怎么还原代理、怎么请求停内核」。
   *
   * 为什么不复用 `stopAll()`：关机时被 OS 杀掉只是早晚的事，`stopAll` 把
   * 「还原代理（毫秒级、必须落地）」和「等内核 3 秒 SIGTERM 宽限（非关键）」
   * 串在同一个 await 后面；在它外面套竞速超时，内核一慢就先超时，代理还原被放弃。
   * 正是本任务要消灭的那条失败路径。
   */
  createShutdownActions(): ShutdownActions
}

/**
 * koffi 在模块加载时就会绑定 advapi32/wininet。非 Windows 平台（以及单元测试）
 * 不应触碰它，因此只在真的需要时动态加载。
 */
async function loadPlatformProxy(opts: BootstrapOptions): Promise<PlatformProxy> {
  if (opts.platformProxy) return opts.platformProxy
  if (process.platform === 'win32') {
    const { loadWindowsProxy } = await import('./proxy/win32')
    return loadWindowsProxy()
  }
  return new FakePlatformProxy({ enabled: false })
}

function idleSupervisor(
  binary: string,
  profileDir: string,
  opts: BootstrapOptions
): CoreSupervisor {
  return new CoreSupervisor({
    binary,
    homeDir: profileDir,
    configPath: path.join(profileDir, 'runtime.yaml'),
    controllerPort: 1,
    secret: 'unused',
    spawn: opts.spawnFn,
    fetchFn: opts.fetchFn
  })
}

/** 只保留可读的短消息；错误对象可能带堆栈，也可能被上层拼进日志。 */
function describeError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.slice(0, 300)
}

export interface ExecResultLike {
  stdout: string
}

/** 与 `execFile` 同形的最小执行器；测试可注入，生产实现见 `runExec`。 */
export type ExecFileFn = (
  file: string,
  args: string[],
  options: { encoding: 'utf8'; windowsHide: boolean; timeout: number }
) => Promise<ExecResultLike>

const execFileAsync = promisify(execFile)

const runExec: ExecFileFn = async (file, args, options) => {
  const { stdout } = await execFileAsync(file, args, options)
  return { stdout: String(stdout) }
}

/**
 * tasklist `/FO CSV /NH` 的首列就是映像名。没有匹配项时输出的是本地化的
 * INFO 文案（没有引号），返回 null；调用方按「身份无法确认」处理。
 */
export function parseTasklistCsvImage(stdout: string): string | null {
  const firstLine = stdout.trim().split(/\r?\n/, 1)[0] ?? ''
  return /^"([^"]+)"/.exec(firstLine)?.[1] ?? null
}

export async function queryImageName(
  pid: number,
  exec: ExecFileFn,
  platform: NodeJS.Platform = process.platform
): Promise<string | null> {
  if (platform !== 'win32') return null
  try {
    const { stdout } = await exec(
      'tasklist',
      ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
      { encoding: 'utf8', windowsHide: true, timeout: 3000 }
    )
    return parseTasklistCsvImage(stdout)
  } catch {
    return null
  }
}

/** 完整可执行路径；进程不存在、权限不足或 PowerShell 不可用时返回 null。 */
export async function queryFullPath(
  pid: number,
  exec: ExecFileFn,
  platform: NodeJS.Platform = process.platform
): Promise<string | null> {
  if (platform !== 'win32') return null
  try {
    const { stdout } = await exec(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `[Console]::OutputEncoding=[Text.Encoding]::UTF8; (Get-Process -Id ${pid} -ErrorAction Stop).Path`
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 }
    )
    const text = stdout.trim()
    return text === '' ? null : text
  } catch {
    return null
  }
}

/**
 * 先用 tasklist 的映像名做快速排除，再用完整路径做权威判定：
 * 同为 `mihomo.exe` 的 Clash Party sidecar 不能被误认成我们的内核。
 */
export async function processPathWith(
  pid: number,
  binary: string,
  exec: ExecFileFn,
  platform: NodeJS.Platform = process.platform
): Promise<string | null> {
  const image = await queryImageName(pid, exec, platform)
  if (image === null || image.toLowerCase() !== path.basename(binary).toLowerCase()) return null
  return queryFullPath(pid, exec, platform)
}

async function defaultProcessPath(pid: number, binary: string): Promise<string | null> {
  return processPathWith(pid, binary, runExec)
}

/** 与代理所有权判断一致：EPERM 说明进程存在但无权探测，仍按存活算。 */
export function isProcessAliveWith(
  pid: number,
  kill: (pid: number, signal: number) => void
): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function defaultIsProcessAlive(pid: number): boolean {
  return isProcessAliveWith(pid, process.kill)
}

export function taskkillArgs(pid: number): string[] {
  return ['/F', '/PID', String(pid)]
}

/** Windows 上用 taskkill 强杀；其它平台（M1 不支持）退回进程信号。 */
export async function terminateProcessWith(
  pid: number,
  exec: ExecFileFn,
  platform: NodeJS.Platform = process.platform,
  signal: (pid: number, sig: NodeJS.Signals) => void = process.kill
): Promise<void> {
  if (platform === 'win32') {
    await exec('taskkill', taskkillArgs(pid), {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000
    })
    return
  }
  signal(pid, 'SIGKILL')
}

async function defaultKill(pid: number): Promise<void> {
  await terminateProcessWith(pid, runExec)
}

type StaleProcessState = 'dead' | 'ours' | 'other'

/**
 * 终止前的身份校验：先确认 pid 仍存活，再确认完整可执行路径就是我们的 mihomo。
 * 只凭 `core-state.json` 里的 pid 直接杀会误伤被复用的 pid，或同名的其它 mihomo。
 */
async function inspectStaleProcess(
  pid: number,
  binary: string,
  isAlive: (pid: number) => boolean,
  pathOf: (pid: number, binary: string) => Promise<string | null>
): Promise<StaleProcessState> {
  if (!isAlive(pid)) return 'dead'
  let actual: string | null
  try {
    actual = await pathOf(pid, binary)
  } catch {
    return 'other'
  }
  if (actual === null || actual === '') return 'other'
  return sameExecutable(actual, binary) ? 'ours' : 'other'
}

/** 路径比较按当前平台解析并忽略大小写（Windows 的可执行路径不区分大小写）。 */
export function sameExecutable(actual: string, expected: string): boolean {
  return path.resolve(actual).toLowerCase() === path.resolve(expected).toLowerCase()
}

/**
 * 退出期间取消在途重启。单独成类是为了让 prepare 的 catch 能区分
 * 「配置有误」与「应用正在退出」：后者必须原样抛出，不能转成 config-error。
 */
class ShutdownAbortError extends Error {
  constructor() {
    super('应用正在退出，内核重启已取消')
    this.name = 'ShutdownAbortError'
  }
}

/**
 * 重启收尾期间内核又崩了：崩溃处理已经接管状态、调度与系统代理。
 * 这条路径必须立刻停手，不能再写 ready 或把代理指回一个刚死掉的端口。
 */
class CrashSupersededError extends Error {
  constructor() {
    super('内核在重启过程中再次退出')
    this.name = 'CrashSupersededError'
  }
}

/**
 * 让一个可能耗时（孤儿探测最多 1.5 秒）的 await 能被退出信号打断。
 * `work` 本身不会被取消（classifyOrphan 自带超时会自行收尾），只是不再等它。
 */
function raceShutdown<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work
  if (signal.aborted) return Promise.reject(new ShutdownAbortError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort)
      reject(new ShutdownAbortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      }
    )
  })
}

function normalizeMode(value: unknown): Mode {
  return value === 'global' || value === 'direct' ? value : 'rule'
}

function profileSummaryOf(upstream: unknown): { nodeCount: number; groupCount: number } | null {
  if (typeof upstream !== 'object' || upstream === null) return null
  const cfg = upstream as Record<string, unknown>
  const proxies = Array.isArray(cfg.proxies) ? cfg.proxies.length : 0
  const groups = Array.isArray(cfg['proxy-groups']) ? cfg['proxy-groups'].length : 0
  return { nodeCount: proxies, groupCount: groups }
}

export async function bootstrap(opts: BootstrapOptions): Promise<AppContext> {
  const configDir = path.join(opts.userDataDir, 'profiles', 'default')
  const proxyStateFile = path.join(opts.userDataDir, 'proxy-state.json')
  const coreStateFile = path.join(opts.userDataDir, 'core-state.json')
  const settingsFile = path.join(opts.userDataDir, 'settings.json')
  const geodataDir = opts.isPackaged
    ? path.join(opts.resourcesPath, 'geodata')
    : path.join(opts.repoRoot, 'vendor', 'geodata')
  const binary = resolveMihomoBinary({
    isPackaged: opts.isPackaged,
    resourcesPath: opts.resourcesPath,
    repoRoot: opts.repoRoot
  })

  const pp = await loadPlatformProxy(opts)
  const ownership = new ProxyOwnership(pp, proxyStateFile)
  const controller = new SystemProxyController(pp, ownership)

  // 端口与 secret 在会话内固定：重启内核时系统代理地址与 controller 客户端都不必换，
  // 也避免界面在两次重启之间看到端口跳动。首次真正需要内核时（可能是导入配置后的重启）才分配。
  let endpoints: { mixedPort: number; controllerPort: number; secret: string } | null = null
  const ensureEndpoints = async (): Promise<NonNullable<typeof endpoints>> => {
    endpoints ??= {
      mixedPort: await allocatePort(),
      controllerPort: await allocatePort(),
      secret: newSecret()
    }
    return endpoints
  }
  /** controller 客户端同样只建一次：重启内核不改变地址与 secret。 */
  let link: CoreLink | null = null
  const ensureLink = async (): Promise<CoreLink> => {
    if (link === null) {
      const ep = await ensureEndpoints()
      link = new CoreLink(`http://127.0.0.1:${ep.controllerPort}`, ep.secret, opts.fetchFn)
    }
    return link
  }

  /**
   * `/traffic` 采集器同样按会话复用：地址与 secret 不变，内核重启后靠自身的
   * 断线重连恢复，不会在每次重启时丢掉已有的 60 点缓冲。
   * 只在确定内核已起来之后调用。
   */
  let stats: TrafficCollector | null = null
  const ensureStats = (controllerPort: number, secret: string): TrafficCollector => {
    stats ??= new TrafficCollector({
      url: `ws://127.0.0.1:${controllerPort}/traffic`,
      secret,
      ...(opts.statsConnect === undefined ? {} : { connect: opts.statsConnect })
    })
    // 内核这时已经确认起来了；start 幂等，重启成功后复用同一实例与缓冲。
    stats.start(opts.onStatsSample)
    return stats
  }

  /**
   * 连接采集器与 stats 一样按会话复用：重启内核不改变 controller 地址与 secret，
   * 已有缓冲（含 60 秒内已结束的连接）必须保留。窗口销毁时**不停止**，
   * 由装配层在重建窗口时替换回调。
   */
  let connections: ConnectionsCollector | null = null
  const ensureConnections = (controllerPort: number, secret: string): ConnectionsCollector => {
    connections ??= new ConnectionsCollector({
      url: `ws://127.0.0.1:${controllerPort}/connections?interval=500`,
      secret,
      ...(opts.connectionsConnect === undefined ? {} : { connect: opts.connectionsConnect })
    })
    connections.start(opts.onConnectionsSnapshot)
    return connections
  }

  /** 日志采集器同上：计数窗口跨窗口重建与内核重启都要连续。 */
  let logs: LogsCollector | null = null
  const ensureLogs = (controllerPort: number, secret: string): LogsCollector => {
    logs ??= new LogsCollector({
      url: `ws://127.0.0.1:${controllerPort}/logs?level=warning`,
      secret,
      ...(opts.logsConnect === undefined ? {} : { connect: opts.logsConnect })
    })
    logs.start(opts.onLogCounts)
    return logs
  }

  // 用户期望的代理开关独立于所有权快照：proxy-state.json 正常退出时会被删除，
  // 不能用来回答「上次代理是否开着」。
  const settings = await readSettings(settingsFile)

  // 先还原上次异常退出留下的系统代理，再读配置。这样 in-use 时不会
  // 改动另一个存活实例正在使用的 profile 文件，也不会启动第二个内核。
  const restore = await ownership.restoreOnStartupIfStale()

  // stopAll / restartCore 必须作用于当前这一个 supervisor；重启会换新的实例。
  let activeSupervisor = idleSupervisor(binary, configDir, opts)

  /**
   * 退出协调（C1）：
   * - stopAll 在任何 await 之前同步置位，之后所有在途重启都会在下一个 await 边界放弃；
   * - stopAll 还会等待在途重启结束，避免「清理完成 → 重启继续 spawn」留下孤儿内核
   *   （Windows 不随父进程回收 mihomo）。
   * 这里做成每个 bootstrap 实例一份，而不是模块级全局：测试可以并行建多个上下文，
   * 全局标志会互相污染；语义上仍满足「清理开始前置位、每个 await 边界检查」。
   */
  let shuttingDown = opts.signal?.aborted === true
  // 外部取消（首次启动期间退出）与 stopAll 走同一套放弃语义。
  opts.signal?.addEventListener('abort', () => { shuttingDown = true }, { once: true })
  const assertNotShuttingDown = (): void => {
    if (shuttingDown) throw new ShutdownAbortError()
  }
  const inFlightRestarts = new Set<Promise<unknown>>()
  /** 崩溃处理要能改到最终 ctx；ctx 由 makeContext 在启动流程末尾创建。 */
  let activeContext: AppContext | null = null

  /**
   * 内核崩溃后的自动重启。规格：1s / 2s / 4s 退避，10 分钟内最多 3 次，
   * 用尽后转 core-error 并把「重启内核」还给用户。
   *
   * 计数按崩溃次数而不是成功次数：一次崩溃 = 一次 notifyExit = 一次尝试，
   * 重启成功也不清空（窗口内仍要受 3 次上限约束）。
   */
  const restarter = new CoreRestarter({
    ...(opts.restarter?.now === undefined ? {} : { now: opts.restarter.now }),
    ...(opts.restarter?.schedule === undefined ? {} : { schedule: opts.restarter.schedule }),
    ...(opts.restarter?.policy === undefined ? {} : { policy: opts.restarter.policy }),
    start: () => startAutoRestart()
  })
  /** 每次真正处理一次内核退出就自增；用来识别「本次尝试里已有崩溃事件接管了调度」。 */
  let exitSeq = 0
  /** 已调度、尚未触发的自动重启。同一次崩溃只应调度一次。 */
  let restartPending = false
  /**
   * 每次取消自动重启就自增。定时器可能已经「到点」并排在重启锁后面，
   * 光靠 cancel() 拦不住它；排到时比对这一代，过期就放弃。
   */
  let restartGeneration = 0
  /** 当前这次调度所属的代号；与 `restartGeneration` 不等说明已被取消。 */
  let scheduledGeneration = 0
  /** 重启串行锁：手动与自动重启不得并发，否则会同时拉起两个内核。 */
  let restartLock: Promise<unknown> = Promise.resolve()
  /** 崩溃时的代理期望；崩溃处理会还原系统代理，自动重启成功后按它决定是否重新接管。 */
  let crashWantProxy = false
  /**
   * 是否处在一轮崩溃里（第一次崩溃到下一次成功重启之间）。只在进档时取一次
   * 代理意愿：一轮里后续的崩溃多半发生在重启途中，那时系统代理已经被还原，
   * 再取一次会把「用户本来开着」读成「用户关着」。
   */
  let inCrashBurst = false
  /** 崩溃处理里的代理还原；自动重启要等它落定再决定代理，避免和它抢时序。 */
  let crashCleanup: Promise<void> | null = null
  /** 自动重启的执行体；由 attachRestart 装配（in-use 上下文没有可崩溃的内核）。 */
  let autoRestartRun: (() => Promise<CoreInfo>) | null = null

  /**
   * 停掉全部采集器并对上层暴露 null。实例本身保留：内核回来后 ensure* 复用它，
   * 连同已有缓冲（流量图、已结束连接、失败计数窗口都要跨重启连续）。
   */
  const stopCollectors = (ctx: AppContext): void => {
    for (const collector of [stats, connections, logs]) {
      try {
        collector?.stop()
      } catch {
        // stop 不抛错；这里只防御性处理，不让清理路径再失败一次。
      }
    }
    ctx.stats = null
    ctx.connections = null
    ctx.logs = null
  }

  /**
   * 登记在途重启。stopAll 先置退出标志、再 await 这些 promise：
   * 重启会在下一个 await 边界看到标志并放弃，绝不会在清理完成后继续 spawn。
   */
  const trackRestart = <T>(running: Promise<T>): Promise<T> => {
    const tracked = running.finally(() => {
      inFlightRestarts.delete(tracked)
    })
    inFlightRestarts.add(tracked)
    return tracked
  }

  /** 串行执行重启；前一次失败不影响后一次，只有先后顺序。 */
  const withRestartLock = <T>(task: () => Promise<T>): Promise<T> => {
    const result = restartLock.then(
      () => task(),
      () => task()
    )
    restartLock = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  /** 调度一次自动重启；false 表示退避已用尽（调用方负责转 core-error）。 */
  const scheduleRestart = (): boolean => {
    if (shuttingDown) return false
    if (restartPending) return true
    const plan = restarter.notifyExit()
    if (!plan.scheduled) return false
    restartPending = true
    scheduledGeneration = restartGeneration
    return true
  }

  /** 取消尚未触发的自动重启：stopAll 与用户手动重启都要求不再有后台定时器。 */
  const cancelRestarts = (): void => {
    restartPending = false
    restartGeneration += 1
    restarter.cancel()
  }

  /**
   * 退避定时器触发：执行一次自动重启。
   *
   * 与退出赛跑：定时器可能和 stopAll 落在同一个 tick。shuttingDown 在 stopAll 的
   * 第一个 await 之前同步置位；排队等锁的那一段再比对一次代号，两种情况下都不 spawn。
   */
  async function startAutoRestart(): Promise<void> {
    restartPending = false
    const gen = scheduledGeneration
    const run = autoRestartRun
    if (run === null) return
    const seq = exitSeq
    try {
      const result = await trackRestart(
        withRestartLock(async () => {
          // 真正拿到锁时再判一次：这一代可能在排队期间被 cancel()（手动重启 / 退出）。
          // 不抛错——那是取消，不是失败，不能被下面的 catch 再记一次尝试。
          if (shuttingDown || gen !== restartGeneration) return null
          return run()
        })
      )
      if (result === null) return
    } catch (err) {
      if (shuttingDown || err instanceof ShutdownAbortError) return
      // 本次尝试里的崩溃已经由 handleCoreExit 重新调度过（含重启收尾途中又崩）：
      // 一次失败只算一次，否则「起不来的内核」会在每次尝试里被记两笔，
      // 3 次上限会提前用尽。
      if (err instanceof CrashSupersededError || exitSeq !== seq) return
      if (scheduleRestart()) {
        // 失败的具体原因（配置错误等）由重启路径写进了 ctx；只要还在退避重试，
        // 界面对用户事实就是「重连中」，不能显示成终态并递出手动重启。
        if (activeContext !== null) activeContext.startupStatus = 'reconnecting'
        return
      }
      markCoreUnavailable()
    }
  }

  /** 自动重启彻底放弃：用户重新拿到手动重启入口。 */
  const markCoreUnavailable = (): void => {
    const ctx = activeContext
    if (ctx === null) return
    ctx.startupStatus = 'core-error'
  }

  /**
   * 内核在运行中被意外终止（崩溃、被外部杀掉）。三件事：
   * 1. 停止说谎：清空内核视图、停采集器、还原系统代理（否则整机断网）；
   * 2. 状态转 reconnecting，按 1s / 2s / 4s 退避调度自动重启；
   * 3. 退避用尽（10 分钟内第 4 次）才转 core-error，把手动重启还给用户。
   *
   * 一次崩溃只调度一次：这里直接接触发路径，主进程里没有第二个 notifyExit 调用方；
   * 重启尝试自身的失败由 startAutoRestart 的 catch 处理，且会先比对 exitSeq，
   * 避免「新内核又崩了」被同时记成两次尝试。
   *
   * 主动 stop() 不会走到这里：CoreSupervisor 先把状态置为 stopped。
   */
  const handleCoreExit = (supervisor: CoreSupervisor): void => {
    // 退出清理已经开始，或事件来自已被替换的旧实例：忽略。
    if (shuttingDown || activeSupervisor !== supervisor) return
    const ctx = activeContext
    if (ctx === null) return
    exitSeq += 1
    ctx.coreInfo = null
    ctx.link = null
    ctx.proxyServer = null
    stopCollectors(ctx)
    ctx.supervisor = supervisor
    // 代理的「用户意愿」必须在还原之前取：还原会改写 ctx.proxyEnabled。
    // 只在一轮崩溃的起点取一次，见 inCrashBurst。
    if (!inCrashBurst) {
      crashWantProxy = ctx.proxyEnabled
      inCrashBurst = true
    }
    // 先给出「正在重连」，再尝试调度；退避已用尽时立刻回落成核心错误。
    ctx.startupStatus = 'reconnecting'
    if (!scheduleRestart()) markCoreUnavailable()
    crashCleanup = (async () => {
      // 内核死了，系统代理还指向 mixed-port 会让整机断网：与 stopAll 一样先还原。
      try {
        await controller.disable()
      } catch (err) {
        ctx.proxyError = describeError(err)
      }
      try {
        ctx.proxyEnabled = (await pp.getSystemProxy()).enabled === true
      } catch {
        ctx.proxyEnabled = false
      }
    })()
  }

  /**
   * 上次运行可能在 core-state.json 里留下一个没被回收的 mihomo
   * （Windows 不会随父进程回收子进程）。启动前按旧 secret 探测：
   * - 记录属于另一个仍存活的 Aether 实例：不探测、不终止、不删记录；
   * - `ours`：完整路径身份校验通过才 taskkill /F，避免 pid 复用或同名 mihomo 误杀；
   * - `foreign` / `none` / 进程已死：不动任何进程，旧记录已失效，删除；
   * - 身份不明 / 终止失败 / 退出取消：保留记录，下次启动还能再试。
   *
   * 探测、身份校验、终止失败都只记 warning，绝不阻断启动。
   * 探测最多 1.5 秒，退出信号必须在 await 边界就能打断它。
   */
  const clearStaleRecord = async (): Promise<void> => {
    await clearCoreState(coreStateFile).catch((err) => {
      console.warn('[aether] 无法删除遗留的内核状态文件：', describeError(err))
    })
  }

  const cleanStaleCore = async (): Promise<void> => {
    const read = await inspectCoreState(coreStateFile)
    if (read.kind === 'missing' || read.kind === 'unreadable') return
    if (read.kind === 'corrupt') {
      // 读到了内容但解析/结构不对：确定损坏。临时读错误（EBUSY 等）在上面放过了。
      await clearStaleRecord()
      return
    }

    const stale = read.state
    const isAlive = opts.isProcessAliveFn ?? defaultIsProcessAlive
    const pathOf = opts.processPathFn ?? defaultProcessPath
    const kill = opts.killFn ?? defaultKill

    // 写这条记录的实例仍活着：它的内核可能正在用，不能探测、终止，更不能删记录。
    // 旧文件没有 ownerPid，只能走原来的探测路径（唯一的迁移情况）。
    if (
      stale.ownerPid !== undefined &&
      stale.ownerPid !== process.pid &&
      isAlive(stale.ownerPid)
    ) {
      return
    }

    assertNotShuttingDown()
    const verdict = await raceShutdown(
      // secret 只作为探测参数使用，不写日志、不进错误消息。
      classifyOrphan({ port: stale.port, oldSecret: stale.secret, fetchFn: opts.fetchFn }),
      opts.signal
    )
    assertNotShuttingDown()
    if (verdict !== 'ours') {
      // 端口属于别的程序，或已经没人监听：旧记录已失效。
      await clearStaleRecord()
      return
    }

    const state = await raceShutdown(
      inspectStaleProcess(stale.pid, binary, isAlive, pathOf),
      opts.signal
    )
    assertNotShuttingDown()
    if (state === 'dead') {
      // pid 已经不在了，孤儿内核也随之消失。
      await clearStaleRecord()
      return
    }
    if (state === 'other') {
      console.warn(
        `[aether] 上次记录的内核进程仍在运行，但身份无法确认（pid ${stale.pid}），已跳过终止`
      )
      // 保留记录：身份不明时删掉，真正的孤儿以后就找不到了。
      return
    }

    try {
      await raceShutdown(kill(stale.pid), opts.signal)
      console.info(`[aether] 已终止上次遗留的内核进程（pid ${stale.pid}）`)
      await clearStaleRecord()
    } catch (err) {
      // 退出取消必须原样向上抛，由启动流程统一处理；记录必须保留。
      if (err instanceof ShutdownAbortError) throw err
      console.warn(
        `[aether] 未能终止上次遗留的内核进程（pid ${stale.pid}）：`,
        describeError(err)
      )
      // 终止失败：保留记录，下次启动还能再试。
    }
  }

  /**
   * 退出 / 启动失败路径只清理属于自己的记录。另一个存活实例的记录不能删，
   * 否则它下次崩溃时自己的内核就无法被识别。读失败（unreadable）同样不删。
   */
  const clearCoreStateIfOwned = async (): Promise<void> => {
    const read = await inspectCoreState(coreStateFile)
    if (read.kind === 'unreadable') return
    if (
      read.kind === 'ok' &&
      read.state.ownerPid !== undefined &&
      read.state.ownerPid !== process.pid
    ) {
      return
    }
    await clearCoreState(coreStateFile)
  }

  interface Prepared {
    supervisor: CoreSupervisor
    link: CoreLink
    proxyServer: string
    controllerPort: number
    secret: string
    mode: Mode
    profile: { nodeCount: number; groupCount: number } | null
  }
  type PrepareResult =
    | { ok: true; prepared: Prepared }
    | { ok: false; status: 'no-config' | 'config-error'; profile: Prepared['profile'] }

  /**
   * 由 upstream.yaml 生成并校验 runtime.yaml，**不碰进程**。
   *
   * `prepare`（启动 / 重启）与 `reloadRuntime`（热重载）共用这一段：两条路径都必须
   * 重新生成配置，否则用的还是导入前的旧文件——导入等于没生效。
   *
   * 返回 null 表示配置引用了不存在的节点或策略组（已写日志），调用方按 config-error 处理。
   */
  async function buildRuntime(
    upstream: unknown,
    ep: { mixedPort: number; controllerPort: number; secret: string }
  ): Promise<{ configPath: string; mode: Mode } | null> {
    const merged = mergeConfig(upstream, {}, ep)
    const missing = missingReferences(merged)
    if (missing.length > 0) {
      console.warn(`[aether] 配置引用缺失：${missing.join(', ')}`)
      return null
    }
    const configPath = await writeRuntime(configDir, merged)
    return { configPath, mode: normalizeMode(merged.mode) }
  }

  async function prepare(): Promise<PrepareResult> {
    assertNotShuttingDown()
    let upstreamText: string | null = null
    try {
      upstreamText = await readFile(path.join(configDir, 'upstream.yaml'), 'utf8')
    } catch {
      upstreamText = null
    }
    assertNotShuttingDown()
    if (upstreamText === null) return { ok: false, status: 'no-config', profile: null }

    let upstream: unknown
    try {
      upstream = YAML.parse(upstreamText)
    } catch {
      // 解析错误信息会带出配置片段，可能含订阅凭据，不写入日志。
      console.warn('[aether] upstream.yaml 解析失败，跳过内核启动')
      return { ok: false, status: 'config-error', profile: null }
    }
    const profile = profileSummaryOf(upstream)
    const ep = await ensureEndpoints()
    assertNotShuttingDown()
    const configPath = path.join(configDir, 'runtime.yaml')
    const supervisor = new CoreSupervisor({
      binary,
      homeDir: configDir,
      configPath,
      controllerPort: ep.controllerPort,
      secret: ep.secret,
      spawn: opts.spawnFn,
      fetchFn: opts.fetchFn,
      // 只在本次实例仍是活跃内核时处理退出；重启替换后的旧实例事件必须忽略。
      onExit: () => { handleCoreExit(supervisor) }
    })
    activeSupervisor = supervisor

    try {
      await ensureGeodata(configDir, geodataDir)
      assertNotShuttingDown()
      const built = await buildRuntime(upstream, ep)
      if (built === null) return { ok: false, status: 'config-error', profile }
      assertNotShuttingDown()
      const validate = opts.validateFn ?? validateConfig
      const validated = await validate(binary, configDir, configPath)
      // 校验返回后、spawn 之前是最后一个放弃点：此后 stopAll 能通过
      // ctx.supervisor 找到活着的内核，不再需要取消。
      assertNotShuttingDown()
      if (!validated.ok) {
        console.warn('[aether] 内核配置校验失败，已跳过启动')
        return { ok: false, status: 'config-error', profile }
      }
      const preparedLink = await ensureLink()
      assertNotShuttingDown()
      return {
        ok: true,
        prepared: {
          supervisor,
          link: preparedLink,
          proxyServer: `127.0.0.1:${ep.mixedPort}`,
          controllerPort: ep.controllerPort,
          secret: ep.secret,
          mode: built.mode,
          profile
        }
      }
    } catch (err) {
      // 退出取消不能被当成配置错误：否则会覆盖用户在退出前的代理偏好，
      // 也会把 core-error 之类的状态写进正在关闭的上下文。
      if (err instanceof ShutdownAbortError) throw err
      console.warn('[aether] 配置准备失败：', describeError(err))
      return { ok: false, status: 'config-error', profile }
    }
  }

  type StartResult =
    | { ok: true; prepared: Prepared; info: CoreInfo }
    | { ok: false; status: 'no-config' | 'config-error'; profile: Prepared['profile'] }
    | { ok: false; status: 'core-error'; profile: Prepared['profile'] }

  async function startCore(): Promise<StartResult> {
    const prep = await prepare()
    if (!prep.ok) return prep
    const { prepared } = prep
    // 最后一个 await 边界：这里之后才真正 spawn。退出清理一旦开始就不再拉起进程。
    assertNotShuttingDown()
    try {
      const info = await prepared.supervisor.start()
      await writeCoreState(coreStateFile, {
        pid: info.pid,
        port: prepared.controllerPort,
        secret: prepared.secret
      })
      // 只有内核真的起来之后才有 /traffic 可连；采集器在这里创建并开始采样，
      // 消费者（窗口推送）由装配层通过 onStatsSample 提供。
      ensureStats(prepared.controllerPort, prepared.secret)
      // 连接与日志采集器同理；它们的回调在窗口销毁期间只丢弃推送，采集本身继续。
      ensureConnections(prepared.controllerPort, prepared.secret)
      ensureLogs(prepared.controllerPort, prepared.secret)
      return { ok: true, prepared, info }
    } catch (err) {
      console.warn('[aether] 内核启动失败：', describeError(err))
      await prepared.supervisor.stop().catch(() => {})
      await clearCoreStateIfOwned().catch(() => {})
      return { ok: false, status: 'core-error', profile: prepared.profile }
    }
  }

  interface ContextOverrides {
    profileDir: string | null
    startupStatus: AppStatus
    mode?: Mode
    proxyEnabled?: boolean
    proxyError?: string
    proxyServer?: string | null
    link?: CoreLink | null
    coreInfo?: CoreInfo | null
    stats?: TrafficCollector | null
    connections?: ConnectionsCollector | null
    logs?: LogsCollector | null
    profile?: Prepared['profile']
  }

  /**
   * 给非 in-use 上下文装上重启能力：导入配置后状态页要用它把新配置真正加载进内核。
   * 重启会重新读 upstream.yaml、重新合并并校验 runtime.yaml，而不是拿旧文件重启进程。
   */
  /** 把 runtime.yaml 恢复成热重载之前的样子；没有旧文件时删掉刚写坏的。 */
  async function restoreRuntime(configPath: string, previous: string | null): Promise<void> {
    if (previous !== null) {
      await writeFileAtomic(configPath, previous).catch(() => {})
      return
    }
    await rm(configPath, { force: true }).catch(() => {})
  }

  /**
   * 热重载：让新导入的配置在**不重启进程**的情况下生效。
   *
   * 三条不变量：
   * 1. 只在内核确实 ready 时执行——内核不在就先写文件，交给「重启」路径去加载；
   * 2. 先校验再 PUT：`mihomo -t` 不过的配置绝不交给内核，旧文件原样恢复；
   * 3. 内核拒绝（非 2xx）时把磁盘恢复成它当前正在用的那份，并**再 PUT 一次**，
   *    避免「文件里是新配置、内核里是旧配置、界面不知道该说哪一个」。
   */
  async function reloadRuntime(): Promise<void> {
    assertNotShuttingDown()
    const current = activeContext
    const ep = endpoints
    if (
      current === null ||
      ep === null ||
      current.startupStatus !== 'ready' ||
      current.link === null
    ) {
      throw new Error('内核未运行，无法热重载')
    }

    const configPath = path.join(configDir, 'runtime.yaml')
    // 旧文件留作回滚；读不到说明还没跑过 prepare，那就没有可回滚的旧配置。
    const previous = await readFile(configPath, 'utf8').catch(() => null)
    let upstreamText: string
    try {
      upstreamText = await readFile(path.join(configDir, 'upstream.yaml'), 'utf8')
    } catch {
      throw new Error('还没有配置，无法热重载')
    }
    let upstream: unknown
    try {
      upstream = YAML.parse(upstreamText)
    } catch {
      throw new Error('配置有误：YAML 解析失败')
    }
    assertNotShuttingDown()

    const built = await buildRuntime(upstream, ep)
    if (built === null) {
      await restoreRuntime(configPath, previous)
      throw new Error('配置有误：引用了不存在的节点或策略组')
    }
    const validate = opts.validateFn ?? validateConfig
    const validated = await validate(binary, configDir, built.configPath)
    if (!validated.ok) {
      console.warn('[aether] 热重载前的配置校验失败')
      await restoreRuntime(configPath, previous)
      throw new Error('配置有误，内核未能通过校验')
    }
    assertNotShuttingDown()

    const res = await reloadConfig(ep.controllerPort, ep.secret, built.configPath, opts.fetchFn)
    if (!res.ok) {
      await restoreRuntime(configPath, previous)
      await reloadConfig(ep.controllerPort, ep.secret, configPath, opts.fetchFn)
      throw new Error(`内核拒绝了新配置（HTTP ${res.status}）`)
    }

    current.profile = profileSummaryOf(upstream)
    // 内核按 runtime.yaml 里的模式加载；把本会话里用户选过的模式补回去。
    if (current.mode !== built.mode) {
      await current.link.setMode(current.mode).catch(() => {})
    }
  }

  const attachRestart = (ctx: AppContext): void => {
    // 热重载与重启挂在同一处：两者都只对「自己拥有内核」的上下文有意义。
    ctx.reloadCore = reloadRuntime
    // 端口与 secret 由本次会话固定，状态文件只需跟着新的 pid 重写，
    // 否则下次启动无法识别残留内核。
    ctx.onCoreRestarted = async (info: CoreInfo) => {
      if (endpoints === null) return
      await writeCoreState(coreStateFile, {
        pid: info.pid,
        port: endpoints.controllerPort,
        secret: endpoints.secret
      })
    }

  interface RestartOptions {
    /**
     * 新内核起来后是否重新接管系统代理。手动重启取当前实际状态；
     * 自动重启必须取崩溃前的用户意愿——崩溃处理已经把系统代理还原了。
     */
    wantProxy: boolean
    /**
     * 失败时是否把「代理关闭」落盘。手动重启要保持原语义（否则下次启动又会
     * 把代理指向一个起不来的内核）；自动重启不写：一次失败的尝试之后还会重试，
     * 不能因为中间那一次失败就把用户的偏好永久改掉。
     */
    persistProxyOffOnFailure: boolean
    /**
     * 自动重启。失败时不能落成终态（config-error / core-error）——后台还会按退避
     * 继续重试，界面要一直停在「重连中」，直到重试成功或退避用尽。
     */
    automatic?: boolean
    /** 崩溃处理里的代理还原；自动重启先等它落定，避免两条还原路径互相踩。 */
    afterCrashCleanup?: Promise<void> | null
  }

  const restart = async ({
    wantProxy,
    persistProxyOffOnFailure,
    automatic = false,
    afterCrashCleanup
  }: RestartOptions): Promise<CoreInfo> => {
    // 退出清理已开始时直接放弃：调用方（IPC）会把异常映射成 {ok:false}。
    assertNotShuttingDown()
    /** 本次尝试开始时的崩溃序号；变化说明内核已在本次尝试中间退出。 */
    const seq = exitSeq
    if (afterCrashCleanup !== undefined && afterCrashCleanup !== null) {
      // 崩溃处理正在还原系统代理；先等它落定，避免两条还原路径互相踩。
      await afterCrashCleanup
      assertNotShuttingDown()
    }
    // 停内核期间系统代理仍指向 mixed-port，整机会短暂断网。先还原系统代理，
    // 成功启动后再按用户此前的意愿重新接管；失败则保持关闭。
    if (wantProxy) ctx.proxyError = undefined
    if (wantProxy) {
      try {
        await controller.disable()
      } catch (err) {
        ctx.proxyError = describeError(err)
      }
      assertNotShuttingDown()
      try {
        ctx.proxyEnabled = (await pp.getSystemProxy()).enabled === true
      } catch (err) {
        ctx.proxyEnabled = false
        ctx.proxyError ??= describeError(err)
      }
      assertNotShuttingDown()
    }

    await activeSupervisor.stop()
    // spawn 之前的最后一个取消点；startCore 内部在 validate 之后、spawn 之前
    // 还有一道同样的检查。
    assertNotShuttingDown()
    const restarted = await startCore()
    // 本次尝试期间新内核又崩过一次：崩溃处理已经接管了状态、退避调度与系统代理。
    // 继续往下会把状态改回 ready，甚至把系统代理指向一个刚死掉的端口。
    if (exitSeq !== seq) {
      // startCore 可能刚刚重新 start 过采集器（复用同一实例）；那条 WS 已经没有
      // 内核可连，停掉它，否则重连定时器会一直拖住退出。
      stopCollectors(ctx)
      throw new CrashSupersededError()
    }
    if (!restarted.ok) {
      const message =
        restarted.status === 'no-config'
          ? '还没有配置，无法启动内核'
          : restarted.status === 'config-error'
            ? '配置有误，无法启动内核'
            : '内核启动失败'
      ctx.startupStatus = restarted.status
      // 自动重启失败只是这一轮失败：后台还会按退避重试，界面必须一直停在
      // 「重连中」，否则会给用户递出手动重启按钮，和定时器抢着 spawn。
      if (automatic) ctx.startupStatus = 'reconnecting'
      ctx.profileDir = restarted.status === 'no-config' ? null : configDir
      ctx.profile = restarted.profile
      ctx.coreInfo = null
      ctx.link = null
      ctx.proxyServer = null
      // 内核没起来就没有可采集的流量：停掉并对上层暴露 null。实例本身保留，
      // 下次重启成功后 ensureStats 会复用它（连同已有缓冲）。
      stopCollectors(ctx)
      // prepare 失败时 supervisor 可能已被替换（配置有误）；同步给调用方与 stopAll。
      ctx.supervisor = activeSupervisor

      // 内核不在了，系统代理还指向 mixed-port 会让整机上不了网。再兜一次底
      // （上面的 disable 可能已成功或已失败），并如实记录实际状态。
      try {
        await controller.disable()
      } catch (err) {
        ctx.proxyError ??= describeError(err)
      }
      try {
        ctx.proxyEnabled = (await pp.getSystemProxy()).enabled === true
      } catch {
        ctx.proxyEnabled = false
      }

      // 用户期望值也要落盘为关闭：否则下次启动照着 settings 重试，
      // 又会把系统代理指向一个起不来的内核。自动重启不写（见 RestartOptions）。
      if (wantProxy && persistProxyOffOnFailure) {
        try {
          await writeSettings(settingsFile, { proxyEnabled: false })
        } catch (err) {
          ctx.proxyError ??= `设置未能保存：${describeError(err)}`
        }
      }
      throw new Error(message)
    }

    const { prepared, info } = restarted
    ctx.startupStatus = 'ready'
    ctx.profileDir = configDir
    ctx.profile = prepared.profile
    ctx.coreInfo = info
    ctx.link = prepared.link
    ctx.proxyServer = prepared.proxyServer
    ctx.supervisor = prepared.supervisor
    ctx.stats = ensureStats(prepared.controllerPort, prepared.secret)
    ctx.connections = ensureConnections(prepared.controllerPort, prepared.secret)
    ctx.logs = ensureLogs(prepared.controllerPort, prepared.secret)
    await ctx.onCoreRestarted(info)

    // 重启后内核按 runtime.yaml 的模式启动；把本会话里用户选过的模式补回去。
    if (ctx.mode !== prepared.mode) await prepared.link.setMode(ctx.mode)

    // 等代理真正写回后再复核一次：写的过程中新内核又崩了，就不能留下「已接管」的假象。
    // mixed-port 在会话内不变，但代理所有权需要指向新内核。
    if (wantProxy) {
      try {
        await controller.enable(prepared.proxyServer)
      } catch (err) {
        ctx.proxyError = describeError(err)
      }
      try {
        ctx.proxyEnabled = (await pp.getSystemProxy()).enabled === true
      } catch (err) {
        ctx.proxyEnabled = false
        ctx.proxyError ??= describeError(err)
      }
    }
    if (exitSeq !== seq) throw new CrashSupersededError()
    // 一轮崩溃到此结束：下一次崩溃重新按当时实际状态取代理意愿。
    inCrashBurst = false
    return info
  }

  /**
   * 手动重启（IPC「重启内核」、状态页）。会取消尚未触发的自动重启：
   * 用户已经接手，后台定时器再拉起一次就会变成两个内核。
   * 与自动重启串行，绝不同时进行。
   */
  ctx.restartCore = (): Promise<CoreInfo> => {
    cancelRestarts()
    // 崩溃一轮里用户手动接手：代理意愿仍是崩溃前的那个，此时 ctx.proxyEnabled
    // 已经被崩溃处理还原成 false，直接取它会静默把用户的代理关掉。
    const wantProxy = inCrashBurst ? crashWantProxy : ctx.proxyEnabled
    return trackRestart(
      withRestartLock(() => restart({ wantProxy, persistProxyOffOnFailure: true }))
    )
  }

  /**
   * 自动重启：与手动重启同一套「停 → 重新读配置 → 校验 → 启动 → 重写状态」，
   * 但代理意愿取崩溃前的值（崩溃处理已经还原），失败也不落盘代理偏好。
   *
   * 复用同一条执行体而不是再写一份：重启的核心不变量是「必须重新生成
   * runtime.yaml」，任何绕过它的捷径都会让导入的新配置在崩溃恢复后不生效；
   * 采样器、日志采集器、模式回写、core-state 重写也都在那条路径上。
   */
  autoRestartRun = (): Promise<CoreInfo> =>
    restart({
      wantProxy: crashWantProxy,
      persistProxyOffOnFailure: false,
      automatic: true,
      afterCrashCleanup: crashCleanup
    })
}

  /** 所有返回分支共用同一套字段，避免漏掉新增字段时类型上侥幸通过。 */
  const makeContext = (over: ContextOverrides): AppContext => {
    const ctx: AppContext = {
      profileDir: over.profileDir,
      configDir,
      supervisor: activeSupervisor,
      controller,
      ownership,
      mode: over.mode ?? 'rule',
      setMode(mode) {
        ctx.mode = mode
      },
      startupStatus: over.startupStatus,
      restore,
      proxyEnabled: over.proxyEnabled ?? false,
      ...(over.proxyError === undefined ? {} : { proxyError: over.proxyError }),
      proxyServer: over.proxyServer ?? null,
      link: over.link ?? null,
      coreInfo: over.coreInfo ?? null,
      stats: over.stats ?? null,
      connections: over.connections ?? null,
      logs: over.logs ?? null,
      profile: over.profile ?? null,
      restartCore: async () => {
        throw new Error('内核未运行，无法重启')
      },
      reloadCore: async () => {
        throw new Error('内核未运行，无法热重载')
      },
      onCoreRestarted: async () => {},
      // 退出清理只有一份实现，且读取活跃字段：no-config 下导入配置并重启后，
      // 这里必须停住那个刚起来的 supervisor，而不是启动时的 idle 替身。
      stopAll: async () => {
        // in-use：内核与状态文件属于另一个存活实例，退出时一个都不能动。
        if (ctx.startupStatus === 'in-use') return
        // 退避定时器必须是第一件被取消的事，而且必须在任何 await 之前：
        // 否则一个恰好在同一 tick 到期的定时器会在清理过程中把内核重新拉起。
        cancelRestarts()
        // 同步置位必须发生在第一个 await 之前：这样在途重启在下一个边界就会放弃。
        shuttingDown = true
        // 等在途重启真正结束再做清理，而不是和它赛跑。重启已被取消，通常会很快拒绝。
        if (inFlightRestarts.size > 0) {
          await Promise.allSettled([...inFlightRestarts])
        }
        const errors: unknown[] = []
        try {
          await controller.disable()
        } catch (err) {
          errors.push(err)
        }
        // 内核先真正停下，再删身份记录：否则进程在 SIGTERM 宽限期内被强杀时，
        // mihomo 还活着，而唯一能识别它的 core-state.json 已经没了。
        try {
          await activeSupervisor.stop()
        } catch (err) {
          errors.push(err)
        }
        // 采集器必须在退出路径上停下：否则 ws 的重连定时器会拖住事件循环，
        // 进程无法随 app.quit() 一起结束。
        stopCollectors(ctx)
        try {
          await clearCoreStateIfOwned()
        } catch (err) {
          errors.push(err)
        }
        if (errors.length > 0) throw errors[0]
      },
      /**
       * 关机 / 注销：顺序与「必须 await 谁」由 `shell/power.ts` 决定。
       *
       * 与 stopAll 的关键差异：
       * - 只 await 系统代理还原，内核只**请求**终止（`stop()` 的 3 秒宽限期会等，
       *   调用方刻意不 await 它）；
       * - **不删 core-state.json**。stopAll 的注释已经写明顺序的理由：内核在宽限期内
       *   被强杀时，那份记录是下一次启动唯一能识别残留进程的东西。关机时内核很可能
       *   还活着，删了它就再也找不到孤儿进程了；留下记录，下次启动的 cleanStaleCore
       *   会按 ownerPid 判定旧实例已死、再校验完整路径后 taskkill。
       */
      createShutdownActions(): ShutdownActions {
        // in-use：内核与代理都归另一个存活实例，关机时一个都不能动。
        if (ctx.startupStatus === 'in-use') {
          return {
            cancelRestarts() {},
            async restoreProxy() {},
            stopKernel() {}
          }
        }
        return {
          cancelRestarts() {
            // 同步，且必须先于任何 await：关机途中到点的退避定时器会把内核重新拉起。
            cancelRestarts()
            // 置位后，在途重启会在下一个 await 边界放弃（与 stopAll 同一套语义）。
            shuttingDown = true
          },
          async restoreProxy() {
            await controller.disable()
          },
          stopKernel() {
            // 刻意不返回 Promise：调用方不等内核的 SIGTERM 宽限期。
            // stop() 会同步把状态置为 stopped，因此这次退出不会被误判成崩溃。
            void activeSupervisor.stop().catch((err) => {
              console.warn('[aether] 关机时终止内核失败：', describeError(err))
            })
            // 采集器不能留着重连定时器；它们与本进程同生共死，停在这里最省事。
            stopCollectors(ctx)
          }
        }
      }
    }
    // 崩溃处理只改「当前」上下文；之前的上下文（不会出现多个）不在这里引用。
    activeContext = ctx
    if (over.startupStatus !== 'in-use') attachRestart(ctx)
    return ctx
  }

  if (restore === 'in-use') {
    // 另一个实例持有系统代理：不启动内核，更不能清理它仍在使用的状态文件。
    return makeContext({
      profileDir: configDir,
      startupStatus: 'in-use'
    })
  }

  // 首次启动没有 context，上层无法用 stopAll 取消；退出信号只能在这里兜住：
  // 停掉可能已经 spawn 的内核，再把这个上下文交出去（stopAll 会被再次调用也无害）。
  if (opts.signal?.aborted === true) {
    shuttingDown = true
    await activeSupervisor.stop().catch(() => {})
    await clearCoreStateIfOwned().catch(() => {})
    return makeContext({ profileDir: configDir, startupStatus: 'core-error' })
  }

  // 上次运行可能在后台留下了孤儿 mihomo。放在 in-use 与启动前取消检查之后：
  // 另一个实例仍在使用那份记录时不能碰，已经在退出的进程也不必再清理。
  try {
    await cleanStaleCore()
  } catch (err) {
    // 探测途中用户退出：与启动前取消同一语义，不再拉起内核。
    // 旧状态文件已由 cleanStaleCore 的 finally 删除。
    if (err instanceof ShutdownAbortError) {
      return makeContext({ profileDir: configDir, startupStatus: 'core-error' })
    }
    // 孤儿清理是尽力而为的兜底：任何意外都不得阻断启动。
    console.warn('[aether] 清理上次遗留内核失败：', describeError(err))
  }

  let result: StartResult
  try {
    result = await startCore()
  } catch (err) {
    // 启动途中被取消：不再建窗口，也不要把「取消」当成启动失败。
    if (err instanceof ShutdownAbortError) {
      return makeContext({ profileDir: configDir, startupStatus: 'core-error' })
    }
    throw err
  }
  if (!result.ok) {
    return makeContext({
      profileDir: result.status === 'no-config' ? null : configDir,
      startupStatus: result.status,
      profile: result.profile
    })
  }

  // 只有用户上次明确打开代理、且没有检测到他人改动时才接管系统代理。
  // `conflict` 表示系统代理已被其它程序改写，不能覆盖。
  let proxyEnabled = false
  let proxyError: string | undefined
  if (settings.proxyEnabled && restore !== 'conflict') {
    try {
      await controller.enable(result.prepared.proxyServer)
    } catch (err) {
      proxyError = describeError(err)
    }
    try {
      // 上报实际状态，而不是「我们尝试过开代理」。
      proxyEnabled = (await pp.getSystemProxy()).enabled === true
    } catch (err) {
      proxyEnabled = false
      proxyError ??= describeError(err)
    }
  }

  return makeContext({
    profileDir: configDir,
    startupStatus: 'ready',
    mode: result.prepared.mode,
    proxyEnabled,
    ...(proxyError === undefined ? {} : { proxyError }),
    proxyServer: result.prepared.proxyServer,
    link: result.prepared.link,
    coreInfo: result.info,
    stats,
    connections,
    logs,
    profile: result.prepared.profile
  })
}
