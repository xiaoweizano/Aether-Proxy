import { describe, it, expect, vi } from 'vitest'
import { CoreRestarter } from './restarter'

describe('CoreRestarter', () => {
  it('首次退出按 1s 调度重启', async () => {
    const schedule = vi.fn()
    const r = new CoreRestarter({ start: vi.fn(async () => ({})), schedule, now: () => 1000 })
    expect(r.notifyExit()).toEqual({ scheduled: true, delayMs: 1000 })
    expect(schedule).toHaveBeenCalledOnce()
  })

  it('10 分钟内第 4 次退出不再调度', () => {
    let now = 0
    const schedule = vi.fn()
    const onGiveUp = vi.fn()
    const r = new CoreRestarter({ start: vi.fn(async () => ({})), schedule, now: () => now, onGiveUp })
    now = 1000; expect(r.notifyExit().scheduled).toBe(true)
    now = 2000; expect(r.notifyExit().scheduled).toBe(true)
    now = 3000; expect(r.notifyExit().scheduled).toBe(true)
    now = 4000; expect(r.notifyExit()).toEqual({ scheduled: false })
    expect(schedule).toHaveBeenCalledTimes(3)
    expect(onGiveUp).toHaveBeenCalledOnce()
  })

  it('重启失败不产生未处理拒绝，并回调 onStartError', async () => {
    const onStartError = vi.fn()
    let scheduled: (() => void) | null = null
    const r = new CoreRestarter({
      start: vi.fn(async () => { throw new Error('boom') }),
      now: () => 0,
      schedule: (fn) => { scheduled = fn },
      onStartError
    })
    r.notifyExit()
    scheduled!()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(onStartError).toHaveBeenCalledOnce()
  })

  it('cancel 后已调度的重启不再调用 start', async () => {
    let scheduled: (() => void) | null = null
    const start = vi.fn(async () => ({}))
    const r = new CoreRestarter({
      start,
      now: () => 0,
      schedule: (fn) => { scheduled = fn }
    })
    expect(r.notifyExit().scheduled).toBe(true)
    r.cancel()
    scheduled!()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(start).not.toHaveBeenCalled()
  })
})
