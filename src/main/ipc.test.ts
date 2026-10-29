import { describe, it, expect, vi } from 'vitest'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { CoreInfo } from '../shared/types'
import type { AppContext } from './bootstrap'
import type { CoreSupervisor } from './core/supervisor'
import type { SystemProxyController } from './proxy/controller'
import type { ProxyOwnership } from './proxy/ownership'
import type { CoreLink, ProxiesResponse } from './core/link'
import { CoreLink as RealCoreLink } from './core/link'
import type { WebSocketLike } from './ws'
import { ConnectionsCollector } from './connections'
import { LogsCollector } from './logs'
import { IPC } from '../shared/ipc'
import type { ConnectionsSnapshot, DialFailureCounts } from '../shared/ipc'
import {
  buildStatusView,
  registerIpcHandlers,
  registerUnavailableHandlers,
  toProxyGroups,
  type IpcMainLike
} from './ipc'

const CORE_INFO: CoreInfo = {
  pid: 4242,
  version: 'v1.19.32',
  controllerPort: 9090,
  startedAt: 1_700_000_000_000
}

/**
 * 真实 mihomo `/proxies` 响应（见 test/fixtures/proxies.json）：类型是 Go 名
 * （Selector / URLTest / Shadowsocks / Direct），GLOBAL 永远存在且排在最前。
 * 测试不再手写小写 `select` / `ss`，那种形状在真机上根本不会出现。
 */
function realProxies(): ProxiesResponse {
  const raw = readFileSync(path.join(process.cwd(), 'test', 'fixtures', 'proxies.json'), 'utf8')
  return JSON.parse(raw) as ProxiesResponse
}

interface FakeIpc {
  handlers: Map<string, (event: unknown, ...args: unknown[]) => unknown>
  handle: IpcMainLike['handle']
}

function fakeIpc(): FakeIpc {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  return {
    handlers,
    handle(channel, listener) {
      handlers.set(channel, listener)
    }
  }
}

async function invoke(ipc: FakeIpc, channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = ipc.handlers.get(channel)
  if (!handler) throw new Error(`未注册的通道：${channel}`)
  return handler({}, ...args)
}

/** 采集器测试用的最小 WS 替身：记录消息回调，允许手动推帧。 */
class FakeSocket implements WebSocketLike {
  private readonly messages: ((data: unknown) => void)[] = []
  closed = false

  on(event: 'message', cb: (data: unknown) => void): void
  on(event: 'close', cb: () => void): void
  on(event: 'error', cb: (err: unknown) => void): void
  on(
    event: 'message' | 'close' | 'error',
    cb: ((data: unknown) => void) | (() => void) | ((err: unknown) => void)
  ): void {
    if (event === 'message') this.messages.push(cb as (data: unknown) => void)
  }

  close(): void {
    this.closed = true
  }

  push(data: unknown): void {
    for (const cb of this.messages) cb(data)
  }
}

interface FetchedCall {
  url: string
  init: RequestInit | undefined
}

function fakeLink(status = 200): { link: CoreLink; calls: FetchedCall[] } {
  const calls: FetchedCall[] = []
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return { ok: status >= 200 && status < 300, status, json: async () => ({}) } as Response
  }) as unknown as typeof fetch
  return { link: new RealCoreLink('http://127.0.0.1:9090', 'top-secret', fn), calls }
}

interface Harness {
  dir: string
  ctx: AppContext
  ipc: FakeIpc
  deps: { settingsFile: string }
  controller: { enable: ReturnType<typeof vi.fn>; disable: ReturnType<typeof vi.fn> }
  supervisor: {
    stop: ReturnType<typeof vi.fn>
    start: ReturnType<typeof vi.fn>
    status: string
  }
  stopAll: ReturnType<typeof vi.fn>
}

