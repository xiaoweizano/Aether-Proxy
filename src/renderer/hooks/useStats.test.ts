import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { StatsSample } from '../../shared/ipc'
import { makeAether } from '../test-utils'
import { useStats } from './useStats'

interface Subscriber {
  push: ((sample: StatsSample) => void) | null
  off: ReturnType<typeof vi.fn>
}

function subscribe(): Subscriber {
  const subscriber: Subscriber = { push: null, off: vi.fn() }
  window.aether = makeAether({
    onStats: (cb) => {
      subscriber.push = cb
      return subscriber.off
    }
  })
  return subscriber
}

function sample(
  up: number,
  down: number,
  history?: { up: number; down: number }[]
): StatsSample {
  return {
    up,
    down,
    upTotal: up * 10,
    downTotal: down * 10,
    ...(history === undefined ? {} : { history })
  }
}

describe('useStats', () => {
  it('挂载时订阅，卸载时取消订阅', () => {
    const subscriber = subscribe()
    const { unmount } = renderHook(() => useStats())

    expect(subscriber.push).not.toBeNull()
    expect(subscriber.off).not.toHaveBeenCalled()

    unmount()
    expect(subscriber.off).toHaveBeenCalledTimes(1)
  })

  it('没有推送时 current 为 null、history 为空', () => {
    subscribe()
    const { result } = renderHook(() => useStats())

    expect(result.current.current).toBeNull()
    expect(result.current.history).toEqual([])
  })

  it('用推送里的 history 作为起点，并追加后续样本', () => {
    const subscriber = subscribe()
    const { result } = renderHook(() => useStats())

    act(() => {
      subscriber.push?.(sample(10, 20, [{ up: 1, down: 2 }, { up: 10, down: 20 }]))
    })

    expect(result.current.history).toEqual([
      { up: 1, down: 2 },
      { up: 10, down: 20 }
    ])
    expect(result.current.current).toEqual({ up: 10, down: 20, upTotal: 100, downTotal: 200 })

    act(() => {
      subscriber.push?.(sample(30, 40))
    })

    expect(result.current.history).toEqual([
      { up: 1, down: 2 },
      { up: 10, down: 20 },
      { up: 30, down: 40 }
    ])
    expect(result.current.current).toEqual({ up: 30, down: 40, upTotal: 300, downTotal: 400 })
  })

  it('推送 history 已包含当前样本时不重复追加', () => {
    const subscriber = subscribe()
    const { result } = renderHook(() => useStats())

    act(() => {
      subscriber.push?.(sample(10, 20, [{ up: 1, down: 2 }, { up: 10, down: 20 }]))
    })

    expect(result.current.history).toHaveLength(2)
  })

  it('history 最多保留最近 60 个样本', () => {
    const subscriber = subscribe()
    const { result } = renderHook(() => useStats())

    const long = Array.from({ length: 65 }, (_, index) => ({ up: index, down: index }))
    act(() => {
      subscriber.push?.(sample(64, 64, long))
    })

    expect(result.current.history).toHaveLength(60)
    expect(result.current.history[0]).toEqual({ up: 5, down: 5 })
    expect(result.current.history.at(-1)).toEqual({ up: 64, down: 64 })
  })

  it('连续追加同样不会超过 60 个', () => {
    const subscriber = subscribe()
    const { result } = renderHook(() => useStats())

    act(() => {
      for (let index = 0; index < 70; index += 1) subscriber.push?.(sample(index, index))
    })

    expect(result.current.history).toHaveLength(60)
    expect(result.current.history.at(-1)).toEqual({ up: 69, down: 69 })
  })

  it('丢弃字段非法的样本，不把 NaN 带进历史', () => {
    const subscriber = subscribe()
    const { result } = renderHook(() => useStats())

    act(() => {
      subscriber.push?.(sample(Number.NaN, 20))
    })

    expect(result.current.current).toBeNull()
    expect(result.current.history).toEqual([])
  })

  it('连续两个相同的空闲样本不合并成一个点', () => {
    const subscriber = subscribe()
    const { result } = renderHook(() => useStats())

    act(() => {
      subscriber.push?.(sample(0, 0))
      subscriber.push?.(sample(0, 0))
    })

    expect(result.current.history).toEqual([
      { up: 0, down: 0 },
      { up: 0, down: 0 }
    ])
  })

  it('current 每次都取最新值，即使样本与上一条相同', () => {
    const subscriber = subscribe()
    const { result } = renderHook(() => useStats())

    act(() => {
      subscriber.push?.(sample(4, 8))
      subscriber.push?.({ up: 4, down: 8, upTotal: 999, downTotal: 1000 })
    })

    expect(result.current.current).toEqual({ up: 4, down: 8, upTotal: 999, downTotal: 1000 })
    expect(result.current.history).toHaveLength(2)
  })

  it('主进程补发的 history 与当前样本不一致时按新样本追加', () => {
    const subscriber = subscribe()
    const { result } = renderHook(() => useStats())

    act(() => {
      subscriber.push?.(sample(10, 20, [{ up: 1, down: 2 }]))
    })

    expect(result.current.history).toEqual([
      { up: 1, down: 2 },
      { up: 10, down: 20 }
    ])
  })

  it('window.aether 缺失时不抛错', () => {
    const { result } = renderHook(() => useStats())
    expect(result.current.current).toBeNull()
    expect(result.current.history).toEqual([])
  })
})

