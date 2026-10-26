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
    const r = new CoreRestarter({ start: vi.fn(async () => ({})), schedule, now: () => now })
    now = 1000; expect(r.notifyExit().scheduled).toBe(true)
    now = 2000; expect(r.notifyExit().scheduled).toBe(true)
    now = 3000; expect(r.notifyExit().scheduled).toBe(true)
    now = 4000; expect(r.notifyExit()).toEqual({ scheduled: false })
    expect(schedule).toHaveBeenCalledTimes(3)
  })
})
