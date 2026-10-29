import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import {
  bootstrap,
  isProcessAliveWith,
  parseTasklistCsvImage,
  processPathWith,
  queryFullPath,
  queryImageName,
  sameExecutable,
  taskkillArgs,
  terminateProcessWith
} from './bootstrap'
import type { BootstrapOptions, ExecFileFn } from './bootstrap'
import { FakePlatformProxy } from './proxy/fake'
import { ProxyOwnership } from './proxy/ownership'
import { createShutdownHandler } from './shell/power'
import type { WebSocketLike } from './stats'

const VALID_CONFIG = `proxies: []
proxy-groups:
  - { name: Proxy, type: select, proxies: [DIRECT] }
rules:
  - MATCH,DIRECT
`

const CORE_PID = 424242

/** harness 的 repoRoot 是 process.cwd()，isPackaged=false：内核二进制固定在 vendor/。 */
const MIHOMO_PATH = path.join(process.cwd(), 'vendor', 'mihomo.exe')
/** 同名但不是我们的二进制：完整路径不同，必须拒绝终止。 */
const FOREIGN_MIHOMO_PATH = path.join(process.cwd(), 'Clash Party', 'resources', 'sidecar', 'mihomo.exe')

/** 轮询等待异步状态收敛；超时直接失败，避免测试挂死。 */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('等待条件超时')
}

async function makeUserDir(withConfig: boolean, configText = VALID_CONFIG): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'aether-boot-'))
  if (withConfig) {
    const p = path.join(dir, 'profiles', 'default')
    await mkdir(p, { recursive: true })
    await writeFile(path.join(p, 'upstream.yaml'), configText)
  }
  return dir
}

/** 让 CoreSupervisor 的握手走到 running，而不用真的 spawn mihomo。 */
interface CrashableChild extends ChildProcess {
  /**
   * 绕过 `once` 的自动摘除，再投递一次 exit 事件。
   * 模拟 Node 在生产里把退出事件延迟送达：此时 activeSupervisor 可能已被替换。
   */
  lateExit(code?: number | null): void
}

function fakeChild(onKill?: () => void): CrashableChild {
  const child = new EventEmitter() as unknown as CrashableChild
  const exitHandlers: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = []
  const originalOnce = child.once.bind(child)
  ;(child as unknown as { once: typeof child.once }).once = ((
    event: string,
    listener: (...args: any[]) => void
  ) => {
    if (event === 'exit') {
      exitHandlers.push(listener as (code: number | null, signal: NodeJS.Signals | null) => void)
    }
    return originalOnce(event, listener)
  }) as typeof child.once
  Object.assign(child, {
    pid: CORE_PID,
    exitCode: null,
    kill: vi.fn(() => {
      onKill?.()
      ;(child as unknown as { exitCode: number | null }).exitCode = 0
      child.emit('exit', 0, null)
      return true
    }),
    lateExit: (code: number | null = 1): void => {
      for (const handler of exitHandlers) handler(code, null)
    }
  })
  return child
}

/** 模拟内核自己退出（崩溃 / 被外部杀掉）：先把 exitCode 落成非零，再投递事件。 */
function crash(child: CrashableChild, code = 1): void {
  ;(child as unknown as { exitCode: number | null }).exitCode = code
  child.emit('exit', code, null)
}

function okFetch(): typeof fetch {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ version: 'test' })
  })) as unknown as typeof fetch
}

interface StoredCoreState {
  pid: number
  port: number
  secret: string
  ownerPid?: number
}

async function readStoredCoreState(dir: string): Promise<StoredCoreState> {
  return JSON.parse(await readFile(path.join(dir, 'core-state.json'), 'utf8')) as StoredCoreState
}

async function seedStaleCore(dir: string, state: StoredCoreState): Promise<void> {
  await writeFile(path.join(dir, 'core-state.json'), JSON.stringify(state))
}

/** 旧端口按指定状态码应答；其余端口（新内核的握手）正常 200。 */
function fetchForPort(stalePort: number, status: number): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    if (String(input).includes(`:${stalePort}/`)) {
      return { ok: status >= 200 && status < 300, status, json: async () => ({}) } as Response
    }
    return { ok: true, status: 200, json: async () => ({ version: 'test' }) } as Response
  }) as unknown as typeof fetch
}

/** 旧端口连接被拒（none）；其余端口正常，供新内核握手。 */
function refusedFetch(stalePort: number): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    if (String(input).includes(`:${stalePort}/`)) throw new Error('ECONNREFUSED')
    return { ok: true, status: 200, json: async () => ({ version: 'test' }) } as Response
  }) as unknown as typeof fetch
}