async function harness(options: {
  proxyServer?: string | null
  linkStatus?: number | null
  pickImportFile?: () => Promise<string | null>
  connections?: ConnectionsCollector | null
  logs?: LogsCollector | null
  openPath?: (target: string) => Promise<string>
  windowControls?: { minimize(): void; toggleMaximize(): void; close(): void }
} = {}): Promise<Harness> {
  const dir = await mkdtemp(path.join(tmpdir(), 'aether-ipc-'))
  const controller = {
    enable: vi.fn(async () => {}),
    disable: vi.fn(async () => {})
  }
  const supervisor = {
    stop: vi.fn(async () => {}),
    start: vi.fn(async () => CORE_INFO),
    status: 'running'
  }
  const stopAll = vi.fn(async () => {})
  const link = options.linkStatus === null ? null : fakeLink(options.linkStatus ?? 200).link

  const ctx: AppContext = {
    profileDir: path.join(dir, 'profiles', 'default'),
    configDir: path.join(dir, 'profiles', 'default'),
    supervisor: supervisor as unknown as CoreSupervisor,
    controller: controller as unknown as SystemProxyController,
    ownership: {} as unknown as ProxyOwnership,
    mode: 'rule',
    startupStatus: 'ready',
    restore: 'none',
    proxyEnabled: false,
    proxyServer: options.proxyServer === undefined ? '127.0.0.1:7891' : options.proxyServer,
    coreInfo: { ...CORE_INFO },
    profile: { nodeCount: 3, groupCount: 1 },
    link,
    stats: null,
    connections: options.connections ?? null,
    logs: options.logs ?? null,
    setMode(mode) {
      ctx.mode = mode
    },
    async restartCore() {
      await supervisor.stop()
      let info: CoreInfo
      try {
        info = await supervisor.start()
      } catch (err) {
        // 与真实 bootstrap 一致：失败时状态转为 core-error、清空内核视图。
        ctx.startupStatus = 'core-error'
        ctx.coreInfo = null
        throw err
      }
      ctx.coreInfo = info
      ctx.startupStatus = 'ready'
      await ctx.onCoreRestarted(info)
      return info
    },
    async onCoreRestarted(info) {
      ctx.coreInfo = info
    },
    stopAll
  }

  const ipc = fakeIpc()
  const deps = {
    settingsFile: path.join(dir, 'settings.json'),
    ...(options.pickImportFile === undefined ? {} : { pickImportFile: options.pickImportFile }),
    ...(options.openPath === undefined ? {} : { openPath: options.openPath }),
    ...(options.windowControls === undefined ? {} : { windowControls: options.windowControls })
  }
  registerIpcHandlers(ipc, ctx, deps)
  return { dir, ctx, ipc, deps, controller, supervisor, stopAll }
}

describe('buildStatusView', () => {
  it('状态视图不包含敏感字段', async () => {
    const { ctx } = await harness()
    // 即使内部对象带有这些字段，视图也只能是白名单字段。
    const dirty = ctx as unknown as Record<string, unknown>
    dirty.secret = 'super-secret-token'
    dirty.upstream = { password: 'hunter2', token: 'abc' }
    dirty.configPath = 'C:/secret/runtime.yaml'
    dirty.controllerPort = 9090

    const json = JSON.stringify(buildStatusView(ctx))
    // controller 端口与 secret 同级敏感：渲染层只需要 mixed-port。
    expect(json).not.toMatch(/secret|upstream|password|token|configPath|controllerPort/i)
  })

  it('逐字段映射内核与配置摘要，端口取 mixed-port 而非 controller 端口', async () => {
    const { ctx } = await harness()
    // harness 的 coreInfo.controllerPort 是 9090；proxyServer 的 7891 才是界面该看到的端口。
    expect(ctx.coreInfo?.controllerPort).toBe(9090)
    const view = buildStatusView(ctx)
    expect(view).toEqual({
      status: 'ready',
      restore: 'none',
      mode: 'rule',
      proxyEnabled: false,
      core: { version: 'v1.19.32', proxyPort: 7891, startedAt: 1_700_000_000_000 },
      profile: { nodeCount: 3, groupCount: 1 }
    })
    expect(view.core?.proxyPort).not.toBe(ctx.coreInfo?.controllerPort)
    expect(JSON.stringify(view)).not.toContain('9090')
  })

  it('内核未运行时省略 core 字段', async () => {
    const { ctx } = await harness()
    ctx.coreInfo = null
    const view = buildStatusView(ctx)
    expect(view).not.toHaveProperty('core')
  })

  it('mixed-port 未知时也不暴露 controller 端口', async () => {
    const { ctx } = await harness({ proxyServer: null })
    const view = buildStatusView(ctx)
    expect(view).not.toHaveProperty('core')
    expect(JSON.stringify(view)).not.toContain('9090')
  })

  it('反映运行期更新（模式、代理开关）', async () => {
    const { ctx } = await harness()
    ctx.setMode('global')
    ctx.proxyEnabled = true
    const view = buildStatusView(ctx)
    expect(view.mode).toBe('global')
    expect(view.proxyEnabled).toBe(true)
  })
})

describe('statusGet', () => {
  it('返回构建好的状态视图', async () => {
    const { ctx, ipc } = await harness()
    expect(await invoke(ipc, IPC.statusGet)).toEqual(buildStatusView(ctx))
  })
})

