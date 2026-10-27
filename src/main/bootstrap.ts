import path from 'node:path'
import { readFile } from 'node:fs/promises'
import YAML from 'yaml'
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
import { FakePlatformProxy } from './proxy/fake'
import type { PlatformProxy } from './proxy/platform'
import { readSettings, writeSettings } from './settings'
import { CoreLink } from './core/link'
import { TrafficCollector, type StatsConnect, type TrafficSnapshot } from './stats'
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
}

export type AppStatus = 'no-config' | 'ready' | 'config-error' | 'core-error' | 'in-use'
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
  /** 配置摘要（供状态页显示节点/策略组数量）；无配置时为 null。 */
  profile: { nodeCount: number; groupCount: number } | null
  /**
   * 停内核 → 重新读取 upstream.yaml、重新合并/校验 runtime.yaml → 启动 → 重写 core-state.json。
   * 必须重新生成配置：导入新配置后仅重启进程会用旧的 runtime.yaml，导入等于没生效。
   * 失败时上下文被置为对应的错误状态，并抛出可读错误。
   */
  restartCore(): Promise<CoreInfo>
  /** 内核重启成功后重写 core-state.json 等外部状态。 */
  onCoreRestarted(info: CoreInfo): Promise<void>
  stopAll(): Promise<void>
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
   * 内核在运行中被意外终止（崩溃、被外部杀掉）。只做「停止说谎」：
   * 转 core-error、清空内核视图、停采集器、还原系统代理。
   * 自动重启（1/2/4s 退避）留给下一个计划，这里不实现。
   * 主动 stop() 不会走到这里：CoreSupervisor 先把状态置为 stopped。
   */
  const handleCoreExit = (supervisor: CoreSupervisor): void => {
    // 退出清理已经开始，或事件来自已被替换的旧实例：忽略。
    if (shuttingDown || activeSupervisor !== supervisor) return
    const ctx = activeContext
    if (ctx === null) return
    ctx.startupStatus = 'core-error'
    ctx.coreInfo = null
    ctx.link = null
    ctx.proxyServer = null
    try {
      ctx.stats?.stop()
    } catch {
      // stop 不抛错；这里只防御性地不让崩溃处理再失败一次。
    }
    ctx.stats = null
    ctx.supervisor = supervisor
    void (async () => {
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
      const merged = mergeConfig(upstream, {}, ep)
      const missing = missingReferences(merged)
      if (missing.length > 0) {
        console.warn(`[aether] 配置引用缺失：${missing.join(', ')}`)
        return { ok: false, status: 'config-error', profile }
      }
      await writeRuntime(configDir, merged)
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
          mode: normalizeMode(merged.mode),
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
      return { ok: true, prepared, info }
    } catch (err) {
      console.warn('[aether] 内核启动失败：', describeError(err))
      await prepared.supervisor.stop().catch(() => {})
      await clearCoreState(coreStateFile).catch(() => {})
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
    profile?: Prepared['profile']
  }

  /**
   * 给非 in-use 上下文装上重启能力：导入配置后状态页要用它把新配置真正加载进内核。
   * 重启会重新读 upstream.yaml、重新合并并校验 runtime.yaml，而不是拿旧文件重启进程。
   */
  const attachRestart = (ctx: AppContext): void => {
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

    const restart = async (): Promise<CoreInfo> => {
      // 退出清理已开始时直接放弃：调用方（IPC）会把异常映射成 {ok:false}。
      assertNotShuttingDown()
      // 停内核期间系统代理仍指向 mixed-port，整机会短暂断网。先还原系统代理，
      // 成功启动后再按用户此前的意愿重新接管；失败则保持关闭。
      const wantProxy = ctx.proxyEnabled
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
      if (!restarted.ok) {
        const message =
          restarted.status === 'no-config'
            ? '还没有配置，无法启动内核'
            : restarted.status === 'config-error'
              ? '配置有误，无法启动内核'
              : '内核启动失败'
        ctx.startupStatus = restarted.status
        ctx.profileDir = restarted.status === 'no-config' ? null : configDir
        ctx.profile = restarted.profile
        ctx.coreInfo = null
        ctx.link = null
        ctx.proxyServer = null
        // 内核没起来就没有可采集的流量：停掉并对上层暴露 null。实例本身保留，
        // 下次重启成功后 ensureStats 会复用它（连同已有缓冲）。
        ctx.stats?.stop()
        ctx.stats = null
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
        // 又会把系统代理指向一个起不来的内核。
        if (wantProxy) {
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
      await ctx.onCoreRestarted(info)

      // 重启后内核按 runtime.yaml 的模式启动；把本会话里用户选过的模式补回去。
      if (ctx.mode !== prepared.mode) await prepared.link.setMode(ctx.mode)

      // mixed-port 在会话内不变，但代理所有权需要指向新内核；同时复核系统真实状态。
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
      return info
    }

    /**
     * 把在途重启登记下来。stopAll 先置退出标志、再 await 这些 promise：
     * 重启会在下一个 await 边界看到标志并放弃，绝不会在清理完成后继续 spawn。
     */
    ctx.restartCore = (): Promise<CoreInfo> => {
      const running = restart()
      const tracked = running.finally(() => {
        inFlightRestarts.delete(tracked)
      })
      inFlightRestarts.add(tracked)
      return tracked
    }
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
      profile: over.profile ?? null,
      restartCore: async () => {
        throw new Error('内核未运行，无法重启')
      },
      onCoreRestarted: async () => {},
      // 退出清理只有一份实现，且读取活跃字段：no-config 下导入配置并重启后，
      // 这里必须停住那个刚起来的 supervisor，而不是启动时的 idle 替身。
      stopAll: async () => {
        // in-use：内核与状态文件属于另一个存活实例，退出时一个都不能动。
        if (ctx.startupStatus === 'in-use') return
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
        try {
          ctx.stats?.stop()
        } catch {
          // stop 不抛错；这里只防御性地不把清理失败算进致命错误。
        }
        try {
          await clearCoreState(coreStateFile)
        } catch (err) {
          errors.push(err)
        }
        if (errors.length > 0) throw errors[0]
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
    await clearCoreState(coreStateFile).catch(() => {})
    return makeContext({ profileDir: configDir, startupStatus: 'core-error' })
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
    profile: result.prepared.profile
  })
}
