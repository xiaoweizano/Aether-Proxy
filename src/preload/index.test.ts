import { describe, it, expect, vi, beforeEach } from 'vitest'

// preload 只在 Electron 里运行；用最小替身记录 contextBridge 暴露了什么、
// ipcRenderer 收到哪些调用，从而钉住「白名单之外没有通道」。
const exposed = new Map<string, unknown>()
const listeners = new Map<string, ((event: unknown, ...args: unknown[]) => void)[]>()
const invoke = vi.fn(async (..._args: unknown[]) => ({}))

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, value: unknown) => {
      exposed.set(key, value)
    }
  },
  ipcRenderer: {
    invoke: (...args: unknown[]) => invoke(...args),
    on: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => {
      const list = listeners.get(channel) ?? []
      list.push(listener)
      listeners.set(channel, list)
    },
    removeListener: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => {
      const list = listeners.get(channel) ?? []
      listeners.set(
        channel,
        list.filter((item) => item !== listener)
      )
    }
  }
}))

const { IPC } = await import('../shared/ipc')
await import('./index')

interface Api {
  getStatus(): Promise<unknown>
  getProxies(): Promise<unknown>
  setMode(mode: string): Promise<unknown>
  enableProxy(): Promise<unknown>
  disableProxy(): Promise<unknown>
  restartCore(): Promise<unknown>
  importConfig(): Promise<unknown>
  getConnections(): Promise<unknown>
  getLogCounts(): Promise<unknown>
  switchNode(input: { group: string; node: string }): Promise<unknown>
  openConfigDir(): Promise<unknown>
  windowControl(action: 'minimize' | 'maximize' | 'close'): Promise<unknown>
  getStats(): Promise<unknown>
  getWindowState(): Promise<unknown>
  getAutostart(): Promise<unknown>
  setAutostart(enabled: boolean): Promise<unknown>
  onWindowState(cb: (state: { maximized: boolean }) => void): () => void
  onStats(cb: (sample: unknown) => void): () => void
  onConnections(cb: (snapshot: unknown) => void): () => void
  onLogCounts(cb: (counts: unknown) => void): () => void
}

function api(): Api {
  const value = exposed.get('aether')
  expect(value).toBeTruthy()
  return value as Api
}

beforeEach(() => {
  invoke.mockClear()
})