describe('useStats 首屏补拉', () => {
  it('窗口重建后先补拉 getStats，不必等下一帧推送', async () => {
    const getStats = vi.fn(async () => ({
      up: 10,
      down: 20,
      upTotal: 100,
      downTotal: 200,
      history: [
        { up: 1, down: 2 },
        { up: 10, down: 20 }
      ]
    }))
    window.aether = makeAether({ getStats, onStats: vi.fn(() => () => {}) })

    const { result } = renderHook(() => useStats())

    await waitFor(() => expect(result.current.current).toEqual({
      up: 10,
      down: 20,
      upTotal: 100,
      downTotal: 200
    }))
    // 快照自带完整 history：直接作为起点，不重复追加本样本。
    expect(result.current.history).toEqual([
      { up: 1, down: 2 },
      { up: 10, down: 20 }
    ])
  })

  it('推送已经到过就丢弃补拉结果（推送更新）', async () => {
    let resolveStats: ((value: StatsSample | null) => void) | null = null
    const getStats = vi.fn(
      () => new Promise<StatsSample | null>((resolve) => { resolveStats = resolve })
    )
    const subscriber = subscribe()
    window.aether = makeAether({
      getStats,
      onStats: (cb) => {
        subscriber.push = cb
        return subscriber.off
      }
    })
    const { result } = renderHook(() => useStats())

    act(() => {
      subscriber.push?.(sample(30, 40, [{ up: 30, down: 40 }]))
    })
    expect(result.current.current?.up).toBe(30)

    // 补拉晚到，带回的是更旧的数据：必须被丢弃。
    act(() => {
      resolveStats?.({ up: 1, down: 2, upTotal: 10, downTotal: 20, history: [{ up: 1, down: 2 }] })
    })
    await act(async () => { await Promise.resolve() })

    expect(result.current.current?.up).toBe(30)
    expect(result.current.history).toEqual([{ up: 30, down: 40 }])
  })

  it('没有采集器（getStats 为 null）时保持空状态，不编造零样本', async () => {
    window.aether = makeAether({
      getStats: vi.fn(async () => null),
      onStats: vi.fn(() => () => {})
    })
    const { result } = renderHook(() => useStats())
    await act(async () => { await Promise.resolve() })

    expect(result.current.current).toBeNull()
    expect(result.current.history).toEqual([])
  })

  it('补拉失败不影响后续推送', async () => {
    const subscriber = subscribe()
    window.aether = makeAether({
      getStats: vi.fn(async () => {
        throw new Error('窗口正在重建')
      }),
      onStats: (cb) => {
        subscriber.push = cb
        return subscriber.off
      }
    })
    const { result } = renderHook(() => useStats())
    await act(async () => { await Promise.resolve() })

    act(() => {
      subscriber.push?.(sample(5, 6))
    })
    expect(result.current.current?.up).toBe(5)
  })
})