describe('proxiesGet', () => {
  it('把真实形状的内核策略组映射为白名单视图', async () => {
    const payload = realProxies()
    const fn = (async () => ({ ok: true, status: 200, json: async () => payload })) as unknown as typeof fetch
    const { ctx, ipc } = await harness()
    ctx.link = new RealCoreLink('http://127.0.0.1:9090', 's', fn)

    const groups = await invoke(ipc, IPC.proxiesGet)
    // GLOBAL 排在最前，类型保持内核返回的 Go 名；延迟取节点 history 的最后一条。
    expect(groups).toEqual([
      {
        name: 'GLOBAL',
        type: 'Selector',
        now: 'DIRECT',
        nodes: [{ name: 'Proxy' }, { name: 'Auto' }, { name: 'DIRECT' }]
      },
      {
        name: 'Auto',
        type: 'URLTest',
        now: 'DIRECT',
        nodes: [{ name: 'HK-01', delay: 41 }, { name: 'US-01', delay: 120 }, { name: 'DIRECT' }]
      },
      {
        name: 'Proxy',
        type: 'Selector',
        now: 'HK-01',
        nodes: [
          { name: 'HK-01', delay: 41 },
          { name: 'US-01', delay: 120 },
          { name: 'Auto' },
          { name: 'DIRECT' }
        ]
      }
    ])
  })

  it('无内核链接时返回空数组', async () => {
    const { ipc } = await harness({ linkStatus: null })
    expect(await invoke(ipc, IPC.proxiesGet)).toEqual([])
  })

  it('toProxyGroups 忽略缺少 all 的条目', () => {
    expect(toProxyGroups({ proxies: { HK: { name: 'HK', type: 'Shadowsocks' } } })).toEqual([])
  })

  it('toProxyGroups 带出自动组的 fixed，空串按未钉选省略', () => {
    const groups = toProxyGroups({
      proxies: {
        Auto: { name: 'Auto', type: 'URLTest', now: 'n1', fixed: 'n2', all: ['n1', 'n2'] },
        Empty: { name: 'Empty', type: 'URLTest', now: 'n1', fixed: '', all: ['n1'] },
        n1: { name: 'n1', type: 'Shadowsocks' },
        n2: { name: 'n2', type: 'Shadowsocks' }
      }
    })

    expect(groups).toEqual([
      { name: 'Auto', type: 'URLTest', now: 'n1', fixed: 'n2', nodes: [{ name: 'n1' }, { name: 'n2' }] },
      expect.objectContaining({ name: 'Empty', now: 'n1' })
    ])
    expect(groups[1]).not.toHaveProperty('fixed')
  })

  it('真实形状的 /proxies 没有 fixed 时不凭空补字段', () => {
    const groups = toProxyGroups(realProxies())
    for (const group of groups) expect(group).not.toHaveProperty('fixed')
  })
})

describe('modeSet', () => {
  it('成功后 PATCH /configs 并更新上下文模式', async () => {
    const { ctx, ipc } = await harness()
    const { link, calls } = fakeLink()
    ctx.link = link

    expect(await invoke(ipc, IPC.modeSet, 'global')).toEqual({ ok: true, status: 200 })
    expect(ctx.mode).toBe('global')
    expect(calls[0]?.url).toBe('http://127.0.0.1:9090/configs')
    expect(calls[0]?.init?.method).toBe('PATCH')
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ mode: 'global' })
  })

  it('内核拒绝时返回 ok:false 且不改变上下文模式', async () => {
    const { ctx, ipc } = await harness()
    ctx.link = fakeLink(500).link

    expect(await invoke(ipc, IPC.modeSet, 'direct')).toEqual({ ok: false, status: 500 })
    expect(ctx.mode).toBe('rule')
  })

  it('传输错误不抛出，返回 status 0', async () => {
    const { ctx, ipc } = await harness()
    const fn = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    ctx.link = new RealCoreLink('http://127.0.0.1:9090', 'secret', fn)

    expect(await invoke(ipc, IPC.modeSet, 'direct')).toEqual({ ok: false, status: 0 })
    expect(ctx.mode).toBe('rule')
  })

  it('非法模式参数不触碰内核', async () => {
    const { ctx, ipc } = await harness()
    const { link, calls } = fakeLink()
    ctx.link = link

    expect(await invoke(ipc, IPC.modeSet, 'turbo')).toEqual({ ok: false, status: 0 })
    expect(calls).toHaveLength(0)
    expect(ctx.mode).toBe('rule')
  })

  it('无内核链接时返回 ok:false', async () => {
    const { ipc } = await harness({ linkStatus: null })
    expect(await invoke(ipc, IPC.modeSet, 'global')).toEqual({ ok: false, status: 0 })
  })
})

