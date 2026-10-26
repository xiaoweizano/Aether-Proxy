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

  // 用户期望的代理开关独立于所有权快照：proxy-state.json 正常退出时会被删除，
  // 不能用来回答「上次代理是否开着」。
  const settings = await readSettings(settingsFile)

  // 先还原上次异常退出留下的系统代理，再读配置。这样 in-use 时不会
  // 改动另一个存活实例正在使用的 profile 文件，也不会启动第二个内核。
  const restore = await ownership.restoreOnStartupIfStale()

  // stopAll / restartCore 必须作用于当前这一个 supervisor；重启会换新的实例。
  let activeSupervisor = idleSupervisor(binary, configDir, opts)

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
    let upstreamText: string | null = null
    try {
      upstreamText = await readFile(path.join(configDir, 'upstream.yaml'), 'utf8')
    } catch {
      upstreamText = null
    }
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
    const configPath = path.join(configDir, 'runtime.yaml')
    const supervisor = new CoreSupervisor({
      binary,
      homeDir: configDir,
      configPath,
      controllerPort: ep.controllerPort,
      secret: ep.secret,
      spawn: opts.spawnFn,
      fetchFn: opts.fetchFn
    })
    activeSupervisor = supervisor

    try {
      await ensureGeodata(configDir, geodataDir)
      const merged = mergeConfig(upstream, {}, ep)
      const missing = missingReferences(merged)
      if (missing.length > 0) {
        console.warn(`[aether] 配置引用缺失：${missing.join(', ')}`)
        return { ok: false, status: 'config-error', profile }
      }
      await writeRuntime(configDir, merged)
      const validate = opts.validateFn ?? validateConfig
      const validated = await validate(binary, configDir, configPath)
      if (!validated.ok) {
        console.warn('[aether] 内核配置校验失败，已跳过启动')
        return { ok: false, status: 'config-error', profile }
      }
      return {
        ok: true,
        prepared: {
          supervisor,
          link: await ensureLink(),
          proxyServer: `127.0.0.1:${ep.mixedPort}`,
          controllerPort: ep.controllerPort,
          secret: ep.secret,
          mode: normalizeMode(merged.mode),
          profile
        }
      }
    } catch (err) {
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
    try {
      const info = await prepared.supervisor.start()
      await writeCoreState(coreStateFile, {
        pid: info.pid,
        port: prepared.controllerPort,
        secret: prepared.secret
      })
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

    ctx.restartCore = async (): Promise<CoreInfo> => {
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
        try {
          ctx.proxyEnabled = (await pp.getSystemProxy()).enabled === true
        } catch (err) {
          ctx.proxyEnabled = false
          ctx.proxyError ??= describeError(err)
        }
      }

      await activeSupervisor.stop()
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
        try {
          await clearCoreState(coreStateFile)
        } catch (err) {
          errors.push(err)
        }
        if (errors.length > 0) throw errors[0]
      }
    }
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

  const result = await startCore()
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
    profile: result.prepared.profile
  })
}
