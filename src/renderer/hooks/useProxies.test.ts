import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProxyGroupView } from '../../shared/ipc'
import { makeAether } from '../test-utils'
import { useProxies } from './useProxies'

const GROUPS: ProxyGroupView[] = [
  { name: 'Proxy', type: 'select', now: 'HK-01', nodes: [{ name: 'HK-01', delay: 38 }] }
]

describe('useProxies', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('挂载后立即拉取策略组', async () => {
    const getProxies = vi.fn(async () => GROUPS)
    window.aether = makeAether({ getProxies })

    const { result } = renderHook(() => useProxies())
    await act(async () => {
      await Promise.resolve()
    })

    expect(getProxies).toHaveBeenCalledTimes(1)
    expect(result.current.groups).toEqual(GROUPS)
    expect(result.current.error).toBeNull()
  })

  it('每 3 秒轮询一次', async () => {
    const getProxies = vi.fn(async () => GROUPS)
    window.aether = makeAether({ getProxies })

    renderHook(() => useProxies())
    await act(async () => {
      await Promise.resolve()
      vi.advanceTimersByTime(3000)
      await Promise.resolve()
    })

    expect(getProxies).toHaveBeenCalledTimes(2)
  })

  it('卸载后停止轮询', async () => {
    const getProxies = vi.fn(async () => GROUPS)
    window.aether = makeAether({ getProxies })

    const { unmount } = renderHook(() => useProxies())
    await act(async () => {
      await Promise.resolve()
    })
    unmount()

    await act(async () => {
      vi.advanceTimersByTime(9000)
    })

    expect(getProxies).toHaveBeenCalledTimes(1)
  })

  it('拉取失败不抛错，保留上一份数据并记录 error', async () => {
    const getProxies = vi
      .fn<() => Promise<ProxyGroupView[]>>()
      .mockResolvedValueOnce(GROUPS)
      .mockRejectedValueOnce(new Error('内核不可达'))
    window.aether = makeAether({ getProxies })

    const { result } = renderHook(() => useProxies())
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.groups).toEqual(GROUPS)

    await act(async () => {
      vi.advanceTimersByTime(3000)
      await Promise.resolve()
    })

    expect(result.current.groups).toEqual(GROUPS)
    expect(result.current.error).toBe('内核不可达')
  })

  it('window.aether 缺失时返回空列表且不抛错', () => {
    const { result } = renderHook(() => useProxies())
    expect(result.current.groups).toEqual([])
    expect(result.current.error).toBeNull()
  })
})