describe('proxyEnable / proxyDisable', () => {
  it('开启使用主进程保存的 mixed-port，并持久化开关', async () => {
    const h = await harness({ proxyServer: '127.0.0.1:7891' })

    expect(await invoke(h.ipc, IPC.proxyEnable)).toEqual({ ok: true })
    expect(h.controller.enable).toHaveBeenCalledWith('127.0.0.1:7891')
    expect(h.ctx.proxyEnabled).toBe(true)
    expect(JSON.parse(await readFile(h.deps.settingsFile, 'utf8'))).toEqual({ proxyEnabled: true })
  })

  it('内核未运行时不写设置也不碰系统代理', async () => {
    const h = await harness({ proxyServer: null })

    const result = (await invoke(h.ipc, IPC.proxyEnable)) as { ok: boolean; message: string }
    expect(result.ok).toBe(false)
    expect(result.message).toBeTruthy()
    expect(h.controller.enable).not.toHaveBeenCalled()
    expect(existsSync(h.deps.settingsFile)).toBe(false)
    expect(h.ctx.proxyEnabled).toBe(false)
  })

  it('开启失败时返回消息且不持久化', async () => {
    const h = await harness()
    h.controller.enable.mockRejectedValueOnce(new Error('注册表拒绝'))

    const result = (await invoke(h.ipc, IPC.proxyEnable)) as { ok: boolean; message: string }
    expect(result.ok).toBe(false)
    expect(result.message).toBe('注册表拒绝')
    expect(h.ctx.proxyEnabled).toBe(false)
    expect(existsSync(h.deps.settingsFile)).toBe(false)
  })

  it('关闭时还原系统代理并持久化', async () => {
    const h = await harness()
    h.ctx.proxyEnabled = true

    expect(await invoke(h.ipc, IPC.proxyDisable)).toEqual({ ok: true })
    expect(h.controller.disable).toHaveBeenCalledTimes(1)
    expect(h.ctx.proxyEnabled).toBe(false)
    expect(JSON.parse(await readFile(h.deps.settingsFile, 'utf8'))).toEqual({ proxyEnabled: false })
  })

  it('关闭失败时如实返回错误', async () => {
    const h = await harness()
    h.ctx.proxyEnabled = true
    h.controller.disable.mockRejectedValueOnce(new Error('无法还原'))

    const result = (await invoke(h.ipc, IPC.proxyDisable)) as { ok: boolean; message: string }
    expect(result.ok).toBe(false)
    expect(result.message).toBe('无法还原')
  })
})

describe('coreRestart', () => {
  it('停止 → 启动 → 重写内核状态，顺序固定', async () => {
    const h = await harness()
    const order: string[] = []
    const fresh: CoreInfo = { ...CORE_INFO, pid: 5151, startedAt: 1_700_000_500_000 }
    h.supervisor.stop.mockImplementation(async () => { order.push('stop') })
    h.supervisor.start.mockImplementation(async () => { order.push('start'); return fresh })
    h.ctx.onCoreRestarted = async (info: CoreInfo) => {
      order.push('state')
      h.ctx.coreInfo = info
    }

    expect(await invoke(h.ipc, IPC.coreRestart)).toEqual({ ok: true })
    expect(order).toEqual(['stop', 'start', 'state'])
    expect(h.ctx.coreInfo).toEqual(fresh)
    expect(buildStatusView(h.ctx).status).toBe('ready')
  })

  it('启动失败时返回消息并把状态标为 core-error', async () => {
    const h = await harness()
    h.supervisor.start.mockRejectedValueOnce(new Error('内核握手超时'))

    const result = (await invoke(h.ipc, IPC.coreRestart)) as { ok: boolean; message: string }
    expect(result.ok).toBe(false)
    expect(result.message).toBeTruthy()
    expect(h.ctx.startupStatus).toBe('core-error')
    expect(h.ctx.coreInfo).toBeNull()
    expect(buildStatusView(h.ctx).status).toBe('core-error')
  })

  it('in-use 时直接拒绝，不碰内核', async () => {
    const h = await harness()
    h.ctx.startupStatus = 'in-use'

    const result = (await invoke(h.ipc, IPC.coreRestart)) as { ok: boolean; message: string }
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/另一个实例/)
    expect(h.supervisor.stop).not.toHaveBeenCalled()
  })
})

