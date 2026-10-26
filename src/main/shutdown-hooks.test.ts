import { describe, it, expect, vi, afterEach } from 'vitest'
import { registerShutdownHooks } from './shutdown-hooks'

function fakeSource() {
  const handlers = new Map<string, Array<() => void>>()
  return {
    on(event: string, cb: () => void) {
      const list = handlers.get(event) ?? []
      list.push(cb)
      handlers.set(event, list)
    },
    emit(event: string) { for (const cb of handlers.get(event) ?? []) cb() }
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('registerShutdownHooks', () => {
  it('shutdown 与 before-quit 同时到达只执行一次清理', async () => {
    const source = fakeSource()
    const shutdown = vi.fn(async () => {})
    registerShutdownHooks(source, shutdown)
    source.emit('shutdown')
    source.emit('before-quit')
    await new Promise((r) => setTimeout(r, 0))
    expect(shutdown).toHaveBeenCalledTimes(1)
  })

  it('普通退出事件也能触发清理', async () => {
    const source = fakeSource()
    const shutdown = vi.fn(async () => {})
    registerShutdownHooks(source, shutdown)
    source.emit('before-quit')
    await new Promise((r) => setTimeout(r, 0))
    expect(shutdown).toHaveBeenCalledTimes(1)
  })

  it('订阅 shutdown、before-quit 与 session-end', async () => {
    const source = fakeSource()
    const shutdown = vi.fn(async () => {})
    registerShutdownHooks(source, shutdown)
    source.emit('session-end')
    await new Promise((r) => setTimeout(r, 0))
    expect(shutdown).toHaveBeenCalledTimes(1)
  })

  it('返回的 handle 在清理完成后才 resolve', async () => {
    const source = fakeSource()
    let finish: (() => void) | null = null
    const shutdown = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    const handle = registerShutdownHooks(source, shutdown)

    let settled = false
    const pending = handle().then(() => { settled = true })
    await new Promise((r) => setTimeout(r, 0))
    expect(settled).toBe(false)

    finish!()
    await pending
    expect(settled).toBe(true)
  })

  it('shutdown 抛错时记录日志且 handle 不拒绝', async () => {
    const source = fakeSource()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const shutdown = (() => { throw new Error('boom') }) as () => Promise<void>
    const handle = registerShutdownHooks(source, shutdown)

    await expect(handle()).resolves.toBeUndefined()
    expect(errorSpy).toHaveBeenCalledWith('[aether] shutdown failed', expect.any(Error))
  })
})
