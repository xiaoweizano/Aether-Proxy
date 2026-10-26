import { describe, it, expect } from 'vitest'
import { nextRestart, DEFAULT_POLICY } from './backoff'

describe('nextRestart', () => {
  it('按 1s / 2s / 4s 递增', () => {
    const now = 1_000_000
    expect(nextRestart([], now)?.delayMs).toBe(1000)
    expect(nextRestart([now - 1000], now)?.delayMs).toBe(2000)
    expect(nextRestart([now - 3000, now - 1000], now)?.delayMs).toBe(4000)
  })

  it('10 分钟内第 4 次返回 null', () => {
    const now = 1_000_000
    const attempts = [now - 9000, now - 6000, now - 3000]
    expect(nextRestart(attempts, now)).toBeNull()
  })

  it('窗口外的旧尝试不计入', () => {
    const now = 1_000_000
    const attempts = [now - DEFAULT_POLICY.windowMs - 1, now - 1000, now - 500]
    expect(nextRestart(attempts, now)?.delayMs).toBe(4000)
  })
})
