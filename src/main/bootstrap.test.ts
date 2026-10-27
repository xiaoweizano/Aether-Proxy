import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { bootstrap, type BootstrapOptions } from './bootstrap'
import { FakePlatformProxy } from './proxy/fake'
import { ProxyOwnership } from './proxy/ownership'
import type { WebSocketLike } from './stats'

const VALID_CONFIG = `proxies: []
proxy-groups:
  - { name: Proxy, type: select, proxies: [DIRECT] }
rules:
  - MATCH,DIRECT
`

const CORE_PID = 424242

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
function fakeChild(onKill?: () => void): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess
  Object.assign(child, {
    pid: CORE_PID,
    exitCode: null,
    kill: vi.fn(() => {
      onKill?.()
      ;(child as unknown as { exitCode: number | null }).exitCode = 0
      child.emit('exit', 0, null)
      return true
    })
  })
  return child
}

function okFetch(): typeof fetch {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ version: 'test' })
  })) as unknown as typeof fetch
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
      fetchFn: okFetch(),
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
      ...(options.onStatsSample === undefined ? {} : { onStatsSample: options.onStatsSample }),
      ...(options.onConnectionsSnapshot === undefined
        ? {}
        : { onConnectionsSnapshot: options.onConnectionsSnapshot }),
      ...(options.onLogCounts === undefined ? {} : { onLogCounts: options.onLogCounts })
    }
  }
}

describe('bootstrap', () => {
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

  it('内核意外退出时转为 core-error、清空内核视图并还原系统代理', async () => {
    let child!: ChildProcess
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
    h.opts.statsConnect = () => {
      const socket = new FakeStatsSocket()
      sockets.push(socket)
      return socket
    }
    const ctx = await bootstrap(h.opts)
    expect(ctx.startupStatus).toBe('ready')
    expect((await h.pp.getSystemProxy()).enabled).toBe(true)
    expect(ctx.stats).not.toBeNull()

    // 绕过 stop()：直接模拟内核自己退出（崩溃 / 被外部杀掉）。
    ;(child as unknown as { exitCode: number | null }).exitCode = 1
    child.emit('exit', 1, null)

    expect(ctx.startupStatus).toBe('core-error')
    expect(ctx.coreInfo).toBeNull()
    expect(ctx.link).toBeNull()
    expect(ctx.proxyServer).toBeNull()
    expect(ctx.stats).toBeNull()
    expect(ctx.connections).toBeNull()
    expect(ctx.logs).toBeNull()
    expect(sockets[0]?.closed).toBe(true)
    expect(connectionSockets[0]?.closed).toBe(true)
    expect(logSockets[0]?.closed).toBe(true)
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
})
