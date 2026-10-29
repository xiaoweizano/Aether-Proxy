import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LogsSnapshot } from '../../shared/ipc'
import { makeAether } from '../test-utils'
import { LOGS_POLL_MS, useLogs } from './useLogs'

function entry(at: number, payload: string) {
  return { at, level: 'warning', payload }
}

function snapshot(revision: number, payloads: string[]): LogsSnapshot {
  return {
    entries: payloads.map((payload, index) => entry(1000 + index, payload)),
    revision
  }
}

function harness(getLogs: () => Promise<LogsSnapshot | null>) {
  const mock = vi.fn(getLogs)
  window.aether = makeAether({ getLogs: mock })
  return mock
}

/** 让挂载时发出的首屏请求与随后的 setState 都落地。 */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

describe('useLogs', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('采集器不存在时为 null：没有来源，不算「没有日志」', async () => {
    harness(async () => null)
    const { result } = renderHook(() => useLogs())

    await flush()

    expect(result.current.live).toBe(false)
    expect(result.current.entries).toEqual([])
    expect(result.current.error).toBeNull()
  })

  it('首屏拿到快照：条目与 revision 一起落地，标记为实时', async () => {
    harness(async () => snapshot(2, ['line-1', 'line-2']))
    const { result } = renderHook(() => useLogs())

    await flush()

    expect(result.current.live).toBe(true)
    expect(result.current.revision).toBe(2)
    expect(result.current.entries.map((item) => item.payload)).toEqual(['line-1', 'line-2'])
  })

  it('revision 不变时保留原数组引用：没有新日志就不触发重渲染', async () => {
    harness(async () => snapshot(1, ['line-1']))
    const { result } = renderHook(() => useLogs())
    await flush()

    const first = result.current.entries
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOGS_POLL_MS)
    })

    expect(result.current.entries).toBe(first)
  })

  it('按 LOGS_POLL_MS 轮询，新日志会进来', async () => {
    const getLogs = vi
      .fn<() => Promise<LogsSnapshot | null>>()
      .mockResolvedValueOnce(snapshot(1, ['line-1']))
      .mockResolvedValueOnce(snapshot(2, ['line-1', 'line-2']))
    harness(getLogs)
    const { result } = renderHook(() => useLogs())
    await flush()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOGS_POLL_MS)
    })

    expect(result.current.entries.map((item) => item.payload)).toEqual(['line-1', 'line-2'])
    expect(result.current.revision).toBe(2)
  })

  it('内核停止后保留尾巴，只把 live 翻成 false', async () => {
    const getLogs = vi
      .fn<() => Promise<LogsSnapshot | null>>()
      .mockResolvedValueOnce(snapshot(1, ['line-1']))
      .mockResolvedValueOnce(null)
    harness(getLogs)
    const { result } = renderHook(() => useLogs())
    await flush()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOGS_POLL_MS)
    })

    // 崩溃时最需要日志：尾巴必须留着。
    expect(result.current.entries.map((item) => item.payload)).toEqual(['line-1'])
    expect(result.current.live).toBe(false)
  })

  it('通道读取失败：记录错误、保留条目，且不假装还在实时', async () => {
    const getLogs = vi
      .fn<() => Promise<LogsSnapshot | null>>()
      .mockResolvedValueOnce(snapshot(1, ['line-1']))
      .mockRejectedValueOnce(new Error('IPC 断了'))
    harness(getLogs)
    const { result } = renderHook(() => useLogs())
    await flush()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOGS_POLL_MS)
    })

    expect(result.current.error).toBe('IPC 断了')
    expect(result.current.live).toBe(false)
    expect(result.current.entries).toHaveLength(1)
  })

  it('卸载后停止轮询', async () => {
    const getLogs = harness(async () => snapshot(1, ['line-1']))
    const { unmount } = renderHook(() => useLogs())
    await flush()
    expect(getLogs).toHaveBeenCalledTimes(1)

    unmount()
    await vi.advanceTimersByTimeAsync(LOGS_POLL_MS * 3)

    expect(getLogs).toHaveBeenCalledTimes(1)
  })
})