describe('preload', () => {
  it('只暴露 aether 一个全局对象，且方法集合固定', () => {
    expect([...exposed.keys()]).toEqual(['aether'])
    expect(Object.keys(api()).sort()).toEqual([
      'disableProxy',
      'enableProxy',
      'getAutostart',
      'getConnections',
      'getLogCounts',
      'getProxies',
      'getStats',
      'getStatus',
      'getWindowState',
      'importConfig',
      'onConnections',
      'onLogCounts',
      'onStats',
      'onWindowState',
      'openConfigDir',
      'restartCore',
      'setAutostart',
      'setMode',
      'switchNode',
      'windowControl'
    ])
  })

  it('windowControl 只转发动作名，不转发任何路径或坐标', async () => {
    const a = api() as unknown as { windowControl(...args: unknown[]): Promise<unknown> }
    await a.windowControl('minimize', 'C:/Windows/System32', { x: 0, y: 0 })

    expect(invoke.mock.calls).toEqual([[IPC.windowControl, 'minimize']])
  })

  it('自启状态可读，设置只转发布尔值', async () => {
    const a = api() as unknown as {
      getAutostart(): Promise<unknown>
      setAutostart(...args: unknown[]): Promise<unknown>
    }
    await a.getAutostart()
    await a.setAutostart(true)
    await a.setAutostart(false)
    // 非布尔值被收窄成 false，不会把任意真值当「开启」送进主进程。
    await a.setAutostart('yes')

    expect(invoke.mock.calls).toEqual([
      [IPC.autostartGet],
      [IPC.autostartSet, true],
      [IPC.autostartSet, false],
      [IPC.autostartSet, false]
    ])
  })

  it('窗口状态可以首屏补拉，也能订阅推送', () => {    const a = api()
    void a.getWindowState()
    expect(invoke.mock.calls).toEqual([[IPC.windowStateGet]])

    const seen: unknown[] = []
    const off = a.onWindowState((state) => seen.push(state))
    const handlers = listeners.get(IPC.windowStatePush) ?? []
    expect(handlers).toHaveLength(1)
    handlers[0]?.({}, { maximized: true })
    expect(seen).toEqual([{ maximized: true }])

    off()
    expect(listeners.get(IPC.windowStatePush)).toHaveLength(0)
  })

  it('每个方法转发到对应通道', async () => {
    const a = api()
    await a.getStatus()
    await a.getProxies()
    await a.setMode('global')
    await a.enableProxy()
    await a.disableProxy()
    await a.restartCore()
    await a.importConfig()
    await a.getConnections()
    await a.getStats()
    await a.getLogCounts()
    await a.switchNode({ group: 'Proxy', node: 'HK-01' })
    await a.openConfigDir()

    expect(invoke.mock.calls).toEqual([
      [IPC.statusGet],
      [IPC.proxiesGet],
      [IPC.modeSet, 'global'],
      [IPC.proxyEnable],
      [IPC.proxyDisable],
      [IPC.coreRestart],
      [IPC.configPickImport],
      [IPC.connectionsGet],
      [IPC.statsGet],
      [IPC.logsCountsGet],
      [IPC.nodeSwitch, { group: 'Proxy', node: 'HK-01' }],
      [IPC.configOpenDir]
    ])
  })

  it('switchNode 只转发 group 与 node，不把多余字段送进主进程', async () => {
    const a = api()
    const input = { group: 'Proxy', node: 'HK-01', evil: 'extra' } as {
      group: string
      node: string
    }
    await a.switchNode(input)

    expect(invoke.mock.calls).toEqual([[IPC.nodeSwitch, { group: 'Proxy', node: 'HK-01' }]])
  })

  it('openConfigDir 不接受渲染层传入的路径', async () => {
    const a = api() as unknown as { openConfigDir(...args: unknown[]): Promise<unknown> }
    await a.openConfigDir('C:/Windows/System32', '../outside')

    // 主进程只开自己的配置目录；渲染层的任何附加参数都不应被转发。
    expect(invoke.mock.calls).toEqual([[IPC.configOpenDir]])
  })

  it('onStats 订阅推送，取消后不再收到', () => {
    const a = api()
    const seen: unknown[] = []
    const off = a.onStats((sample) => seen.push(sample))

    const handlers = listeners.get(IPC.statsPush) ?? []
    expect(handlers).toHaveLength(1)
    handlers[0]?.({}, { up: 1, down: 2, upTotal: 3, downTotal: 4 })
    expect(seen).toEqual([{ up: 1, down: 2, upTotal: 3, downTotal: 4 }])

    off()
    expect(listeners.get(IPC.statsPush)).toHaveLength(0)
  })

  it('onConnections 订阅连接推送，取消后不再收到', () => {
    const a = api()
    const seen: unknown[] = []
    const off = a.onConnections((snapshot) => seen.push(snapshot))

    const handlers = listeners.get(IPC.connectionsPush) ?? []
    expect(handlers).toHaveLength(1)
    handlers[0]?.({}, { items: [], memory: null, retainMs: 60_000, at: 1 })
    expect(seen).toEqual([{ items: [], memory: null, retainMs: 60_000, at: 1 }])

    off()
    expect(listeners.get(IPC.connectionsPush)).toHaveLength(0)
  })

  it('onLogCounts 订阅计数推送，取消后不再收到', () => {
    const a = api()
    const seen: unknown[] = []
    const off = a.onLogCounts((counts) => seen.push(counts))

    const handlers = listeners.get(IPC.logsCountsPush) ?? []
    expect(handlers).toHaveLength(1)
    handlers[0]?.({}, { recent: 3, windowMs: 3_600_000 })
    expect(seen).toEqual([{ recent: 3, windowMs: 3_600_000 }])

    off()
    expect(listeners.get(IPC.logsCountsPush)).toHaveLength(0)
  })

  it('没有暴露任意 invoke / 通道透传能力', () => {
    const a = api() as unknown as Record<string, unknown>
    for (const key of Object.keys(a)) {
      expect(typeof a[key]).toBe('function')
    }
    expect(a.invoke).toBeUndefined()
    expect(a.send).toBeUndefined()
    expect(a.ipcRenderer).toBeUndefined()
  })
})