/** 真的占住一个端口，让 allocatePort 不可能再选中它。 */
function listenOn(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

/** 记录 connect 调用并允许手动推进消息的最小 WS 替身。 */
class FakeStatsSocket implements WebSocketLike {
  readonly messages: ((data: unknown) => void)[] = []
  readonly closes: (() => void)[] = []
  readonly errors: ((err: unknown) => void)[] = []
  closed = false

  on(event: 'message', cb: (data: unknown) => void): void
  on(event: 'close', cb: () => void): void
  on(event: 'error', cb: (err: unknown) => void): void
  on(
    event: 'message' | 'close' | 'error',
    cb: ((data: unknown) => void) | (() => void) | ((err: unknown) => void)
  ): void {
    if (event === 'message') this.messages.push(cb as (data: unknown) => void)
    else if (event === 'close') this.closes.push(cb as () => void)
    else this.errors.push(cb as (err: unknown) => void)
  }

  close(): void {
    this.closed = true
  }

  push(up: number, down: number): void {
    this.pushRaw(JSON.stringify({ up, down, upTotal: up * 10, downTotal: down * 10 }))
  }

  /** 连接 / 日志采集器的帧形状与流量不同，直接推原始文本。 */
  pushRaw(data: unknown): void {
    for (const cb of this.messages) cb(data)
  }
}

interface Harness {
  dir: string
  pp: FakePlatformProxy
  spawnFn: ReturnType<typeof vi.fn>
  opts: BootstrapOptions
}

async function harness(options: {
  config?: string | null
  proxyEnabled?: boolean
  pp?: FakePlatformProxy
  spawn?: () => ChildProcess
  validateFn?: NonNullable<BootstrapOptions['validateFn']>
  statsConnect?: NonNullable<BootstrapOptions['statsConnect']>
  connectionsConnect?: NonNullable<BootstrapOptions['connectionsConnect']>
  logsConnect?: NonNullable<BootstrapOptions['logsConnect']>
  onStatsSample?: NonNullable<BootstrapOptions['onStatsSample']>
  onConnectionsSnapshot?: NonNullable<BootstrapOptions['onConnectionsSnapshot']>
  onLogCounts?: NonNullable<BootstrapOptions['onLogCounts']>
  isProcessAliveFn?: NonNullable<BootstrapOptions['isProcessAliveFn']>
  processPathFn?: NonNullable<BootstrapOptions['processPathFn']>
  killFn?: NonNullable<BootstrapOptions['killFn']>
  restarter?: NonNullable<BootstrapOptions['restarter']>
  fetchFn?: NonNullable<BootstrapOptions['fetchFn']>
} = {}): Promise<Harness> {
  const config = options.config === undefined ? VALID_CONFIG : options.config
  const dir = await makeUserDir(config !== null, config ?? VALID_CONFIG)
  if (options.proxyEnabled !== undefined) {
    await writeFile(
      path.join(dir, 'settings.json'),
      JSON.stringify({ proxyEnabled: options.proxyEnabled })
    )
  }
  const pp = options.pp ?? new FakePlatformProxy({ enabled: false })
  const spawnFn = vi.fn(options.spawn ?? (() => fakeChild()))
  return {
    dir,
    pp,
    spawnFn,
    opts: {
      userDataDir: dir,
      isPackaged: false,
      resourcesPath: dir,
      repoRoot: process.cwd(),
      spawnFn: spawnFn as unknown as BootstrapOptions['spawnFn'],
      fetchFn: options.fetchFn ?? okFetch(),
      platformProxy: pp,
      validateFn: options.validateFn ?? (async () => ({ ok: true, output: 'ok' })),
      // 默认不碰真实网络：单元测试里的内核端口并不存在，交给真实 ws 会反复重连。
      statsConnect:
        options.statsConnect ??
        (() => new FakeStatsSocket()),
      // 连接 / 日志采集器与流量采集器分开注入，既有测试里按 stats 收线的
      // sockets 数组不会被这两条 WS 污染。
      connectionsConnect: options.connectionsConnect ?? (() => new FakeStatsSocket()),
      logsConnect: options.logsConnect ?? (() => new FakeStatsSocket()),
      // 测试绝不探测或终止真实进程：孤儿清理的三个系统调用全部注入。
      isProcessAliveFn: options.isProcessAliveFn ?? (() => false),
      processPathFn: options.processPathFn ?? (async () => null),
      killFn: options.killFn ?? (async () => {}),
      ...(options.onStatsSample === undefined ? {} : { onStatsSample: options.onStatsSample }),
      ...(options.onConnectionsSnapshot === undefined
        ? {}
        : { onConnectionsSnapshot: options.onConnectionsSnapshot }),
      ...(options.onLogCounts === undefined ? {} : { onLogCounts: options.onLogCounts }),
      ...(options.restarter === undefined ? {} : { restarter: options.restarter })
    }
  }
}

describe('bootstrap', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('无配置时返回 no-config 且不启动内核', async () => {
    const h = await harness({ config: null })
    const ctx = await bootstrap(h.opts)
    expect(ctx.startupStatus).toBe('no-config')
    expect(ctx.profileDir).toBeNull()
    expect(ctx.restore).toBe('none')
    expect(ctx.proxyEnabled).toBe(false)
    expect(ctx.supervisor.status).toBe('stopped')
    expect(h.spawnFn).not.toHaveBeenCalled()
    await ctx.stopAll()
  })

  it('另一个存活实例持有代理时返回 in-use，不启动内核也不碰代理', async () => {
    const h = await harness({ proxyEnabled: true })
    await writeFile(
      path.join(h.dir, 'proxy-state.json'),
      JSON.stringify({
        enabled: true,
        server: 'corp:8080',
        bypass: ['*.corp.local'],
        owner: 'aether',
        pid: process.ppid,
        at: Date.now(),
        applied: { server: '127.0.0.1:7890', bypass: ['localhost'] },
        appliedAt: Date.now()
      })
    )
    const ctx = await bootstrap(h.opts)
    expect(ctx.startupStatus).toBe('in-use')
    expect(ctx.restore).toBe('in-use')
    expect(ctx.proxyEnabled).toBe(false)
    expect(ctx.supervisor.status).toBe('stopped')
    expect(h.spawnFn).not.toHaveBeenCalled()
    expect((await h.pp.getSystemProxy()).enabled).toBe(false)
    await ctx.stopAll()
  })

  it('配置引用缺失时返回 config-error 且不启动内核', async () => {
    const h = await harness({
      config: `proxies: []
proxy-groups:
  - { name: Proxy, type: select, proxies: [Missing] }
rules:
  - MATCH,DIRECT
`
    })
    const ctx = await bootstrap(h.opts)
    expect(ctx.startupStatus).toBe('config-error')
    expect(ctx.proxyEnabled).toBe(false)
    expect(ctx.supervisor.status).toBe('stopped')
    expect(h.spawnFn).not.toHaveBeenCalled()
    await ctx.stopAll()
  })

  it('YAML 无法解析时返回 config-error 且不启动内核', async () => {
    const h = await harness({ config: 'proxies: [\n  - { name: ' })
    const ctx = await bootstrap(h.opts)
    expect(ctx.startupStatus).toBe('config-error')
    expect(ctx.supervisor.status).toBe('stopped')
    expect(ctx.proxyEnabled).toBe(false)
    expect(h.spawnFn).not.toHaveBeenCalled()
    await ctx.stopAll()
  })

  it('内核配置校验失败时返回 config-error，不启动内核也不碰代理', async () => {
    const h = await harness({
      proxyEnabled: true,
      validateFn: async () => ({ ok: false, output: 'parse error' })
    })
    const ctx = await bootstrap(h.opts)
    expect(ctx.startupStatus).toBe('config-error')
    expect(ctx.proxyEnabled).toBe(false)
    expect(ctx.supervisor.status).toBe('stopped')
    expect(h.spawnFn).not.toHaveBeenCalled()
    expect((await h.pp.getSystemProxy()).enabled).toBe(false)
    await ctx.stopAll()
  })

  it('内核启动失败时返回 core-error，stopAll 清理状态且不留下内核', async () => {
    const h = await harness({
      proxyEnabled: true,
      spawn: () => {
        throw new Error('spawn failed')
      }
    })
    await writeFile(
      path.join(h.dir, 'core-state.json'),
      JSON.stringify({ pid: 1, port: 2, secret: 'stale' })
    )

    const ctx = await bootstrap(h.opts)
    expect(ctx.startupStatus).toBe('core-error')
    expect(ctx.proxyEnabled).toBe(false)
    expect(ctx.supervisor.status).toBe('stopped')
    expect(h.spawnFn).toHaveBeenCalledTimes(1)
    expect(existsSync(path.join(h.dir, 'core-state.json'))).toBe(false)

    await ctx.stopAll()
    expect(ctx.supervisor.status).toBe('stopped')
    expect(existsSync(path.join(h.dir, 'core-state.json'))).toBe(false)
  })

  it('上次代理为开时启动内核后接管系统代理', async () => {
    const h = await harness({ proxyEnabled: true })
    const ctx = await bootstrap(h.opts)
    expect(ctx.startupStatus).toBe('ready')
    expect(ctx.restore).toBe('none')
    expect(ctx.proxyEnabled).toBe(true)
    expect(h.spawnFn).toHaveBeenCalledTimes(1)
    const proxy = await h.pp.getSystemProxy()
    expect(proxy.enabled).toBe(true)
    expect(proxy.server).toMatch(/^127\.0\.0\.1:\d+$/)

    const coreState = JSON.parse(await readFile(path.join(h.dir, 'core-state.json'), 'utf8'))
    expect(coreState.pid).toBe(CORE_PID)

    await ctx.stopAll()
    expect((await h.pp.getSystemProxy()).enabled).toBe(false)
    await expect(readFile(path.join(h.dir, 'core-state.json'), 'utf8')).rejects.toThrow()
  })

  it('就绪时暴露 link 与 mixed-port，proxyServer 与系统代理一致', async () => {
    const h = await harness({ proxyEnabled: true })
    const ctx = await bootstrap(h.opts)
    expect(ctx.link).not.toBeNull()
    expect(ctx.coreInfo?.pid).toBe(CORE_PID)
    expect(ctx.coreInfo?.controllerPort).toBeGreaterThan(0)
    expect(ctx.profile).toEqual({ nodeCount: 0, groupCount: 1 })
    const proxy = await h.pp.getSystemProxy()
    expect(ctx.proxyServer).toBe(proxy.server)

    // setMode 只改内存中的模式，供 status 视图读取。
    ctx.setMode('direct')
    expect(ctx.mode).toBe('direct')

    await ctx.stopAll()
  })

  it('内核未启动的分支没有 link 与 proxyServer', async () => {
    const h = await harness({ config: null })
    const ctx = await bootstrap(h.opts)
    expect(ctx.link).toBeNull()
    expect(ctx.proxyServer).toBeNull()
    expect(ctx.coreInfo).toBeNull()
    expect(ctx.profile).toBeNull()
    expect(ctx.configDir).toBe(path.join(h.dir, 'profiles', 'default'))
    await ctx.stopAll()
  })

  it('onCoreRestarted 重写 core-state.json', async () => {
    const h = await harness()
    const ctx = await bootstrap(h.opts)
    const stateFile = path.join(h.dir, 'core-state.json')
    const before = JSON.parse(await readFile(stateFile, 'utf8'))

    const restarted = { ...before, pid: 999999, version: 'v1.19.32', controllerPort: 1, startedAt: 1 }
    await ctx.onCoreRestarted({ ...ctx.coreInfo!, pid: restarted.pid })
    const after = JSON.parse(await readFile(stateFile, 'utf8'))
    expect(after.pid).toBe(restarted.pid)
    // secret 必须继续只存在于主进程侧的状态文件中，且重启不改变它。
    expect(after.secret).toBe(before.secret)

    await ctx.stopAll()
  })

  it('重启内核会重新生成配置并按新配置启动', async () => {
    const h = await harness()
    const ctx = await bootstrap(h.opts)
    const firstPid = ctx.coreInfo?.pid
    const firstLink = ctx.link
    const runtimeBefore = await readFile(path.join(ctx.configDir, 'runtime.yaml'), 'utf8')

    // 用户在状态页导入新配置后点「重启内核」。
    await writeFile(
      path.join(ctx.configDir, 'upstream.yaml'),
      `proxies: [{ name: N1, type: ss, server: 1.2.3.4, port: 1, cipher: aes-128-gcm, password: x }]
proxy-groups:
  - { name: P, type: select, proxies: [N1, DIRECT] }
rules:
  - MATCH,P
`
    )
    const info = await ctx.restartCore()

    expect(info.pid).toBe(CORE_PID)
    expect(ctx.startupStatus).toBe('ready')
    expect(ctx.coreInfo?.pid).toBe(firstPid)
    expect(ctx.profile).toEqual({ nodeCount: 1, groupCount: 1 })
    // controller 客户端在会话内保持同一地址与 secret。
    expect(ctx.link).toBe(firstLink)
    const runtimeAfter = await readFile(path.join(ctx.configDir, 'runtime.yaml'), 'utf8')
    expect(runtimeAfter).not.toBe(runtimeBefore)
    expect(runtimeAfter).toContain('N1')
    // 内核状态文件跟着新的启动重写。
    const state = JSON.parse(await readFile(path.join(h.dir, 'core-state.json'), 'utf8'))
    expect(state.pid).toBe(CORE_PID)

    await ctx.stopAll()
  })

  it('无配置时导入配置后重启即可进入 ready', async () => {
    const h = await harness({ config: null })
    const ctx = await bootstrap(h.opts)
    expect(ctx.startupStatus).toBe('no-config')
    expect(ctx.restartCore).toBeTypeOf('function')

    await mkdir(path.join(ctx.configDir), { recursive: true })
    await writeFile(path.join(ctx.configDir, 'upstream.yaml'), VALID_CONFIG)
    const info = await ctx.restartCore()

    expect(info.pid).toBe(CORE_PID)
    expect(ctx.startupStatus).toBe('ready')
    expect(ctx.link).not.toBeNull()
    expect(ctx.proxyServer).toMatch(/^127\.0\.0\.1:\d+$/)

    await ctx.stopAll()
  })

  it('无配置 → 导入 → 重启 → quit：stopAll 仍停住新内核并清理状态', async () => {
    const h = await harness({ config: null, proxyEnabled: true })
    const ctx = await bootstrap(h.opts)
    expect(ctx.startupStatus).toBe('no-config')
    // no-config 下 bootstrap 不碰系统代理。
    expect((await h.pp.getSystemProxy()).enabled).toBe(false)

    await mkdir(path.join(ctx.configDir), { recursive: true })
    await writeFile(path.join(ctx.configDir, 'upstream.yaml'), VALID_CONFIG)

    // 从第一次重启开始记录「停内核时状态文件是否还在」。
    let stateAtStop = true
    const spawnFn = vi.fn(() =>
      fakeChild(() => {
        stateAtStop = existsSync(path.join(h.dir, 'core-state.json'))
      })
    )
    h.opts.spawnFn = spawnFn as unknown as BootstrapOptions['spawnFn']

    await ctx.restartCore()
    await ctx.restartCore()
    expect(ctx.startupStatus).toBe('ready')

    // 用户手动开代理，然后退出。
    await ctx.controller.enable(ctx.proxyServer!)
    ctx.proxyEnabled = true

    await ctx.stopAll()

    // 停住的是重启后那个 supervisor（两次重启各 spawn 一次），不是启动时的 idle 替身。
    expect(spawnFn).toHaveBeenCalledTimes(2)
    expect(stateAtStop).toBe(true)
    expect((await h.pp.getSystemProxy()).enabled).toBe(false)
    expect(existsSync(path.join(h.dir, 'core-state.json'))).toBe(false)
  })

  it('重启后配置校验失败时进入 config-error 并抛出', async () => {
    const h = await harness()
    let allow = true
    h.opts.validateFn = async () => (allow ? { ok: true, output: 'ok' } : { ok: false, output: 'bad' })
    const ctx = await bootstrap(h.opts)
    allow = false

    await expect(ctx.restartCore()).rejects.toThrow(/配置/)
    expect(ctx.startupStatus).toBe('config-error')
    expect(ctx.coreInfo).toBeNull()
    expect(ctx.link).toBeNull()

    await ctx.stopAll()
  })

  it('重启失败且代理开着时还原系统代理并落盘关闭', async () => {
    const h = await harness({ proxyEnabled: true })
    const ctx = await bootstrap(h.opts)
    expect(ctx.proxyEnabled).toBe(true)

    h.opts.validateFn = async () => ({ ok: false, output: 'bad' })
    await expect(ctx.restartCore()).rejects.toThrow()
    expect(ctx.proxyEnabled).toBe(false)
    expect((await h.pp.getSystemProxy()).enabled).toBe(false)
    // 下次启动不能照着旧设置把代理指向一个起不来的内核。
    expect(JSON.parse(await readFile(path.join(h.dir, 'settings.json'), 'utf8'))).toEqual({
      proxyEnabled: false
    })

    await ctx.stopAll()
  })

  it('重启期间先关代理、成功后自动恢复', async () => {
    const order: string[] = []
    const h = await harness({
      proxyEnabled: true,
      spawn: () =>
        fakeChild(() => {
          order.push('core-stop')
        })
    })
    const ctx = await bootstrap(h.opts)

    const originalRestore = h.pp.restore.bind(h.pp)
    h.pp.restore = async (state) => {
      order.push('proxy-off')
      await originalRestore(state)
    }

    await ctx.restartCore()

    expect(order.indexOf('proxy-off')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('proxy-off')).toBeLessThan(order.indexOf('core-stop'))
    expect(ctx.proxyEnabled).toBe(true)
    expect((await h.pp.getSystemProxy()).enabled).toBe(true)
    expect((await h.pp.getSystemProxy()).server).toBe(ctx.proxyServer)

    await ctx.stopAll()
  })

  it('重启后把本会话选过的模式写回新内核', async () => {
    const h = await harness()
    const calls: { url: string; method?: string; body?: string }[] = []
    h.opts.fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method,
        body: typeof init?.body === 'string' ? init.body : undefined
      })
      return { ok: true, status: 200, json: async () => ({}) } as Response
    }) as unknown as typeof fetch

    const ctx = await bootstrap(h.opts)
    ctx.setMode('global')
    calls.length = 0
    await ctx.restartCore()

    const patches = calls.filter((c) => c.method === 'PATCH' && c.url.endsWith('/configs'))
    expect(patches).toHaveLength(1)
    expect(JSON.parse(patches[0]!.body!)).toEqual({ mode: 'global' })
    expect(ctx.mode).toBe('global')

    await ctx.stopAll()
  })

  it('上次代理为关时启动内核但不改系统代理', async () => {
    const h = await harness({ proxyEnabled: false })
    const ctx = await bootstrap(h.opts)
    expect(ctx.startupStatus).toBe('ready')
    expect(ctx.proxyEnabled).toBe(false)
    expect(h.spawnFn).toHaveBeenCalledTimes(1)
    expect((await h.pp.getSystemProxy()).enabled).toBe(false)
    await ctx.stopAll()
  })

  it('恢复上次残留（restored）后按 settings 重新接管代理', async () => {
    const pp = new FakePlatformProxy({ enabled: false })
    const h = await harness({ proxyEnabled: true, pp })
    const stateFile = path.join(h.dir, 'proxy-state.json')

    const first = new ProxyOwnership(pp, stateFile)
    await first.snapshotBeforeApply(await pp.getSystemProxy())
    await pp.setSystemProxy({ server: '127.0.0.1:7890', bypass: [] })
    await first.markApplied('127.0.0.1:7890', [])

    const ctx = await bootstrap(h.opts)
    expect(ctx.restore).toBe('restored')
    expect(ctx.startupStatus).toBe('ready')
    expect(ctx.proxyEnabled).toBe(true)
    const proxy = await pp.getSystemProxy()
    expect(proxy.enabled).toBe(true)
    expect(proxy.server).toMatch(/^127\.0\.0\.1:\d+$/)

    await ctx.stopAll()
    expect((await pp.getSystemProxy()).enabled).toBe(false)
  })

  it('检测到代理被他人改动（conflict）时不接管系统代理', async () => {
    const pp = new FakePlatformProxy({ enabled: true, server: 'corp:8080', bypass: ['*.corp.local'] })
    const h = await harness({ proxyEnabled: true, pp })
    const stateFile = path.join(h.dir, 'proxy-state.json')

    const first = new ProxyOwnership(pp, stateFile)
    await first.snapshotBeforeApply(await pp.getSystemProxy())
    await pp.setSystemProxy({ server: '127.0.0.1:7890', bypass: [] })
    await first.markApplied('127.0.0.1:7890', [])
    await pp.setSystemProxy({ server: 'other:9999', bypass: [] })

    const ctx = await bootstrap(h.opts)
    expect(ctx.restore).toBe('conflict')
    expect(ctx.startupStatus).toBe('ready')
    expect(ctx.proxyEnabled).toBe(false)
    expect(h.spawnFn).toHaveBeenCalledTimes(1)
    expect((await pp.getSystemProxy()).server).toBe('other:9999')

    await ctx.stopAll()
    expect((await pp.getSystemProxy()).server).toBe('other:9999')
  })

  it('stopAll 顺序：还原代理 → 停内核 → 清理内核状态', async () => {
    const order: string[] = []
    let coreStateAtStop = false
    const h = await harness({ proxyEnabled: true })
    h.spawnFn.mockImplementation(() =>
      fakeChild(() => {
        order.push('core-stop')
        coreStateAtStop = existsSync(path.join(h.dir, 'core-state.json'))
      })
    )
    const originalRestore = h.pp.restore.bind(h.pp)
    h.pp.restore = async (state) => {
      order.push('proxy-restore')
      await originalRestore(state)
    }

    const ctx = await bootstrap(h.opts)
    await ctx.stopAll()

    expect(order).toEqual(['proxy-restore', 'core-stop'])
    // 停内核时状态文件必须还在，否则强杀后无法识别残留 mihomo。
    expect(coreStateAtStop).toBe(true)
    expect(existsSync(path.join(h.dir, 'core-state.json'))).toBe(false)
  })

  it('关机路径：先取消自动重启，再还原代理，内核只被请求终止（不等宽限期）', async () => {
    const order: string[] = []
    let child!: CrashableChild
    const h = await harness({
      proxyEnabled: true,
      spawn: () => {
        child = fakeChild()
        return child
      }
    })
    // 定时器只记录不触发：本条用例只关心关机路径取消了调度。
    const schedule = vi.fn()
    h.opts.restarter = { schedule, now: () => 0 }

    const originalRestore = h.pp.restore.bind(h.pp)
    h.pp.restore = async (state) => {
      order.push('proxy-restore')
      await originalRestore(state)
    }

    const ctx = await bootstrap(h.opts)
    // 让内核「正在退出但还没退出」：模拟 SIGTERM 宽限期里的真实状态。
    const kill = vi.fn(() => {
      order.push('core-stop-requested')
      // 刻意不投递 exit：stop() 会一直等到 3 秒超时才返回。
      return true
    })
    ;(child as unknown as { kill: typeof kill }).kill = kill

    const actions = ctx.createShutdownActions()
    const started = Date.now()
    await createShutdownHandler(
      {
        cancelRestarts: () => {
          order.push('cancel-restarts')
          actions.cancelRestarts()
        },
        restoreProxy: actions.restoreProxy,
        stopKernel: actions.stopKernel
      },
      { timeoutMs: 2000 }
    )()

    // 顺序：取消重启 → 还原代理 → 请求停内核。
    expect(order).toEqual(['cancel-restarts', 'proxy-restore', 'core-stop-requested'])
    expect(kill).toHaveBeenCalledWith('SIGTERM')
    // 不等宽限期：内核还没退出，处理器就先回来了。
    expect(child.exitCode).toBeNull()
    expect(Date.now() - started).toBeLessThan(1500)
    // 代理已真正还原。
    expect((await h.pp.getSystemProxy()).enabled).toBe(false)
    // 关机路径刻意保留 core-state.json：内核可能仍在宽限期里活着，
    // 删了记录下次启动就找不到这个孤儿进程了。
    expect(existsSync(path.join(h.dir, 'core-state.json'))).toBe(true)
    await ctx.stopAll()
  })

  it('关机路径取消退避重启：已到点的自动重启不会在关机时把内核拉起来', async () => {
    let child!: CrashableChild
    const spawnFn = vi.fn(() => {
      child = fakeChild()
      return child
    })
    const h = await harness({ spawn: () => spawnFn() })
    // 捕获退避回调但不真的等待：模拟「定时器已到点、回调排在任务队列里」。
    // 用对象包一层：直接赋给局部变量会让 TS 的控制流分析把 `fire` 收窄成 never
    // （赋值发生在回调里，分析看不到），调用处就会报「not callable」。
    const pending: { fire: (() => void) | null } = { fire: null }
    const schedule = vi.fn((fn: () => void) => {
      pending.fire = fn
    })
    h.opts.restarter = { schedule, now: () => 0 }

    const ctx = await bootstrap(h.opts)
    // 内核崩溃 → 调度一次自动重启。
    crash(child)
    expect(schedule).toHaveBeenCalledTimes(1)

    const actions = ctx.createShutdownActions()
    await createShutdownHandler(actions, { timeoutMs: 2000 })()
    // 关机途中，那个「已经到点」的回调真的被执行了：不得 spawn 第二个内核。
    pending.fire?.()
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(spawnFn).toHaveBeenCalledTimes(1)
  })

  it('内核就绪时暴露采集器，用 Bearer secret 连接 /traffic 并推送快照', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = []
    const sockets: FakeStatsSocket[] = []
    const samples: unknown[] = []
    const h = await harness({
      statsConnect: (url, options) => {
        calls.push({ url, headers: options.headers })
        const socket = new FakeStatsSocket()
        sockets.push(socket)
        return socket
      },
      onStatsSample: (sample) => samples.push(sample)
    })
    const ctx = await bootstrap(h.opts)

    expect(ctx.stats).not.toBeNull()
    expect(ctx.coreInfo?.controllerPort).toBeGreaterThan(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(`ws://127.0.0.1:${ctx.coreInfo?.controllerPort}/traffic`)
    expect(calls[0]?.headers).toEqual({ authorization: expect.stringMatching(/^Bearer .+$/) })

    sockets[0]?.push(10, 20)
    expect(samples).toHaveLength(1)
    expect(ctx.stats?.snapshot()).toEqual({
      up: 10,
      down: 20,
      upTotal: 100,
      downTotal: 200,
      history: [{ up: 10, down: 20 }]
    })

    await ctx.stopAll()
    // 退出路径必须停掉采集器，否则重连定时器拖住事件循环。
    expect(sockets[0]?.closed).toBe(true)
  })

  it('内核就绪时连接与日志采集器连接对应 WS 端点，并下发快照与计数', async () => {
    const urls: string[] = []
    const connectionSockets: FakeStatsSocket[] = []
    const logSockets: FakeStatsSocket[] = []
    const snapshots: unknown[] = []
    const counts: unknown[] = []
    const h = await harness({
      connectionsConnect: (url) => {
        urls.push(url)
        const socket = new FakeStatsSocket()
        connectionSockets.push(socket)
        return socket
      },
      logsConnect: (url) => {
        urls.push(url)
        const socket = new FakeStatsSocket()
        logSockets.push(socket)
        return socket
      },
      onConnectionsSnapshot: (snapshot) => snapshots.push(snapshot),
      onLogCounts: (sample) => counts.push(sample)
    })
    const ctx = await bootstrap(h.opts)
    const port = ctx.coreInfo?.controllerPort

    expect(ctx.connections).not.toBeNull()
    expect(ctx.logs).not.toBeNull()
    expect(urls).toEqual([
      `ws://127.0.0.1:${port}/connections?interval=500`,
      `ws://127.0.0.1:${port}/logs?level=warning`
    ])

    connectionSockets[0]?.pushRaw(JSON.stringify({ memory: 1, connections: [] }))
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]).toMatchObject({ items: [], memory: 1 })

    logSockets[0]?.pushRaw(
      JSON.stringify({
        type: 'warning',
        payload: '[TCP] dial P (match M/) 127.0.0.1:1 --> example.com:80 error: refused'
      })
    )
    expect(counts).toEqual([{ recent: 1, windowMs: 3_600_000 }])

    await ctx.stopAll()
    // 退出清理必须停掉这两条 WS，否则重连定时器会拖住进程。
    expect(connectionSockets[0]?.closed).toBe(true)
    expect(logSockets[0]?.closed).toBe(true)
  })

  it('无配置时没有采集器，导入并重启后就有了', async () => {
    const sockets: FakeStatsSocket[] = []
    const h = await harness({
      config: null,
      statsConnect: () => {
        const socket = new FakeStatsSocket()
        sockets.push(socket)
        return socket
      }
    })
    const ctx = await bootstrap(h.opts)
    expect(ctx.stats).toBeNull()
    expect(sockets).toHaveLength(0)

    await mkdir(ctx.configDir, { recursive: true })
    await writeFile(path.join(ctx.configDir, 'upstream.yaml'), VALID_CONFIG)
    await ctx.restartCore()

    expect(ctx.stats).not.toBeNull()
    expect(sockets).toHaveLength(1)
    await ctx.stopAll()
    expect(sockets[0]?.closed).toBe(true)
  })

  it('重启内核复用同一个采集器，不重复建连', async () => {
    const sockets: FakeStatsSocket[] = []
    const h = await harness({
      statsConnect: () => {
        const socket = new FakeStatsSocket()
        sockets.push(socket)
        return socket
      }
    })
    const ctx = await bootstrap(h.opts)
    const collector = ctx.stats

    await ctx.restartCore()

    expect(ctx.stats).toBe(collector)
    expect(sockets).toHaveLength(1)
    await ctx.stopAll()
  })

  it('重启失败时停止并清空采集器，再次重启成功后复用同一实例', async () => {
    const sockets: FakeStatsSocket[] = []
    const h = await harness({
      statsConnect: () => {
        const socket = new FakeStatsSocket()
        sockets.push(socket)
        return socket
      }
    })
    const ctx = await bootstrap(h.opts)
    const collector = ctx.stats
    expect(collector).not.toBeNull()

    h.opts.validateFn = async () => ({ ok: false, output: 'bad' })
    await expect(ctx.restartCore()).rejects.toThrow()
    expect(ctx.stats).toBeNull()
    expect(sockets[0]?.closed).toBe(true)

    h.opts.validateFn = async () => ({ ok: true, output: 'ok' })
    await ctx.restartCore()
    expect(ctx.stats).toBe(collector)
    expect(sockets).toHaveLength(2)
    expect(sockets[1]?.closed).toBe(false)

    await ctx.stopAll()
  })

  it('采集器不向快照暴露 secret 或 controller 地址', async () => {
    const sockets: FakeStatsSocket[] = []
    const samples: unknown[] = []
    const h = await harness({
      statsConnect: () => {
        const socket = new FakeStatsSocket()
        sockets.push(socket)
        return socket
      },
      onStatsSample: (sample) => samples.push(sample)
    })
    const ctx = await bootstrap(h.opts)
    const state = JSON.parse(await readFile(path.join(h.dir, 'core-state.json'), 'utf8')) as {
      secret: string
      port: number
    }

    sockets[0]?.push(1, 2)
    const json = JSON.stringify(samples.at(-1))
    expect(json).not.toContain(state.secret)
    expect(json).not.toContain(String(state.port))
    expect(json).not.toMatch(/secret|authorization|Bearer/i)

    await ctx.stopAll()
  })

  it('退出清理会取消在途重启：validate 返回后不再 spawn 内核', async () => {
    const h = await harness()
    const ctx = await bootstrap(h.opts)
    expect(h.spawnFn).toHaveBeenCalledTimes(1)

    // 把重启卡在 validate 里，模拟用户在重启途中退出。
    let release!: () => void
    let validateStarted = false
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    h.opts.validateFn = async () => {
      validateStarted = true
      await gate
      return { ok: true, output: 'ok' }
    }

    const restart = ctx.restartCore()
    await waitFor(() => validateStarted)

    const stopping = ctx.stopAll()
    release()

    // 重启在看到退出标志后放弃，IPC 层会把异常映射成 {ok:false}。
    await expect(restart).rejects.toThrow(/退出/)
    await stopping

    // 只有启动时那一次 spawn；重启没有把内核重新拉起来。
    expect(h.spawnFn).toHaveBeenCalledTimes(1)
    expect(ctx.supervisor.status).toBe('stopped')
    expect((await h.pp.getSystemProxy()).enabled).toBe(false)
    // 清理结束后再点重启也只会拒绝，不会 spawn。
    await expect(ctx.restartCore()).rejects.toThrow(/退出/)
    expect(h.spawnFn).toHaveBeenCalledTimes(1)
  })

  it('首次启动途中被取消：不再 spawn，返回的上下文也没有内核', async () => {
    const h = await harness()
    const abort = new AbortController()
    let validateStarted = false
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    h.opts.validateFn = async () => {
      validateStarted = true
      await gate
      return { ok: true, output: 'ok' }
    }
    h.opts.signal = abort.signal

    const starting = bootstrap(h.opts)
    await waitFor(() => validateStarted)
    // 模拟用户在校验途中退出：此时还没有 context，stopAll 无从调用。
    abort.abort()
    release()

    const ctx = await starting
    // 校验之后、spawn 之前放弃：没有启动内核。
    expect(h.spawnFn).not.toHaveBeenCalled()
    expect(ctx.supervisor.status).toBe('stopped')
    expect(ctx.link).toBeNull()
    expect(ctx.coreInfo).toBeNull()
    // 清理仍然可以调用，且不会去动系统代理。
    await ctx.stopAll()
    expect((await h.pp.getSystemProxy()).enabled).toBe(false)
  })

  it('内核意外退出时转为 reconnecting、清空内核视图并还原系统代理', async () => {
    let child!: CrashableChild
    const sockets: FakeStatsSocket[] = []
    const connectionSockets: FakeStatsSocket[] = []
    const logSockets: FakeStatsSocket[] = []
    const h = await harness({
      proxyEnabled: true,
      spawn: () => {
        child = fakeChild()
        return child
      },
      connectionsConnect: () => {
        const socket = new FakeStatsSocket()
        connectionSockets.push(socket)
        return socket
      },
      logsConnect: () => {
        const socket = new FakeStatsSocket()
        logSockets.push(socket)
        return socket
      }
    })
    // 定时器只记录不执行：本条用例只断言「崩溃后的即时状态」。
    const schedule = vi.fn()
    h.opts.restarter = { schedule, now: () => 0 }
    h.opts.statsConnect = () => {
      const socket = new FakeStatsSocket()
      sockets.push(socket)
      return socket
    }
    const ctx = await bootstrap(h.opts)
    expect(ctx.startupStatus).toBe('ready')
    expect((await h.pp.getSystemProxy()).enabled).toBe(true)
    expect(ctx.stats).not.toBeNull()

    crash(child)

    expect(ctx.startupStatus).toBe('reconnecting')
    expect(ctx.coreInfo).toBeNull()
    expect(ctx.link).toBeNull()
    expect(ctx.proxyServer).toBeNull()
    expect(ctx.stats).toBeNull()
    expect(ctx.connections).toBeNull()
    expect(ctx.logs).toBeNull()
    expect(sockets[0]?.closed).toBe(true)
    expect(connectionSockets[0]?.closed).toBe(true)
    expect(logSockets[0]?.closed).toBe(true)
    // 一次崩溃只调度一次，且在 1 秒后。
    expect(schedule).toHaveBeenCalledTimes(1)
    expect(schedule.mock.calls[0]?.[1]).toBe(1000)
    // 还原代理是崩溃处理里的异步步骤；状态与视图字段已经同步转好。
    await waitFor(async () => (await h.pp.getSystemProxy()).enabled === false)
    await waitFor(() => ctx.proxyEnabled === false)
    expect(ctx.proxyEnabled).toBe(false)

    await ctx.stopAll()
  })

  it('重启内核触发的主动 stop 不会被误判为崩溃', async () => {
    const h = await harness()
    const ctx = await bootstrap(h.opts)

    await ctx.restartCore()
    // 给旧 supervisor 的 exit 事件留出处理时间：主动 stop 不应触发崩溃处理。
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(ctx.startupStatus).toBe('ready')
    expect(ctx.coreInfo).not.toBeNull()
    expect(ctx.link).not.toBeNull()
    expect(ctx.proxyServer).not.toBeNull()

    await ctx.stopAll()
    // 退出清理同样不是崩溃。
    expect(ctx.startupStatus).toBe('ready')
  })

  it('上次留下的是我们自己的内核：终止旧进程后启动新内核', async () => {
    const h = await harness()
    const first = await bootstrap(h.opts)
    const stale = await readStoredCoreState(h.dir)
    expect(stale.pid).toBe(CORE_PID)
    // 不调用 stopAll：模拟主进程被 taskkill /F，旧内核仍在后台运行。
    expect(first.startupStatus).toBe('ready')

    const killFn = vi.fn(async () => {})
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})

    const ctx = await bootstrap({
      ...h.opts,
      fetchFn: fetchForPort(stale.port, 200),
      isProcessAliveFn: () => true,
      processPathFn: async () => MIHOMO_PATH,
      killFn
    })

    // 旧 pid 被终止，随后本次启动真的拉起了新内核。
    expect(killFn).toHaveBeenCalledTimes(1)
    expect(killFn).toHaveBeenCalledWith(stale.pid)
    expect(h.spawnFn).toHaveBeenCalledTimes(2)
    expect(ctx.startupStatus).toBe('ready')
    expect(ctx.coreInfo?.pid).toBe(CORE_PID)

    // 状态文件已由本次启动重写，旧 secret 不再留在其中。
    const current = await readStoredCoreState(h.dir)
    expect(current.secret).not.toBe(stale.secret)
    expect(current.port).toBe(ctx.coreInfo?.controllerPort)

    // restore 只描述系统代理，不能把「清理了内核」伪装成代理恢复。
    expect(ctx.restore).toBe('none')
    const logged = infoSpy.mock.calls.map(([message]) => String(message)).join('\n')
    expect(logged).toContain('遗留的内核')
    // secret 永远不得进日志。
    expect(logged).not.toContain(stale.secret)

    await ctx.stopAll()
  })

  it('旧端口属于其它程序：不终止它，另选端口启动', async () => {
    const h = await harness()
    const first = await bootstrap(h.opts)
    const stale = await readStoredCoreState(h.dir)
    const staleMixed = Number(/:(\d+)$/.exec(first.proxyServer ?? '')?.[1])
    expect(staleMixed).toBeGreaterThan(0)

    // 真的占住旧端口：只有旧端口仍被监听时，allocatePort 才会保证换端口。
    const servers = await Promise.all([listenOn(stale.port), listenOn(staleMixed)])
    const killFn = vi.fn(async () => {})
    try {
      const ctx = await bootstrap({
        ...h.opts,
        fetchFn: fetchForPort(stale.port, 401),
        isProcessAliveFn: () => true,
        processPathFn: async () => MIHOMO_PATH,
        killFn
      })

      expect(killFn).not.toHaveBeenCalled()
      expect(ctx.startupStatus).toBe('ready')
      expect(ctx.coreInfo?.controllerPort).not.toBe(stale.port)
      expect(ctx.proxyServer).not.toBe(first.proxyServer)
      expect(first.proxyServer).not.toBeNull()

      await ctx.stopAll()
    } finally {
      await Promise.all(servers.map(closeServer))
    }
  })

  it('旧端口无人监听：判为 none，不终止任何进程', async () => {
    const h = await harness()
    await bootstrap(h.opts)
    const stale = await readStoredCoreState(h.dir)

    const killFn = vi.fn(async () => {})
    const ctx = await bootstrap({
      ...h.opts,
      fetchFn: refusedFetch(stale.port),
      isProcessAliveFn: () => true,
      processPathFn: async () => MIHOMO_PATH,
      killFn
    })

    expect(killFn).not.toHaveBeenCalled()
    expect(ctx.startupStatus).toBe('ready')
    await ctx.stopAll()
  })

  it('没有 core-state.json：不探测，直接启动', async () => {
    const h = await harness()
    const urls: string[] = []
    h.opts.fetchFn = (async (input: string | URL | Request) => {
      urls.push(String(input))
      return { ok: true, status: 200, json: async () => ({ version: 'test' }) } as Response
    }) as unknown as typeof fetch
    const killFn = vi.fn(async () => {})
    const isAliveFn = vi.fn(() => false)

    const ctx = await bootstrap({ ...h.opts, killFn, isProcessAliveFn: isAliveFn })

    expect(ctx.startupStatus).toBe('ready')
    expect(killFn).not.toHaveBeenCalled()
    expect(isAliveFn).not.toHaveBeenCalled()
    // 没有旧记录就没有探测：全部请求都指向本次启动的 controller 端口。
    expect(urls.length).toBeGreaterThan(0)
    const port = ctx.coreInfo?.controllerPort
    expect(urls.every((url) => url.includes(`:${port}/`))).toBe(true)

    await ctx.stopAll()
  })

  it('旧 pid 已经不存在：不尝试终止，正常启动', async () => {
    const h = await harness()
    await bootstrap(h.opts)
    const stale = await readStoredCoreState(h.dir)

    const killFn = vi.fn(async () => {})
    const pathFn = vi.fn(async () => MIHOMO_PATH)
    const ctx = await bootstrap({
      ...h.opts,
      fetchFn: fetchForPort(stale.port, 200),
      isProcessAliveFn: () => false,
      processPathFn: pathFn,
      killFn
    })

    // 进程已死就不必查完整路径，更不能调 taskkill。
    expect(pathFn).not.toHaveBeenCalled()
    expect(killFn).not.toHaveBeenCalled()
    expect(ctx.startupStatus).toBe('ready')
    await ctx.stopAll()
  })

  it('pid 仍存活但完整路径不是我们的 mihomo：不终止，启动继续', async () => {
    const h = await harness()
    await bootstrap(h.opts)
    const stale = await readStoredCoreState(h.dir)

    const killFn = vi.fn(async () => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ctx = await bootstrap({
      ...h.opts,
      fetchFn: fetchForPort(stale.port, 200),
      isProcessAliveFn: () => true,
      // 映像名同样是 mihomo.exe，但完整路径属于 Clash Party：只看名字会误杀。
      processPathFn: async () => FOREIGN_MIHOMO_PATH,
      killFn
    })

    expect(killFn).not.toHaveBeenCalled()
    expect(ctx.startupStatus).toBe('ready')
    const logged = warnSpy.mock.calls.map(([message]) => String(message)).join('\n')
    expect(logged).toContain('身份')
    expect(logged).not.toContain(stale.secret)

    await ctx.stopAll()
  })

  it('终止旧进程失败时记一条 warning，但不阻断启动', async () => {
    const h = await harness()
    await bootstrap(h.opts)
    const stale = await readStoredCoreState(h.dir)

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ctx = await bootstrap({
      ...h.opts,
      fetchFn: fetchForPort(stale.port, 200),
      isProcessAliveFn: () => true,
      processPathFn: async () => MIHOMO_PATH,
      killFn: async () => {
        throw new Error('taskkill failed')
      }
    })

    expect(ctx.startupStatus).toBe('ready')
    expect(h.spawnFn).toHaveBeenCalledTimes(2)
    const logged = warnSpy.mock.calls.map(([message]) => String(message)).join('\n')
    expect(logged).toContain('未能终止')
    expect(logged).not.toContain(stale.secret)

    await ctx.stopAll()
  })

  it('记录属于另一个仍存活的 Aether 实例：不探测、不终止、不删记录', async () => {
    const h = await harness({ config: null })
    const foreign = { pid: 400_000, port: 39_999, secret: 'foreign-secret', ownerPid: 500_000 }
    await seedStaleCore(h.dir, foreign)
    const fetchFn = vi.fn(
      async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response
    )
    const pathFn = vi.fn(async () => MIHOMO_PATH)
    const killFn = vi.fn(async () => {})

    const ctx = await bootstrap({
      ...h.opts,
      fetchFn: fetchFn as unknown as typeof fetch,
      isProcessAliveFn: (pid) => pid === foreign.ownerPid,
      processPathFn: pathFn,
      killFn
    })

    expect(ctx.startupStatus).toBe('no-config')
    expect(fetchFn).not.toHaveBeenCalled()
    expect(pathFn).not.toHaveBeenCalled()
    expect(killFn).not.toHaveBeenCalled()
    expect(await readStoredCoreState(h.dir)).toEqual(foreign)

    // stopAll 同样不能删另一个实例的记录。
    await ctx.stopAll()
    expect(await readStoredCoreState(h.dir)).toEqual(foreign)
  })

  it('记录的属主实例已退出：继续探测并清理遗留记录', async () => {
    const h = await harness({ config: null })
    const stale = { pid: 400_000, port: 39_999, secret: 'stale', ownerPid: 500_000 }
    await seedStaleCore(h.dir, stale)
    const fetchFn = refusedFetch(stale.port)

    const ctx = await bootstrap({
      ...h.opts,
      fetchFn,
      isProcessAliveFn: () => false,
      killFn: async () => {}
    })

    // 属主已死，ownerPid 不再是保护理由：探测照常进行，none 让旧记录失效。
    expect(fetchFn).toHaveBeenCalled()
    expect(ctx.startupStatus).toBe('no-config')
    expect(existsSync(path.join(h.dir, 'core-state.json'))).toBe(false)
    await ctx.stopAll()
  })

  it('记录属于当前进程：照常探测并清理', async () => {
    const h = await harness({ config: null })
    const stale = { pid: 400_000, port: 39_999, secret: 'own', ownerPid: process.pid }
    await seedStaleCore(h.dir, stale)
    const fetchFn = refusedFetch(stale.port)

    const ctx = await bootstrap({ ...h.opts, fetchFn })

    expect(fetchFn).toHaveBeenCalled()
    expect(ctx.startupStatus).toBe('no-config')
    expect(existsSync(path.join(h.dir, 'core-state.json'))).toBe(false)
    await ctx.stopAll()
  })

  it('core-state.json 内容损坏：删除损坏文件，不探测', async () => {
    const h = await harness({ config: null })
    await writeFile(path.join(h.dir, 'core-state.json'), 'not json', 'utf8')
    const fetchFn = vi.fn(
      async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response
    )

    const ctx = await bootstrap({ ...h.opts, fetchFn: fetchFn as unknown as typeof fetch })

    expect(ctx.startupStatus).toBe('no-config')
    expect(fetchFn).not.toHaveBeenCalled()
    expect(existsSync(path.join(h.dir, 'core-state.json'))).toBe(false)
    await ctx.stopAll()
  })

  it('core-state.json 读取失败（非 ENOENT）：不删除也不探测', async () => {
    const h = await harness({ config: null })
    const statePath = path.join(h.dir, 'core-state.json')
    // 目录会让 readFile 以 EISDIR/EPERM 失败，但不是 ENOENT。
    await mkdir(statePath)
    const fetchFn = vi.fn(
      async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response
    )

    const ctx = await bootstrap({ ...h.opts, fetchFn: fetchFn as unknown as typeof fetch })

    expect(ctx.startupStatus).toBe('no-config')
    expect(fetchFn).not.toHaveBeenCalled()
    expect(existsSync(statePath)).toBe(true)
    await ctx.stopAll()
    // stopAll 对读失败的记录同样不能强删。
    expect(existsSync(statePath)).toBe(true)
  })

  it.each([
    {
      name: 'ours',
      status: 200,
      refused: false,
      alive: true,
      path: MIHOMO_PATH,
      killThrows: false,
      expectCleared: true
    },
    {
      name: 'foreign',
      status: 401,
      refused: false,
      alive: true,
      path: MIHOMO_PATH,
      killThrows: false,
      expectCleared: true
    },
    {
      name: 'none',
      status: 0,
      refused: true,
      alive: true,
      path: MIHOMO_PATH,
      killThrows: false,
      expectCleared: true
    },
    {
      name: 'dead',
      status: 200,
      refused: false,
      alive: false,
      path: MIHOMO_PATH,
      killThrows: false,
      expectCleared: true
    },
    {
      name: 'identity-mismatch',
      status: 200,
      refused: false,
      alive: true,
      path: FOREIGN_MIHOMO_PATH,
      killThrows: false,
      expectCleared: false
    },
    {
      name: 'kill-failure',
      status: 200,
      refused: false,
      alive: true,
      path: MIHOMO_PATH,
      killThrows: true,
      expectCleared: false
    }
  ])('清理分支 $name 的 core-state.json 处理符合预期', async (branch) => {
    const h = await harness({ config: null })
    const stale = { pid: 400_000, port: 39_999, secret: 'stale-secret' }
    await seedStaleCore(h.dir, stale)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})

    const ctx = await bootstrap({
      ...h.opts,
      fetchFn: branch.refused ? refusedFetch(stale.port) : fetchForPort(stale.port, branch.status),
      isProcessAliveFn: () => branch.alive,
      processPathFn: async () => branch.path,
      killFn: branch.killThrows
        ? async () => {
            throw new Error('boom')
          }
        : async () => {}
    })

    // 无配置不会写入新的状态文件，因此文件变化只能来自清理本身。
    expect(ctx.startupStatus).toBe('no-config')
    expect(h.spawnFn).not.toHaveBeenCalled()
    if (branch.expectCleared) {
      expect(existsSync(path.join(h.dir, 'core-state.json'))).toBe(false)
    } else {
      // 身份不明 / 终止失败：保留唯一的孤儿记录，下次启动还能再试。
      expect(await readStoredCoreState(h.dir)).toEqual(stale)
    }
    await ctx.stopAll()
  })

  it('探测途中退出：中止探测，不再启动内核', async () => {
    const h = await harness()
    await bootstrap(h.opts)
    const stale = await readStoredCoreState(h.dir)

    const abort = new AbortController()
    let probeStarted = false
    let releaseProbe!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseProbe = resolve
    })
    h.opts.fetchFn = (async (input: string | URL | Request) => {
      if (String(input).includes(`:${stale.port}/`)) {
        probeStarted = true
        await gate
        return { ok: true, status: 200, json: async () => ({}) } as Response
      }
      return { ok: true, status: 200, json: async () => ({ version: 'test' }) } as Response
    }) as unknown as typeof fetch

    const starting = bootstrap({ ...h.opts, signal: abort.signal })
    await waitFor(() => probeStarted)
    // 用户退出：探测必须立刻放弃，不能把退出拖到 1.5 秒超时。
    abort.abort()
    releaseProbe()

    const ctx = await starting
    expect(h.spawnFn).toHaveBeenCalledTimes(1) // 只有第一次启动；本次没有 spawn
    expect(ctx.startupStatus).toBe('core-error')
    expect(ctx.coreInfo).toBeNull()
    expect(ctx.link).toBeNull()
    // 探测被中止时没有结论，唯一的孤儿记录必须保留，下次启动才能再找到它。
    expect(await readStoredCoreState(h.dir)).toEqual(stale)

    await ctx.stopAll()
  })
})