describe('connectionsGet', () => {
  it('返回采集器快照，序列化结果不含 secret 与 controller 端口', async () => {
    const socket = new FakeSocket()
    const connections = new ConnectionsCollector({
      url: 'ws://127.0.0.1:9090/connections?interval=500',
      secret: 'top-secret-token',
      connect: () => socket
    })
    const h = await harness({ connections })
    connections.start()
    socket.push(
      JSON.stringify({
        memory: 28_000,
        connections: [
          {
            id: 'abc',
            metadata: {
              host: 'example.com',
              process: 'curl.exe',
              network: 'tcp',
              destinationPort: '443'
            },
            upload: 1,
            download: 2,
            start: '2026-10-27T11:07:07.5185055+08:00',
            chains: ['DIRECT'],
            rule: 'Match',
            rulePayload: ''
          }
        ]
      })
    )

    const snapshot = (await invoke(h.ipc, IPC.connectionsGet)) as ConnectionsSnapshot
    expect(snapshot.memory).toBe(28_000)
    expect(snapshot.retainMs).toBe(60_000)
    expect(snapshot.items).toHaveLength(1)
    expect(snapshot.items[0]).toMatchObject({
      id: 'abc',
      host: 'example.com',
      process: 'curl.exe',
      chains: ['DIRECT']
    })
    const json = JSON.stringify(snapshot)
    expect(json).not.toContain('top-secret-token')
    expect(json).not.toContain('9090')
    expect(json).not.toMatch(/secret|authorization|Bearer/i)

    connections.stop()
  })

  it('无采集器时返回空快照，未知内存与保留窗口保持 null 而不是 0', async () => {
    const h = await harness()
    const snapshot = (await invoke(h.ipc, IPC.connectionsGet)) as ConnectionsSnapshot
    expect(snapshot.items).toEqual([])
    expect(snapshot.memory).toBeNull()
    expect(snapshot.retainMs).toBeNull()
    expect(typeof snapshot.at).toBe('number')
  })
})

describe('logsCountsGet', () => {
  it('返回 counts() 的惰性滚动结果：窗口到期后无需推送也能读到 0', async () => {
    const socket = new FakeSocket()
    let now = 1_000
    const logs = new LogsCollector({
      url: 'ws://127.0.0.1:9090/logs?level=warning',
      secret: 'top-secret-token',
      connect: () => socket,
      windowMs: 60_000,
      now: () => now
    })
    const h = await harness({ logs })
    logs.start()
    socket.push(
      JSON.stringify({
        type: 'warning',
        payload:
          '[TCP] dial Proxy (match Match/) 127.0.0.1:8608(curl.exe) --> example.com:80 error: refused'
      })
    )
    expect(await invoke(h.ipc, IPC.logsCountsGet)).toEqual({ recent: 1, windowMs: 60_000 })

    now += 60_000
    // 失败滚出窗口时没有推送；渲染层必须靠轮询这条通道拿到降下来的计数。
    expect(await invoke(h.ipc, IPC.logsCountsGet)).toEqual({ recent: 0, windowMs: 60_000 })

    logs.stop()
  })

  it('无采集器时返回 null：没有计数来源，不能伪造 0', async () => {
    const h = await harness()
    expect(await invoke(h.ipc, IPC.logsCountsGet)).toBeNull()
  })
})

