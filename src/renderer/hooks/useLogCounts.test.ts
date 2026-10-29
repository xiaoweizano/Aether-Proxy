import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DialFailureCounts } from '../../shared/ipc'
import { makeAether } from '../test-utils'
import { LOG_COUNTS_POLL_MS, useLogCounts } from './useLogCounts'

function counts(recent: number, windowMs = 60 * 60_000): DialFailureCounts {
  return { recent, windowMs }
}

interface Harness {
  push(next: unknown): void
  off: ReturnType<typeof vi.fn>
  getLogCounts: ReturnType<typeof vi.fn>
}

/** 订阅回调与轮询通道都由用例控制；默认首屏给 null（没有采集器）。 */
function harness(options: {
  initial?: DialFailureCounts | null
  getLogCounts?: () => Promise<DialFailureCounts | null>
} = {}): Harness {
  let push: ((next: DialFailureCounts) => void) | null = null
  const off = vi.fn()
  const getLogCounts = vi.fn<() => Promise<DialFailureCounts | null>>(
    options.getLogCounts ?? (async () => options.initial ?? null)
  )
  const onLogCounts = vi.fn((cb: (next: DialFailureCounts) => void) => {
    push = cb
    return off
  })
  window.aether = makeAether({ getLogCounts, onLogCounts })
  return {
    push: (next) => push?.(next as DialFailureCounts),
    off,
    getLogCounts
  }
}

/** 让挂载时发出的首屏请求与随后的 setState 都落地。 */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

describe('useLogCounts', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('挂载后先拉一次，采集器不存在时保持 null（未知，不是 0）', async () => {
    const h = harness()
    const { result } = renderHook(() => useLogCounts())

    expect(h.getLogCounts).toHaveBeenCalledTimes(1)
    await flush()

    expect(result.current).toBeNull()
  })

  it('首屏拿到计数时立即显示', async () => {
    harness({ initial: counts(2, 30 * 60_000) })
    const { result } = renderHook(() => useLogCounts())

    await flush()

    expect(result.current).toEqual({ recent: 2, windowMs: 30 * 60_000 })
  })

  it('推送到达时更新计数，窗口长度一并跟随', async () => {
    const h = harness()
    const { result } = renderHook(() => useLogCounts())
    await flush()

    act(() => {
      h.push(counts(3, 90 * 60_000))
    })

    expect(result.current).toEqual({ recent: 3, windowMs: 90 * 60_000 })
  })

  it('按 LOG_COUNTS_POLL_MS 轮询：到期归零没有推送，只能靠轮询发现', async () => {
    const getLogCounts = vi
      .fn<() => Promise<DialFailureCounts | null>>()
      .mockResolvedValueOnce(counts(3))
      .mockResolvedValueOnce(counts(0))
    harness({ getLogCounts })
    const { result } = renderHook(() => useLogCounts())
    await flush()
    expect(result.current).toEqual({ recent: 3, windowMs: 60 * 60_000 })

    await act(async () => {
      vi.advanceTimersByTime(LOG_COUNTS_POLL_MS)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(getLogCounts).toHaveBeenCalledTimes(2)
    expect(result.current).toEqual({ recent: 0, windowMs: 60 * 60_000 })
  })

  it('轮询间隔不超过 5 秒', () => {
    expect(LOG_COUNTS_POLL_MS).toBeLessThanOrEqual(5000)
  })

  it('轮询结果比推送旧时被丢弃，计数不会倒退', async () => {
    let resolveFirst: (value: DialFailureCounts | null) => void = () => {}
    const getLogCounts = vi.fn<() => Promise<DialFailureCounts | null>>(
      () =>
        new Promise<DialFailureCounts | null>((resolve) => {
          resolveFirst = resolve
        })
    )
    const h = harness({ getLogCounts })
    const { result } = renderHook(() => useLogCounts())
    await flush()

    // 推送先到 3 次；首屏请求是在此之前发出的，返回的 1 次已经过时。
    act(() => {
      h.push(counts(3))
    })
    expect(result.current).toEqual({ recent: 3, windowMs: 60 * 60_000 })

    await act(async () => {
      resolveFirst(counts(1))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(result.current).toEqual({ recent: 3, windowMs: 60 * 60_000 })
  })

  it('畸形载荷整条丢弃，不会把 NaN 带出去', async () => {
    const h = harness()
    const { result } = renderHook(() => useLogCounts())
    await flush()

    const malformed: unknown[] = [
      { recent: Number.NaN, windowMs: 60 * 60_000 },
      { recent: -1, windowMs: 60 * 60_000 },
      { recent: 2, windowMs: 0 },
      { recent: 2, windowMs: Number.NaN },
      { recent: '3', windowMs: 60 * 60_000 },
      { recent: 2.5, windowMs: 60 * 60_000 },
      { recent: 2 },
      undefined,
      'nonsense'
    ]

    act(() => {
      for (const value of malformed) h.push(value)
    })
    expect(result.current).toBeNull()

    act(() => {
      h.push(counts(1))
    })
    expect(result.current).toEqual({ recent: 1, windowMs: 60 * 60_000 })
  })

  it('轮询返回 null 时回到未知，不用 0 冒充', async () => {
    const getLogCounts = vi
      .fn<() => Promise<DialFailureCounts | null>>()
      .mockResolvedValueOnce(counts(4))
      .mockResolvedValueOnce(null)
    harness({ getLogCounts })
    const { result } = renderHook(() => useLogCounts())
    await flush()
    expect(result.current).toEqual({ recent: 4, windowMs: 60 * 60_000 })

    await act(async () => {
      vi.advanceTimersByTime(LOG_COUNTS_POLL_MS)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(result.current).toBeNull()
  })

  it('轮询失败时保留上一个已知值，不抛错', async () => {
    const getLogCounts = vi
      .fn<() => Promise<DialFailureCounts | null>>()
      .mockResolvedValueOnce(counts(2))
      .mockRejectedValueOnce(new Error('内核重启中'))
    harness({ getLogCounts })
    const { result } = renderHook(() => useLogCounts())
    await flush()

    await act(async () => {
      vi.advanceTimersByTime(LOG_COUNTS_POLL_MS)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(result.current).toEqual({ recent: 2, windowMs: 60 * 60_000 })
  })

  it('卸载后退订并停止轮询', async () => {
    const h = harness()
    const { unmount } = renderHook(() => useLogCounts())
    await flush()

    unmount()

    expect(h.off).toHaveBeenCalledTimes(1)
    const calls = h.getLogCounts.mock.calls.length
    await act(async () => {
      vi.advanceTimersByTime(LOG_COUNTS_POLL_MS * 3)
      await Promise.resolve()
    })
    expect(h.getLogCounts).toHaveBeenCalledTimes(calls)
  })

  it('window.aether 缺失时不抛错，保持未知', () => {
    const { result } = renderHook(() => useLogCounts())

    expect(result.current).toBeNull()
  })
})
