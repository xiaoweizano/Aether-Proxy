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
  onStats(cb: (sample: unknown) => void): () => void
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
      'getProxies',
      'getStatus',
      'importConfig',
      'onStats',
      'restartCore',
      'setMode'
    ])
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

    expect(invoke.mock.calls).toEqual([
      [IPC.statusGet],
      [IPC.proxiesGet],
      [IPC.modeSet, 'global'],
      [IPC.proxyEnable],
      [IPC.proxyDisable],
      [IPC.coreRestart],
      [IPC.configPickImport]
    ])
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