describe('nodeSwitch', () => {
  it('成功时 PUT /proxies/<group> 并返回内核状态码', async () => {
    const h = await harness()
    const { link, calls } = fakeLink(204)
    h.ctx.link = link

    expect(await invoke(h.ipc, IPC.nodeSwitch, { group: 'Proxy', node: 'HK-01' })).toEqual({
      ok: true,
      status: 204
    })
    expect(calls[0]?.url).toBe('http://127.0.0.1:9090/proxies/Proxy')
    expect(calls[0]?.init?.method).toBe('PUT')
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ name: 'HK-01' })
  })

  it('组名做 URL 编码，避免把名字里的斜杠或查询串混进路径', async () => {
    const h = await harness()
    const { link, calls } = fakeLink(204)
    h.ctx.link = link

    await invoke(h.ipc, IPC.nodeSwitch, { group: '香港/01?x=1', node: 'HK-01' })
    expect(calls[0]?.url).toBe(
      `http://127.0.0.1:9090/proxies/${encodeURIComponent('香港/01?x=1')}`
    )
  })

  it.each([
    ['缺少入参', undefined],
    ['null', null],
    ['空对象', {}],
    ['缺少 node', { group: 'Proxy' }],
    ['缺少 group', { node: 'HK-01' }],
    ['group 为空串', { group: '', node: 'HK-01' }],
    ['node 为空串', { group: 'Proxy', node: '' }],
    ['group 只有空白', { group: '   ', node: 'HK-01' }],
    ['group 不是字符串', { group: 1, node: 'HK-01' }],
    ['group 是单个点（URL 规范化会折叠成根路径）', { group: '.', node: 'HK-01' }],
    ['group 是双点', { group: '..', node: 'HK-01' }],
    ['group 超过长度上限', { group: 'a'.repeat(257), node: 'HK-01' }],
    ['node 超过长度上限', { group: 'Proxy', node: 'n'.repeat(257) }],
    ['入参本身是字符串', 'Proxy']
  ])('非法入参（%s）返回 ok:false 而不是抛错，且不触碰内核', async (_label, arg) => {
    const h = await harness()
    const { link, calls } = fakeLink(204)
    h.ctx.link = link

    await expect(invoke(h.ipc, IPC.nodeSwitch, arg)).resolves.toEqual({ ok: false, status: 0 })
    expect(calls).toHaveLength(0)
  })

  it('没有存活内核时返回 {ok:false,status:0}，不抛错', async () => {
    const h = await harness({ linkStatus: null })
    expect(await invoke(h.ipc, IPC.nodeSwitch, { group: 'Proxy', node: 'HK-01' })).toEqual({
      ok: false,
      status: 0
    })
  })

  it('传输错误映射为 status 0，不向渲染层抛出', async () => {
    const h = await harness()
    const fn = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    h.ctx.link = new RealCoreLink('http://127.0.0.1:9090', 'secret', fn)

    await expect(
      invoke(h.ipc, IPC.nodeSwitch, { group: 'Proxy', node: 'HK-01' })
    ).resolves.toEqual({ ok: false, status: 0 })
  })
})

describe('configOpenDir', () => {
  it('只打开主进程的配置目录，忽略渲染层传入的任意路径', async () => {
    const openPath = vi.fn(async (_target: string) => '')
    const h = await harness({ openPath })

    expect(
      await invoke(h.ipc, IPC.configOpenDir, 'C:/Windows/System32', '../outside')
    ).toEqual({ ok: true })
    expect(openPath).toHaveBeenCalledTimes(1)
    expect(openPath).toHaveBeenCalledWith(h.ctx.configDir)
    expect(openPath).not.toHaveBeenCalledWith('C:/Windows/System32')
  })

  it('shell.openPath 返回非空错误串时返回可读消息，不回显路径', async () => {
    const h = await harness({ openPath: async () => '拒绝访问：C:/secret/config' })
    const result = (await invoke(h.ipc, IPC.configOpenDir)) as { ok: boolean; message: string }
    expect(result.ok).toBe(false)
    expect(result.message).toBeTruthy()
    expect(result.message).not.toContain('C:/secret')
  })

  it('打开目录抛错时返回 ok:false，不向渲染层抛异常', async () => {
    const h = await harness({
      openPath: async () => {
        throw new Error('资源管理器不可用')
      }
    })
    const result = (await invoke(h.ipc, IPC.configOpenDir)) as { ok: boolean; message: string }
    expect(result.ok).toBe(false)
    expect(result.message).toBeTruthy()
  })

  it('没有注入打开目录能力时返回 ok:false', async () => {
    const h = await harness()
    const result = (await invoke(h.ipc, IPC.configOpenDir)) as { ok: boolean; message: string }
    expect(result.ok).toBe(false)
    expect(result.message).toBeTruthy()
  })
})

