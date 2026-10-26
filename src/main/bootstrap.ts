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
import { readSettings } from './settings'
import type { Mode } from '../shared/types'

export interface BootstrapOptions {
  userDataDir: string
  isPackaged: boolean
  resourcesPath: string
  repoRoot: string
  spawnFn?: typeof import('node:child_process').spawn
  fetchFn?: typeof fetch
  /** 测试注入；缺省时 Windows 用 loadWindowsProxy()。 */
  platformProxy?: PlatformProxy
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

function stopAllOf(
  controller: SystemProxyController,
  supervisor: CoreSupervisor,
  coreStateFile: string
): () => Promise<void> {
  return async () => {
    const errors: unknown[] = []
    try {
      await controller.disable()
    } catch (err) {
      errors.push(err)
    }
    try {
      await clearCoreState(coreStateFile)
    } catch (err) {
      errors.push(err)
    }
    try {
      await supervisor.stop()
    } catch (err) {
      errors.push(err)
    }
    if (errors.length > 0) throw errors[0]
  }
}

export async function bootstrap(opts: BootstrapOptions): Promise<AppContext> {
  const profileDir = path.join(opts.userDataDir, 'profiles', 'default')
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

  // 用户期望的代理开关独立于所有权快照：proxy-state.json 正常退出时会被删除，
  // 不能用来回答「上次代理是否开着」。
  const settings = await readSettings(settingsFile)

  // 先还原上次异常退出留下的系统代理，再读配置。这样 in-use 时不会
  // 改动另一个存活实例正在使用的 profile 文件，也不会启动第二个内核。
  const restore = await ownership.restoreOnStartupIfStale()
  if (restore === 'in-use') {
    return {
      profileDir,
      supervisor: idleSupervisor(binary, profileDir, opts),
      controller,
      ownership,
      mode: 'rule',
      startupStatus: 'in-use',
      restore,
      stopAll: async () => {}
    }
  }

  let upstreamText: string | null = null
  try {
    upstreamText = await readFile(path.join(profileDir, 'upstream.yaml'), 'utf8')
  } catch {
    upstreamText = null
  }

  if (upstreamText === null) {
    return {
      profileDir: null,
      supervisor: idleSupervisor(binary, profileDir, opts),
      controller,
      ownership,
      mode: 'rule',
      startupStatus: 'no-config',
      restore,
      stopAll: async () => {}
    }
  }

  let upstream: unknown
  try {
    upstream = YAML.parse(upstreamText)
  } catch {
    // 解析错误信息会带出配置片段，可能含订阅凭据，不写入日志。
    console.warn('[aether] upstream.yaml 解析失败，跳过内核启动')
    return {
      profileDir,
      supervisor: idleSupervisor(binary, profileDir, opts),
      controller,
      ownership,
      mode: 'rule',
      startupStatus: 'config-error',
      restore,
      stopAll: async () => {}
    }
  }

  const mixedPort = await allocatePort()
  const controllerPort = await allocatePort()
  const secret = newSecret()
  const configPath = path.join(profileDir, 'runtime.yaml')
  const supervisor = new CoreSupervisor({
    binary,
    homeDir: profileDir,
    configPath,
    controllerPort,
    secret,
    spawn: opts.spawnFn,
    fetchFn: opts.fetchFn
  })

  let merged: Record<string, unknown>
  try {
    await ensureGeodata(profileDir, geodataDir)
    merged = mergeConfig(upstream, {}, { mixedPort, controllerPort, secret })
    const missing = missingReferences(merged)
    if (missing.length > 0) {
      console.warn(`[aether] 配置引用缺失：${missing.join(', ')}`)
      return {
        profileDir,
        supervisor,
        controller,
        ownership,
        mode: 'rule',
        startupStatus: 'config-error',
        restore,
        stopAll: async () => {}
      }
    }
    await writeRuntime(profileDir, merged)
    const validated = await validateConfig(binary, profileDir, configPath)
    if (!validated.ok) {
      console.warn('[aether] 内核配置校验失败，已跳过启动')
      return {
        profileDir,
        supervisor,
        controller,
        ownership,
        mode: 'rule',
        startupStatus: 'config-error',
        restore,
        stopAll: async () => {}
      }
    }
  } catch (err) {
    console.warn('[aether] 配置准备失败：', err instanceof Error ? err.message : String(err))
    return {
      profileDir,
      supervisor,
      controller,
      ownership,
      mode: 'rule',
      startupStatus: 'config-error',
      restore,
      stopAll: async () => {}
    }
  }

  try {
    const info = await supervisor.start()
    await writeCoreState(coreStateFile, { pid: info.pid, port: controllerPort, secret })
  } catch (err) {
    console.warn('[aether] 内核启动失败：', err instanceof Error ? err.message : String(err))
    await supervisor.stop().catch(() => {})
    await clearCoreState(coreStateFile).catch(() => {})
    return {
      profileDir,
      supervisor,
      controller,
      ownership,
      mode: 'rule',
      startupStatus: 'core-error',
      restore,
      stopAll: async () => {
        await clearCoreState(coreStateFile)
      }
    }
  }

  // 只有用户上次明确打开代理、且没有检测到他人改动时才接管系统代理。
  // `conflict` 表示系统代理已被其它程序改写，不能覆盖；`in-use` 已在上面提前返回。
  if (settings.proxyEnabled && restore !== 'conflict') {
    try {
      await controller.enable(`127.0.0.1:${mixedPort}`)
    } catch (err) {
      console.warn('[aether] 应用系统代理失败：', err instanceof Error ? err.message : String(err))
    }
  }

  const rawMode = merged.mode
  const mode: Mode = rawMode === 'global' || rawMode === 'direct' ? rawMode : 'rule'

  return {
    profileDir,
    supervisor,
    controller,
    ownership,
    mode,
    startupStatus: 'ready',
    restore,
    stopAll: stopAllOf(controller, supervisor, coreStateFile)
  }
}
