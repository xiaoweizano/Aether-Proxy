import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readyStatus, makeAether } from '../test-utils'
import { useStatus } from './useStatus'

describe('useStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('挂载后返回 getStatus 的结果', async () => {
    const getStatus = vi.fn(async () => readyStatus)
    window.aether = makeAether({ getStatus })

    const { result } = renderHook(() => useStatus())
    await act(async () => {
      await Promise.resolve()
    })

    expect(getStatus).toHaveBeenCalledTimes(1)
    expect(result.current.status).toEqual(readyStatus)
    expect(result.current.error).toBeNull()
  })

  it('卸载后清掉轮询定时器', async () => {
    const getStatus = vi.fn(async () => readyStatus)
    window.aether = makeAether({ getStatus })

    const { result, unmount } = renderHook(() => useStatus(1000))
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.status).toEqual(readyStatus)

    unmount()
    await act(async () => {
      vi.advanceTimersByTime(5000)
    })

    expect(getStatus).toHaveBeenCalledTimes(1)
  })

  it('按 intervalMs 轮询', async () => {
    const getStatus = vi.fn(async () => readyStatus)
    window.aether = makeAether({ getStatus })

    renderHook(() => useStatus(1000))
    await act(async () => {
      await Promise.resolve()
      vi.advanceTimersByTime(1000)
      await Promise.resolve()
    })

    expect(getStatus).toHaveBeenCalledTimes(2)
  })

  it('getStatus 失败时不抛错，error 记录原因', async () => {
    const getStatus = vi.fn(async () => {
      throw new Error('内核未就绪')
    })
    window.aether = makeAether({ getStatus })

    const { result } = renderHook(() => useStatus())
    await act(async () => {
      await Promise.resolve()
    })

    expect(result.current.status).toBeNull()
    expect(result.current.error).toBe('内核未就绪')
  })
})