describe('registerUnavailableHandlers', () => {
  it('装配失败时每个通道都有 handler，且不泄漏细节', async () => {
    const ipc = fakeIpc()
    registerUnavailableHandlers(ipc)

    const expected = [
      IPC.statusGet,
      IPC.proxiesGet,
      IPC.modeSet,
      IPC.proxyEnable,
      IPC.proxyDisable,
      IPC.coreRestart,
      IPC.configImport,
      IPC.configPickImport,
      IPC.connectionsGet,
      IPC.connectionsPush,
      IPC.logsCountsGet,
      IPC.logsCountsPush,
      IPC.nodeSwitch,
      IPC.configOpenDir,
      IPC.windowControl
    ]
    expect([...ipc.handlers.keys()].sort()).toEqual([...expected].sort())

    const status = (await invoke(ipc, IPC.statusGet)) as { status: string }
    expect(status.status).toBe('core-error')
    expect(await invoke(ipc, IPC.proxiesGet)).toEqual([])
    expect(await invoke(ipc, IPC.modeSet, 'global')).toEqual({ ok: false, status: 0 })
    expect(await invoke(ipc, IPC.connectionsGet)).toMatchObject({ items: [], memory: null })
    expect(await invoke(ipc, IPC.logsCountsGet)).toBeNull()
    expect(await invoke(ipc, IPC.nodeSwitch, { group: 'P', node: 'N' })).toEqual({
      ok: false,
      status: 0
    })
    for (const channel of [
      IPC.proxyEnable,
      IPC.proxyDisable,
      IPC.coreRestart,
      IPC.configImport,
      IPC.configPickImport,
      IPC.configOpenDir,
      IPC.windowControl
    ]) {
      const result = (await invoke(ipc, channel, { sourcePath: 'x' })) as {
        ok: boolean
        message: string
      }
      expect(result.ok).toBe(false)
      expect(result.message).not.toMatch(/[A-Za-z]:\\|secret|token/i)
    }
    // 推送通道在主进程单向发送；不可用装配下也必须存在，误调用不会得到 "No handler"。
    expect(await invoke(ipc, IPC.connectionsPush)).toBeUndefined()
    expect(await invoke(ipc, IPC.logsCountsPush)).toBeUndefined()
  })
})

describe('configImport', () => {
  it('导入合法配置后写 upstream.yaml 并提示需要重启', async () => {
    const h = await harness()
    const source = path.join(h.dir, 'source.yaml')
    await writeFile(source, 'proxies: []\nproxy-groups:\n  - { name: P, type: select, proxies: [DIRECT] }\n')

    expect(await invoke(h.ipc, IPC.configImport, { sourcePath: source })).toEqual({
      ok: true,
      needsRestart: true
    })
    const written = await readFile(path.join(h.ctx.configDir, 'upstream.yaml'), 'utf8')
    expect(written).toContain('proxy-groups')
  })

  it('无配置目录时先创建目录再导入', async () => {
    const h = await harness()
    h.ctx.profileDir = null
    await mkdir(path.join(h.dir, 'empty'), { recursive: true })
    const source = path.join(h.dir, 'source.yaml')
    await writeFile(source, 'proxies: []\n')

    expect(await invoke(h.ipc, IPC.configImport, { sourcePath: source })).toEqual({
      ok: true,
      needsRestart: true
    })
    expect(existsSync(path.join(h.ctx.configDir, 'upstream.yaml'))).toBe(true)
  })

  it('非法配置返回 ok:false 且不覆盖现有配置', async () => {
    const h = await harness()
    const source = path.join(h.dir, 'bad.yaml')
    await writeFile(source, 'not: a clash config\n')

    const result = (await invoke(h.ipc, IPC.configImport, { sourcePath: source })) as {
      ok: boolean
      message: string
    }
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/不是合法的 Clash 配置/)
    expect(existsSync(path.join(h.ctx.configDir, 'upstream.yaml'))).toBe(false)
  })

  it('in-use 时拒绝导入，不碰现有 upstream.yaml', async () => {
    const h = await harness()
    h.ctx.startupStatus = 'in-use'
    const source = path.join(h.dir, 'source.yaml')
    await writeFile(source, 'proxies: []\nproxy-groups:\n  - { name: P, type: select, proxies: [DIRECT] }\n')

    const result = (await invoke(h.ipc, IPC.configImport, { sourcePath: source })) as {
      ok: boolean
      message: string
    }
    expect(result.ok).toBe(false)
    expect(result.message).toBe('另一个实例正在运行')
    expect(existsSync(path.join(h.ctx.configDir, 'upstream.yaml'))).toBe(false)
  })

  it('缺少路径参数时返回 ok:false', async () => {
    const h = await harness()
    const result = (await invoke(h.ipc, IPC.configImport, {})) as { ok: boolean; message: string }
    expect(result.ok).toBe(false)
    expect(result.message).toBeTruthy()
  })
})