/**
 * 崩溃退避重启接线：1s / 2s / 4s，10 分钟内最多 3 次，用尽后转 core-error。
 *
 * 全部用注入的 `schedule` / `now` 驱动，没有真实定时器与真实进程。
 */
describe('崩溃退避重启', () => {
  type Scheduled = { fn: () => void; ms: number }

  /**
   * 手动推进的调度器：不执行真实定时器，测试自己决定何时「到点」。
   *
   * `status` 用来判断一次尝试是否已经落地：重启里有真实的文件 I/O，
   * 只等一个 0ms 定时器会在尝试完成之前就往下走。收敛条件覆盖三条出口：
   * 成功（ready）、失败后重排（pending 变长）、退避用尽（core-error）。
   */
  function manualSchedule(status: () => string | undefined): {
    schedule: (fn: () => void, ms: number) => void
    pending: Scheduled[]
    runAll(): Promise<void>
    delays(): number[]
  } {
    const pending: Scheduled[] = []
    const settled = (): boolean => {
      const current = status()
      // 终态只有 ready（成功）与 core-error（退避用尽）；中间型 config-error 只是
      // 一次失败尝试的瞬时状态，随后会被 catch 改成 reconnecting 并重排。
      return pending.length > 0 || current === 'ready' || current === 'core-error'
    }
    return {
      schedule: (fn, ms) => {
        pending.push({ fn, ms })
      },
      pending,
      /**
       * 只推进「此刻已排队」的定时器，一次调用对应一轮尝试。
       * 一轮失败会排下一轮，但不会在同一轮里继续执行——否则永远走不到
       * 「第 N 次尝试之间」的断言。
       */
      async runAll() {
        const batch = pending.splice(0, pending.length)
        for (const entry of batch) {
          entry.fn()
          await waitFor(settled)
        }
      },
      delays() {
        return pending.map((entry) => entry.ms)
      }
    }
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('一次崩溃只调度一次，1 秒后重启，成功后回到 ready', async () => {
    const scheduler = manualSchedule(() => ctx.startupStatus)
    let child!: CrashableChild
    const h = await harness({
      spawn: () => {
        child = fakeChild()
        return child
      }
    })
    h.opts.restarter = { schedule: scheduler.schedule, now: () => 0 }
    const ctx = await bootstrap(h.opts)
    expect(ctx.startupStatus).toBe('ready')
    expect(h.spawnFn).toHaveBeenCalledTimes(1)

    crash(child)
    expect(ctx.startupStatus).toBe('reconnecting')
    // 一次崩溃只有一次调度：退出事件与「尝试失败」都不能各记一笔。
    expect(scheduler.pending).toHaveLength(1)
    expect(scheduler.delays()).toEqual([1000])
    expect(h.spawnFn).toHaveBeenCalledTimes(1)

    await scheduler.runAll()

    expect(h.spawnFn).toHaveBeenCalledTimes(2)
    expect(ctx.startupStatus).toBe('ready')
    expect(ctx.coreInfo).not.toBeNull()
    expect(ctx.proxyServer).not.toBeNull()
    // 重启成功后没有残留调度：不会再冒出一次自动重启。
    expect(scheduler.pending).toHaveLength(0)

    await ctx.stopAll()
  })

  it('退避是 1s → 2s → 4s，第 4 次崩溃不再调度并转 core-error', async () => {
    const scheduler = manualSchedule(() => ctx.startupStatus)
    const children: CrashableChild[] = []
    const h = await harness({
      spawn: () => {
        const child = fakeChild()
        children.push(child)
        return child
      }
    })
    h.opts.restarter = { schedule: scheduler.schedule, now: () => 0 }
    const ctx = await bootstrap(h.opts)
    expect(children).toHaveLength(1)

    // 第 1 次崩溃 → 1000ms
    crash(children[0]!)
    expect(scheduler.delays()).toEqual([1000])
    await scheduler.runAll()
    expect(children).toHaveLength(2)
    expect(ctx.startupStatus).toBe('ready')

    // 第 2 次崩溃 → 2000ms
    crash(children[1]!)
    expect(scheduler.delays()).toEqual([2000])
    await scheduler.runAll()
    expect(children).toHaveLength(3)
    expect(ctx.startupStatus).toBe('ready')

    // 第 3 次崩溃 → 4000ms
    crash(children[2]!)
    expect(scheduler.delays()).toEqual([4000])
    await scheduler.runAll()
    expect(children).toHaveLength(4)
    expect(ctx.startupStatus).toBe('ready')

    // 第 4 次崩溃（10 分钟内）：不再调度，转 core-error 并把手动重启交还给用户。
    const spawnsBefore = h.spawnFn.mock.calls.length
    crash(children[3]!)
    expect(scheduler.pending).toHaveLength(0)
    expect(ctx.startupStatus).toBe('core-error')
    expect(h.spawnFn.mock.calls.length).toBe(spawnsBefore)

    await ctx.stopAll()
  })

  it('窗口之外的第 4 次崩溃仍可调度（10 分钟滚动窗口）', async () => {
    const scheduler = manualSchedule(() => ctx.startupStatus)
    let now = 0
    const children: CrashableChild[] = []
    const h = await harness({
      spawn: () => {
        const child = fakeChild()
        children.push(child)
        return child
      }
    })
    h.opts.restarter = { schedule: scheduler.schedule, now: () => now }
    const ctx = await bootstrap(h.opts)

    for (let index = 0; index < 3; index += 1) {
      crash(children[index]!)
      await scheduler.runAll()
    }
    expect(children).toHaveLength(4)

    // 早先的 3 次都已滚出 10 分钟窗口：计数重新从 1 开始，延迟回到 1 秒。
    now = 11 * 60_000
    crash(children[3]!)
    expect(ctx.startupStatus).toBe('reconnecting')
    expect(scheduler.delays()).toEqual([1000])

    await scheduler.runAll()
    expect(ctx.startupStatus).toBe('ready')
    await ctx.stopAll()
  })

  it('重启成功后自动重启不再触发（attempts 不清零，但窗口内没有第 4 次）', async () => {
    const scheduler = manualSchedule(() => ctx.startupStatus)
    let child!: CrashableChild
    const h = await harness({
      spawn: () => {
        child = fakeChild()
        return child
      }
    })
    h.opts.restarter = { schedule: scheduler.schedule, now: () => 0 }
    const ctx = await bootstrap(h.opts)

    crash(child)
    await scheduler.runAll()
    expect(ctx.startupStatus).toBe('ready')
    expect(h.spawnFn).toHaveBeenCalledTimes(2)

    // 成功之后继续等一段时间：没有新调度，也没有额外 spawn。
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(scheduler.pending).toHaveLength(0)
    expect(h.spawnFn).toHaveBeenCalledTimes(2)

    await ctx.stopAll()
  })

  it('自动重启把崩溃后关掉的系统代理重新接管（用户原本开着）', async () => {
    const scheduler = manualSchedule(() => ctx.startupStatus)
    let child!: CrashableChild
    const h = await harness({
      proxyEnabled: true,
      spawn: () => {
        child = fakeChild()
        return child
      }
    })
    h.opts.restarter = { schedule: scheduler.schedule, now: () => 0 }
    const ctx = await bootstrap(h.opts)
    expect((await h.pp.getSystemProxy()).enabled).toBe(true)

    crash(child)
    // 崩溃先还原代理，整机不空指向一个死端口。
    await waitFor(async () => (await h.pp.getSystemProxy()).enabled === false)
    expect(ctx.proxyEnabled).toBe(false)

    await scheduler.runAll()

    // `ready` 在重启收尾的中间点就落下（与手动重启同一顺序）；代理重新接管在
    // 那之后：系统代理先写回，再复核实际状态写进 ctx。两者分别等，避免只等到一半。
    await waitFor(
      async () => (await h.pp.getSystemProxy()).enabled === true && ctx.proxyEnabled === true
    )
    expect(ctx.startupStatus).toBe('ready')
    expect(ctx.proxyEnabled).toBe(true)
    expect((await h.pp.getSystemProxy()).server).toBe(ctx.proxyServer)

    await ctx.stopAll()
  })

  it('用户原本关着代理时自动重启不会擅自打开系统代理', async () => {
    const scheduler = manualSchedule(() => ctx.startupStatus)
    let child!: CrashableChild
    const h = await harness({
      proxyEnabled: false,
      spawn: () => {
        child = fakeChild()
        return child
      }
    })
    h.opts.restarter = { schedule: scheduler.schedule, now: () => 0 }
    const ctx = await bootstrap(h.opts)

    crash(child)
    await scheduler.runAll()

    expect(ctx.startupStatus).toBe('ready')
    expect(ctx.proxyEnabled).toBe(false)
    expect((await h.pp.getSystemProxy()).enabled).toBe(false)

    await ctx.stopAll()
  })

  it('同一轮里第二次崩溃仍按最初的用户意愿接管代理', async () => {
    const scheduler = manualSchedule(() => ctx.startupStatus)
    const children: CrashableChild[] = []
    const h = await harness({
      proxyEnabled: true,
      spawn: () => {
        const child = fakeChild()
        children.push(child)
        return child
      }
    })
    h.opts.restarter = { schedule: scheduler.schedule, now: () => 0 }
    const ctx = await bootstrap(h.opts)

    // 第一次崩溃 → 自动重启成功，代理重新接管。
    crash(children[0]!)
    await scheduler.runAll()
    await waitFor(async () => (await h.pp.getSystemProxy()).enabled === true)

    // 第二次崩溃：崩溃处理先还原代理，ctx.proxyEnabled 变成 false；
    // 但用户意愿仍是「开着」，重启成功后必须重新接管。
    crash(children[1]!)
    await waitFor(async () => (await h.pp.getSystemProxy()).enabled === false)
    await scheduler.runAll()
    await waitFor(
      async () => (await h.pp.getSystemProxy()).enabled === true && ctx.proxyEnabled === true
    )

    expect(ctx.startupStatus).toBe('ready')
    expect(ctx.proxyEnabled).toBe(true)

    await ctx.stopAll()
  })

  it('重启途中新内核又崩：不留下 ready，状态回到重连并继续退避', async () => {
    const scheduler = manualSchedule(() => ctx.startupStatus)
    const children: CrashableChild[] = []
    // 第二颗内核的握手上加一道闸：让崩溃确定发生在重启收尾途中，而不是之前或之后。
    let gate: { promise: Promise<void>; release: () => void } | null = null
    const h = await harness({
      spawn: () => {
        const child = fakeChild()
        children.push(child)
        return child
      }
    })
    h.opts.fetchFn = (async () => {
      if (gate !== null) await gate.promise
      return { ok: true, status: 200, json: async () => ({ version: 'test' }) } as Response
    }) as unknown as typeof fetch
    h.opts.restarter = { schedule: scheduler.schedule, now: () => 0 }
    const ctx = await bootstrap(h.opts)

    crash(children[0]!)
    // 手动推进这一轮到点：第二颗内核 spawn 出来后卡在握手上。
    const kickOff = scheduler.pending.shift()!
    let release!: () => void
    gate = { promise: new Promise<void>((resolve) => { release = resolve }), release: () => {} }
    kickOff.fn()
    await waitFor(() => children.length === 2)

    // 握手还没完成，新内核就崩了：崩溃处理接管状态并排下一轮退避。
    crash(children[1]!)
    await waitFor(() => scheduler.pending.length > 0)
    // 放行卡住的握手：这一轮重启会「成功」返回，但绝不能把状态写回 ready。
    gate = null
    release()

    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(ctx.startupStatus).toBe('reconnecting')
    expect(ctx.coreInfo).toBeNull()
    // 崩溃事件自己排了下一轮：只多一次，不是两次。
    expect(scheduler.pending).toHaveLength(1)
    expect(scheduler.delays()).toEqual([2000])

    await scheduler.runAll()
    expect(ctx.startupStatus).toBe('ready')

    await ctx.stopAll()
  })

  it('自动重启后会重建采样器（新内核的流量仍能上报）', async () => {
    const scheduler = manualSchedule(() => ctx.startupStatus)
    const sockets: FakeStatsSocket[] = []
    let child!: CrashableChild
    const h = await harness({
      spawn: () => {
        child = fakeChild()
        return child
      },
      statsConnect: () => {
        const socket = new FakeStatsSocket()
        sockets.push(socket)
        return socket
      }
    })
    h.opts.restarter = { schedule: scheduler.schedule, now: () => 0 }
    const ctx = await bootstrap(h.opts)
    expect(ctx.stats).not.toBeNull()

    crash(child)
    expect(ctx.stats).toBeNull()
    expect(sockets[0]?.closed).toBe(true)

    await scheduler.runAll()

    // 采集器是在内核确认起来后重建的；等它真正挂上（与 `ready` 同一次收尾）。
    await waitFor(() => ctx.stats !== null)
    expect(ctx.stats).not.toBeNull()
    // 采集器实例按会话复用，缓冲保留：重启只是重新 start 同一条 WS。
    expect(sockets).toHaveLength(2)
    expect(sockets[1]?.closed).toBe(false)

    await ctx.stopAll()
  })

  it('stopAll 取消退避定时器：用户退出后不再拉起内核', async () => {
    const scheduler = manualSchedule(() => ctx.startupStatus)
    let child!: CrashableChild
    const h = await harness({
      spawn: () => {
        child = fakeChild()
        return child
      }
    })
    h.opts.restarter = { schedule: scheduler.schedule, now: () => 0 }
    const ctx = await bootstrap(h.opts)
    const spawnsAfterStart = h.spawnFn.mock.calls.length

    crash(child)
    expect(scheduler.pending).toHaveLength(1)

    await ctx.stopAll()
    const spawnsAfterStop = h.spawnFn.mock.calls.length

    // 即使那个「已到点」的回调真的被触发，也不能再 spawn。
    for (const entry of scheduler.pending) entry.fn()
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(h.spawnFn.mock.calls.length).toBe(spawnsAfterStop)
    expect(spawnsAfterStop).toBe(spawnsAfterStart)
  })

  it('定时器与退出同时发生（同一 tick）也不会 spawn', async () => {
    // 真实 setTimeout 语义：回调排在 stopAll 的微任务之后执行。
    let fire!: () => void
    let child!: CrashableChild
    const h = await harness({
      spawn: () => {
        child = fakeChild()
        return child
      }
    })
    h.opts.restarter = {
      schedule: (fn) => {
        fire = fn
      },
      now: () => 0
    }
    const ctx = await bootstrap(h.opts)
    const spawnsAfterStart = h.spawnFn.mock.calls.length

    crash(child)
    // 用户在同一 tick 退出：stopAll 同步置位并取消，然后我们才触发那个定时器。
    const stopping = ctx.stopAll()
    fire()
    await stopping
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(h.spawnFn.mock.calls.length).toBe(spawnsAfterStart)
  })

  it('旧 supervisor 的迟到退出事件不会重新调度', async () => {
    const scheduler = manualSchedule(() => ctx.startupStatus)
    let child!: CrashableChild
    const h = await harness({
      spawn: () => {
        child = fakeChild()
        return child
      }
    })
    h.opts.restarter = { schedule: scheduler.schedule, now: () => 0 }
    const ctx = await bootstrap(h.opts)
    const first = child

    crash(first)
    await scheduler.runAll()
    expect(ctx.startupStatus).toBe('ready')
    expect(scheduler.pending).toHaveLength(0)

    // 第一个内核的退出事件可能延迟送达（Node 在主进程繁忙时并不保证顺序）。
    // 它来自已被替换的 supervisor，不能再一次触发退避。
    first.lateExit()
    expect(ctx.startupStatus).toBe('ready')
    expect(scheduler.pending).toHaveLength(0)

    await ctx.stopAll()
  })

  it('重启尝试自身失败时只算一次崩溃，按退避重试而不是双倍计数', async () => {
    const scheduler = manualSchedule(() => ctx.startupStatus)
    const children: CrashableChild[] = []
    let allowValidate = true
    const h = await harness({
      spawn: () => {
        const child = fakeChild()
        children.push(child)
        return child
      },
      validateFn: async () => (allowValidate ? { ok: true, output: 'ok' } : { ok: false, output: 'bad' })
    })
    h.opts.restarter = { schedule: scheduler.schedule, now: () => 0 }
    const ctx = await bootstrap(h.opts)

    // 崩溃之后配置校验失败：启动失败一次，但只消耗一次退避名额。
    allowValidate = false
    crash(children[0]!)
    await scheduler.runAll()
    expect(ctx.startupStatus).toBe('reconnecting')
    expect(scheduler.delays()).toEqual([2000])

    // 下一次尝试又失败：仍是单次计数，延迟走到 4s。
    await scheduler.runAll()
    expect(scheduler.delays()).toEqual([4000])

    // 第 4 次尝试失败（第 4 次记数）：退避用尽，转 core-error。
    await scheduler.runAll()
    expect(scheduler.pending).toHaveLength(0)
    expect(ctx.startupStatus).toBe('core-error')

    await ctx.stopAll()
  })

  it('自动重启不把代理偏好落盘为关闭（仍会继续重试）', async () => {
    const scheduler = manualSchedule(() => ctx.startupStatus)
    const h = await harness({ proxyEnabled: true })
    const ctx = await bootstrap(h.opts)

    h.opts.validateFn = async () => ({ ok: false, output: 'bad' })
    const children: CrashableChild[] = []
    void children
    // 触发一次崩溃：用第一次 spawn 出来的 child。
    const child = h.spawnFn.mock.results[0]!.value as CrashableChild
    crash(child)
    await scheduler.runAll()

    // 手动重启会把 proxyEnabled 落盘为 false；自动重启不能，否则一次失败就把
    // 用户的偏好永久改掉，后续重试即使成功也不会再接管代理。
    expect(JSON.parse(await readFile(path.join(h.dir, 'settings.json'), 'utf8'))).toEqual({
      proxyEnabled: true
    })

    await ctx.stopAll()
  })

  it('用户手动重启会取消在途的自动重启', async () => {
    const scheduler = manualSchedule(() => ctx.startupStatus)
    let child!: CrashableChild
    const h = await harness({
      spawn: () => {
        child = fakeChild()
        return child
      }
    })
    h.opts.restarter = { schedule: scheduler.schedule, now: () => 0 }
    const ctx = await bootstrap(h.opts)

    crash(child)
    expect(scheduler.pending).toHaveLength(1)

    // core-error 之外的用户操作（IPC「重启内核」）会让用户重新掌控：
    // 后台定时器必须被取消，否则会再拉起一个内核。
    await ctx.restartCore()
    expect(ctx.startupStatus).toBe('ready')
    const spawns = h.spawnFn.mock.calls.length

    for (const entry of scheduler.pending) entry.fn()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(h.spawnFn.mock.calls.length).toBe(spawns)

    await ctx.stopAll()
  })
})

/** 生产适配器的纯函数与执行器：用假的 execFile 覆盖，不碰真实进程。 */
function fakeExec(
  handler: (file: string, args: string[]) => { stdout: string }
): ExecFileFn & ReturnType<typeof vi.fn> {
  return vi.fn(async (file: string, args: string[]) => handler(file, args)) as unknown as
    ExecFileFn &
    ReturnType<typeof vi.fn>
}

describe('孤儿清理的生产适配器', () => {
  it('解析 tasklist CSV 的映像名', () => {
    expect(parseTasklistCsvImage('"mihomo.exe","1234","Console","1","24,000 K"\r\n')).toBe(
      'mihomo.exe'
    )
    expect(parseTasklistCsvImage('"Clash Party.exe","1","Services","0","1 K"')).toBe(
      'Clash Party.exe'
    )
  })

  it('本地化的「没有任务」输出不算映像名', () => {
    expect(parseTasklistCsvImage('信息: 没有运行的任务匹配指定标准。\r\n')).toBeNull()
    expect(
      parseTasklistCsvImage('INFO: No tasks are running which match the specified criteria.\r\n')
    ).toBeNull()
  })

  it('畸形的 tasklist 行返回 null', () => {
    expect(parseTasklistCsvImage('')).toBeNull()
    expect(parseTasklistCsvImage('mihomo.exe,1234')).toBeNull()
    expect(parseTasklistCsvImage('"unterminated')).toBeNull()
  })

  it('存活判断：EPERM 视为存活，ESRCH 视为死亡，非法 pid 直接拒绝', () => {
    expect(isProcessAliveWith(1234, () => {})).toBe(true)
    expect(
      isProcessAliveWith(1234, () => {
        throw Object.assign(new Error('denied'), { code: 'EPERM' })
      })
    ).toBe(true)
    expect(
      isProcessAliveWith(1234, () => {
        throw Object.assign(new Error('gone'), { code: 'ESRCH' })
      })
    ).toBe(false)
    expect(isProcessAliveWith(0, () => {})).toBe(false)
    expect(isProcessAliveWith(-1, () => {})).toBe(false)
  })

  it('Windows 终止使用 taskkill /F /PID，且不经过 shell', async () => {
    const exec = fakeExec(() => ({ stdout: '' }))
    const signal = vi.fn()
    await terminateProcessWith(1234, exec, 'win32', signal)

    expect(exec).toHaveBeenCalledWith(
      'taskkill',
      ['/F', '/PID', '1234'],
      expect.objectContaining({ windowsHide: true, timeout: 5000 })
    )
    expect(signal).not.toHaveBeenCalled()
    expect(taskkillArgs(1234)).toEqual(['/F', '/PID', '1234'])
  })

  it('非 Windows 退回信号，不调用 taskkill', async () => {
    const exec = fakeExec(() => ({ stdout: '' }))
    const signal = vi.fn()
    await terminateProcessWith(1234, exec, 'linux', signal)

    expect(exec).not.toHaveBeenCalled()
    expect(signal).toHaveBeenCalledWith(1234, 'SIGKILL')
  })

  it('queryImageName 解析正常输出；无匹配与 exec 失败都返回 null', async () => {
    const ok = fakeExec(() => ({ stdout: '"mihomo.exe","1","Console","1","1 K"\r\n' }))
    expect(await queryImageName(1, ok, 'win32')).toBe('mihomo.exe')

    const none = fakeExec(() => ({ stdout: '信息: 没有运行的任务匹配指定标准。\r\n' }))
    expect(await queryImageName(1, none, 'win32')).toBeNull()

    const failed = vi.fn(async () => {
      throw new Error('tasklist missing')
    }) as unknown as ExecFileFn
    expect(await queryImageName(1, failed, 'win32')).toBeNull()
  })

  it('queryFullPath 去掉换行；空输出与执行失败返回 null', async () => {
    const ok = fakeExec(() => ({ stdout: 'D:\\a-proxy\\vendor\\mihomo.exe\r\n' }))
    expect(await queryFullPath(1, ok, 'win32')).toBe('D:\\a-proxy\\vendor\\mihomo.exe')

    const empty = fakeExec(() => ({ stdout: ' \r\n' }))
    expect(await queryFullPath(1, empty, 'win32')).toBeNull()

    const failed = vi.fn(async () => {
      throw new Error('powershell missing')
    }) as unknown as ExecFileFn
    expect(await queryFullPath(1, failed, 'win32')).toBeNull()
  })

  it('processPathWith：映像名不符就不查完整路径；同名不同路径返回后由身份判定拒绝', async () => {
    const foreignImage = fakeExec(() => ({ stdout: '"chrome.exe","1","Console","1","1 K"\r\n' }))
    expect(await processPathWith(1, MIHOMO_PATH, foreignImage, 'win32')).toBeNull()
    expect(foreignImage).toHaveBeenCalledTimes(1)

    const sameNameForeignPath = fakeExec((file) => ({
      stdout:
        file === 'tasklist'
          ? '"mihomo.exe","1","Console","1","1 K"\r\n'
          : 'C:\\Program Files\\Clash Party\\resources\\sidecar\\mihomo.exe\r\n'
    }))
    const actual = await processPathWith(1, MIHOMO_PATH, sameNameForeignPath, 'win32')
    expect(actual).toBe('C:\\Program Files\\Clash Party\\resources\\sidecar\\mihomo.exe')
    expect(sameExecutable(actual!, MIHOMO_PATH)).toBe(false)
  })

  it('sameExecutable 忽略大小写、区分不同路径', () => {
    expect(sameExecutable(MIHOMO_PATH, MIHOMO_PATH.toUpperCase())).toBe(true)
    expect(sameExecutable(MIHOMO_PATH, FOREIGN_MIHOMO_PATH)).toBe(false)
  })
})

describe('热重载', () => {
  /** 只把 PUT /configs 交给测试处理，其余（握手、/version）一律 200。 */
  function fetchWithReload(reply: () => { ok: boolean; status: number }): {
    fetchFn: typeof fetch
    puts: string[]
  } {
    const puts: string[] = []
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if ((init?.method ?? 'GET').toUpperCase() === 'PUT') {
        puts.push(url)
        const r = reply()
        return { ok: r.ok, status: r.status, json: async () => ({}) }
      }
      return { ok: true, status: 200, json: async () => ({ version: 'test' }) }
    }) as unknown as typeof fetch
    return { fetchFn, puts }
  }

  const NEW_CONFIG = `proxies:
  - { name: 新节点, type: ss, server: 1.2.3.4, port: 443, cipher: aes-128-gcm, password: x }
proxy-groups:
  - { name: Proxy, type: select, proxies: [新节点, DIRECT] }
rules:
  - MATCH,Proxy
`

  async function writeUpstream(dir: string, text: string): Promise<void> {
    await writeFile(path.join(dir, 'profiles', 'default', 'upstream.yaml'), text)
  }

  function runtimePath(dir: string): string {
    return path.join(dir, 'profiles', 'default', 'runtime.yaml')
  }

  it('内核在跑：重新生成 runtime.yaml 并 PUT /configs，不重启进程', async () => {
    const { fetchFn, puts } = fetchWithReload(() => ({ ok: true, status: 204 }))
    const h = await harness({ fetchFn })
    const ctx = await bootstrap(h.opts)
    const spawnsBefore = h.spawnFn.mock.calls.length

    await writeUpstream(h.dir, NEW_CONFIG)
    await ctx.reloadCore()

    expect(puts).toHaveLength(1)
    expect(puts[0]).toContain('/configs?force=true')
    // 进程没换：热重载的价值就在这里。
    expect(h.spawnFn.mock.calls.length).toBe(spawnsBefore)
    expect(ctx.startupStatus).toBe('ready')
    // 新配置真的落进了 runtime.yaml，且 profile 摘要跟着更新。
    expect(await readFile(runtimePath(h.dir), 'utf8')).toContain('新节点')
    expect(ctx.profile).toEqual({ nodeCount: 1, groupCount: 1 })
    await ctx.stopAll()
  })

  it('内核没在跑时直接拒绝：没有可重载的对象', async () => {
    const h = await harness({ config: null })
    const ctx = await bootstrap(h.opts)

    await expect(ctx.reloadCore()).rejects.toThrow('内核未运行')
    await ctx.stopAll()
  })

  it('新配置校验不过：抛错并把 runtime.yaml 恢复成重载前的样子', async () => {
    let calls = 0
    const h = await harness({
      fetchFn: fetchWithReload(() => ({ ok: true, status: 204 })).fetchFn,
      validateFn: async () => {
        calls += 1
        return calls === 1 ? { ok: true, output: 'ok' } : { ok: false, output: 'bad' }
      }
    })
    const ctx = await bootstrap(h.opts)
    const before = await readFile(runtimePath(h.dir), 'utf8')

    await writeUpstream(h.dir, NEW_CONFIG)
    await expect(ctx.reloadCore()).rejects.toThrow('内核未能通过校验')

    // 坏配置绝不能留在磁盘上：否则下次启动也会起不来。
    expect(await readFile(runtimePath(h.dir), 'utf8')).toBe(before)
    await ctx.stopAll()
  })

  it('内核拒收新配置：回滚磁盘并再 PUT 一次让内核与文件一致', async () => {
    const { fetchFn, puts } = fetchWithReload(() => ({ ok: false, status: 400 }))
    const h = await harness({ fetchFn })
    const ctx = await bootstrap(h.opts)
    const before = await readFile(runtimePath(h.dir), 'utf8')

    await writeUpstream(h.dir, NEW_CONFIG)
    await expect(ctx.reloadCore()).rejects.toThrow('HTTP 400')

    expect(await readFile(runtimePath(h.dir), 'utf8')).toBe(before)
    expect(puts).toHaveLength(2)
    await ctx.stopAll()
  })
})
