import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { WindowStateView } from '../../shared/ipc'
import { makeAether } from '../test-utils'
import { useWindowMaximized } from './useWindowMaximized'

function subscribe() {
  let push: ((state: WindowStateView) => void) | null = null
  const off = vi.fn()
  window.aether = makeAether({
    onWindowState: (cb) => {
      push = cb
      return off
    }
  })
  return {
    emit: (maximized: boolean) => {
      act(() => {
        push?.({ maximized })
      })
    },
    off
  }
}

describe('useWindowMaximized', () => {
  it('默认未最大化', () => {
    subscribe()
    const { result } = renderHook(() => useWindowMaximized())
    expect(result.current).toBe(false)
  })

  it('首屏补拉能恢复最大化状态（窗口重建后的首帧）', async () => {
    subscribe()
    window.aether = makeAether({
      getWindowState: vi.fn(async () => ({ maximized: true })),
      onWindowState: vi.fn(() => () => {})
    })

    const { result } = renderHook(() => useWindowMaximized())
    await waitFor(() => expect(result.current).toBe(true))
  })

  it('推送到达后跟随最大化的进入与退出', () => {
    const { emit } = subscribe()
    const { result } = renderHook(() => useWindowMaximized())

    emit(true)
    expect(result.current).toBe(true)

    emit(false)
    expect(result.current).toBe(false)
  })

  it('首屏补拉失败不影响订阅', async () => {
    let push: ((state: WindowStateView) => void) | null = null
    window.aether = makeAether({
      getWindowState: vi.fn(async () => {
        throw new Error('窗口正在重建')
      }),
      onWindowState: (cb) => {
        push = cb
        return () => {}
      }
    })

    const { result } = renderHook(() => useWindowMaximized())
    // 让失败的补拉先落地：它必须被吞掉，不能把订阅清掉。
    await Promise.resolve()
    await Promise.resolve()

    act(() => {
      push?.({ maximized: true })
    })
    expect(result.current).toBe(true)
  })

  it('卸载时取消订阅', () => {
    const { off } = subscribe()
    const { unmount } = renderHook(() => useWindowMaximized())
    unmount()
    expect(off).toHaveBeenCalledTimes(1)
  })

  it('缺少 preload 时保持未最大化且不抛错', () => {
    Reflect.deleteProperty(window, 'aether')
    expect(() => renderHook(() => useWindowMaximized())).not.toThrow()
  })
})
