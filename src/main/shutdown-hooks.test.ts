import { describe, it, expect, vi } from 'vitest'
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
})
