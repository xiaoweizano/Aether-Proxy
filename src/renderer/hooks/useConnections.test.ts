import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ConnectionsSnapshot } from '../../shared/ipc'
import { makeAether, makeConnection } from '../test-utils'
import { summarizeConnections, useConnections } from './useConnections'

function snapshot(overrides: Partial<ConnectionsSnapshot> = {}): ConnectionsSnapshot {
  return { items: [makeConnection()], memory: 1024, retainMs: 60_000, at: 1_000, ...overrides }
}

describe('useConnections', () => {
  it('挂载后立即拉取首屏快照', async () => {
    const initial = snapshot()
    const getConnections = vi.fn(async () => initial)
    window.aether = makeAether({ getConnections })

    const { result } = renderHook(() => useConnections())
    await act(async () => {
      await Promise.resolve()
    })

    expect(getConnections).toHaveBeenCalledTimes(1)
    expect(result.current.items).toEqual(initial.items)
    expect(result.current.memory).toBe(1024)
    expect(result.current.retainMs).toBe(60_000)
    expect(result.current.at).toBe(1_000)
  })

  it('订阅推送并替换快照', async () => {
    let push: ((next: ConnectionsSnapshot) => void) | undefined
    const onConnections = vi.fn((cb: (next: ConnectionsSnapshot) => void) => {
      push = cb
      return () => {}
    })
    window.aether = makeAether({
      getConnections: vi.fn(async () => snapshot({ items: [], at: 500 })),
      onConnections
    })

    const { result } = renderHook(() => useConnections())
    await act(async () => {
      await Promise.resolve()
    })

    const next = snapshot({ items: [makeConnection({ id: 'pushed' })], at: 2_000 })
    act(() => {
      push?.(next)
    })

    expect(result.current.items).toEqual(next.items)
    expect(result.current.at).toBe(2_000)
  })

  it('更旧的首屏不会覆盖已收到的新推送', async () => {
    let push: ((next: ConnectionsSnapshot) => void) | undefined
    let resolveInitial: ((next: ConnectionsSnapshot) => void) | undefined
    const getConnections = vi.fn(
      () =>
        new Promise<ConnectionsSnapshot>((resolve) => {
          resolveInitial = resolve
        })
    )
    window.aether = makeAether({
      getConnections,
      onConnections: (cb) => {
        push = cb
        return () => {}
      }
    })

    const { result } = renderHook(() => useConnections())

    const pushed = snapshot({ items: [makeConnection({ id: 'pushed' })], at: 2_000 })
    act(() => {
      push?.(pushed)
    })
    await act(async () => {
      resolveInitial?.(snapshot({ items: [makeConnection({ id: 'stale' })], at: 1_000 }))
      await Promise.resolve()
    })

    expect(result.current.items).toEqual(pushed.items)
  })

  it('系统时钟回拨后，时间戳更小的新推送仍然生效', async () => {
    let push: ((next: ConnectionsSnapshot) => void) | undefined
    window.aether = makeAether({
      getConnections: vi.fn(async () => snapshot({ items: [], at: 5_000 })),
      onConnections: (cb) => {
        push = cb
        return () => {}
      }
    })

    const { result } = renderHook(() => useConnections())
    await act(async () => {
      await Promise.resolve()
    })

    act(() => {
      push?.(snapshot({ items: [makeConnection({ id: 'newer' })], at: 9_000 }))
    })
    act(() => {
      // NTP 把时钟拨回去：at 变小，但这条推送仍是最新事实。
      push?.(snapshot({ items: [makeConnection({ id: 'after-clock-step' })], at: 1_000 }))
    })

    expect(result.current.items).toEqual([makeConnection({ id: 'after-clock-step' })])
    expect(result.current.at).toBe(1_000)
  })

  it('卸载时取消订阅', async () => {
    const off = vi.fn()
    window.aether = makeAether({ onConnections: vi.fn(() => off) })

    const { unmount } = renderHook(() => useConnections())
    await act(async () => {
      await Promise.resolve()
    })
    unmount()

    expect(off).toHaveBeenCalledTimes(1)
  })

  it('window.aether 缺失时返回空快照且不抛错', () => {
    const { result } = renderHook(() => useConnections())

    expect(result.current).toEqual({ items: [], memory: null, retainMs: null, at: null })
  })

  it('memory 缺失保持 null，不填 0', async () => {
    window.aether = makeAether({
      getConnections: vi.fn(async () => snapshot({ memory: null }))
    })

    const { result } = renderHook(() => useConnections())
    await act(async () => {
      await Promise.resolve()
    })

    expect(result.current.memory).toBeNull()
  })
})

describe('summarizeConnections', () => {
  it('活跃数只数 ended === false 的行，保留期内的已结束行不进计数', () => {
    const state = {
      items: [
        makeConnection({ id: 'a' }),
        makeConnection({ id: 'b' }),
        makeConnection({ id: 'c', ended: true, endedAt: 2_000 })
      ],
      memory: 24_944_640,
      retainMs: 60_000,
      at: 3_000
    }

    expect(summarizeConnections(state)).toEqual({
      active: 2,
      total: 3,
      memory: 24_944_640,
      retainMs: 60_000
    })
  })

  it('没有采集器（retainMs 为 null）时连接数是未知，不是 0', () => {
    const state = { items: [], memory: null, retainMs: null, at: 1_000 }

    expect(summarizeConnections(state)).toEqual({
      active: null,
      total: null,
      memory: null,
      retainMs: null
    })
  })

  it('采集器在线且零条连接时，零是测得的零', () => {
    const summary = summarizeConnections({ items: [], memory: 0, retainMs: 60_000, at: 1_000 })

    expect(summary.active).toBe(0)
    expect(summary.total).toBe(0)
    expect(summary.memory).toBe(0)
  })
})