describe('configPickImport', () => {
  const GOOD_CONFIG = 'proxies: []\nproxy-groups:\n  - { name: P, type: select, proxies: [DIRECT] }\n'

  it('选中合法配置后写 upstream.yaml，并提示需要重启', async () => {
    const source = path.join(tmpdir(), `aether-pick-${Date.now()}.yaml`)
    await writeFile(source, GOOD_CONFIG)
    const h = await harness({ pickImportFile: async () => source })

    expect(await invoke(h.ipc, IPC.configPickImport)).toEqual({ ok: true, needsRestart: true })
    const written = await readFile(path.join(h.ctx.configDir, 'upstream.yaml'), 'utf8')
    expect(written).toContain('proxy-groups')
  })

  it('取消对话框时返回 cancelled，且不写任何文件', async () => {
    const pickImportFile = vi.fn(async () => null)
    const h = await harness({ pickImportFile })

    expect(await invoke(h.ipc, IPC.configPickImport)).toEqual({ ok: false, cancelled: true })
    expect(pickImportFile).toHaveBeenCalledTimes(1)
    expect(existsSync(path.join(h.ctx.configDir, 'upstream.yaml'))).toBe(false)
  })

  it('in-use 时先拒绝，根本不弹对话框', async () => {
    const pickImportFile = vi.fn(async () => path.join(tmpdir(), 'never.yaml'))
    const h = await harness({ pickImportFile })
    h.ctx.startupStatus = 'in-use'

    const result = (await invoke(h.ipc, IPC.configPickImport)) as { ok: boolean; message: string }
    expect(result.ok).toBe(false)
    expect(result.message).toBe('另一个实例正在运行')
    expect(pickImportFile).not.toHaveBeenCalled()
    expect(existsSync(path.join(h.ctx.configDir, 'upstream.yaml'))).toBe(false)
  })

  it('选中的不是合法 Clash 配置时返回消息且不覆盖现有配置', async () => {
    const source = path.join(tmpdir(), `aether-pick-bad-${Date.now()}.yaml`)
    await writeFile(source, 'not: a clash config\n')
    const h = await harness({ pickImportFile: async () => source })

    const result = (await invoke(h.ipc, IPC.configPickImport)) as { ok: boolean; message: string }
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/不是合法的 Clash 配置/)
    expect(existsSync(path.join(h.ctx.configDir, 'upstream.yaml'))).toBe(false)
  })

  it('对话框自身抛错时转成可读消息，不向渲染层抛异常', async () => {
    const h = await harness({
      pickImportFile: async () => {
        throw new Error('对话框不可用')
      }
    })

    expect(await invoke(h.ipc, IPC.configPickImport)).toEqual({ ok: false, message: '对话框不可用' })
  })

  it('没有注入选择框时不崩溃，返回明确消息', async () => {
    const h = await harness()
    const result = (await invoke(h.ipc, IPC.configPickImport)) as { ok: boolean; message: string }
    expect(result.ok).toBe(false)
    expect(result.message).toBe('无法打开文件选择框')
  })
})

describe('windowControl', () => {
  function controls() {
    return { minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() }
  }

  it('三个动作分别转发到对应控制，且都回 ok:true', async () => {
    const wc = controls()
    const h = await harness({ windowControls: wc })

    expect(await invoke(h.ipc, IPC.windowControl, 'minimize')).toEqual({ ok: true })
    expect(await invoke(h.ipc, IPC.windowControl, 'maximize')).toEqual({ ok: true })
    expect(await invoke(h.ipc, IPC.windowControl, 'close')).toEqual({ ok: true })
    expect(wc.minimize).toHaveBeenCalledTimes(1)
    expect(wc.toggleMaximize).toHaveBeenCalledTimes(1)
    // close 只关窗口；通道层没有任何「退出应用」的能力，退出只走托盘/before-quit。
    expect(wc.close).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['未知动作', 'quit'],
    ['路径', 'C:/Windows/System32'],
    ['对象', { action: 'close' }],
    ['空串', ''],
    ['数字', 1],
    ['null', null]
  ])('拒绝未知输入（%s），不触碰窗口', async (_label, value) => {
    const wc = controls()
    const h = await harness({ windowControls: wc })

    expect(await invoke(h.ipc, IPC.windowControl, value)).toEqual({ ok: false })
    expect(wc.minimize).not.toHaveBeenCalled()
    expect(wc.toggleMaximize).not.toHaveBeenCalled()
    expect(wc.close).not.toHaveBeenCalled()
  })

  it('渲染层多传的参数不会到达窗口控制', async () => {
    const wc = controls()
    const h = await harness({ windowControls: wc })

    await invoke(h.ipc, IPC.windowControl, 'close', 'C:/Windows/System32', { x: 0, y: 0 })

    // 窗口控制的接口只有零参方法：多余参数无处可去。
    expect(wc.close).toHaveBeenCalledTimes(1)
    expect(wc.close.mock.calls[0]).toEqual([])
  })

  it('没有窗口管理器时返回 ok:false，而不是抛错', async () => {
    const h = await harness()
    const result = (await invoke(h.ipc, IPC.windowControl, 'close')) as {
      ok: boolean
      message: string
    }
    expect(result.ok).toBe(false)
    expect(result.message).toBeTruthy()
  })
})
