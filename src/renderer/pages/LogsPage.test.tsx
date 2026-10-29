import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { LogsSnapshot } from '../../shared/ipc'
import { copy } from '../copy'
import { formatClock } from '../format'
import { makeAether } from '../test-utils'
import { LogsPage } from './LogsPage'

const AT = new Date(2026, 9, 29, 14, 3, 5).getTime()

function entry(payload: string, level = 'warning') {
  return { at: AT, level, payload }
}

function snapshot(payloads: string[], revision = payloads.length): LogsSnapshot {
  return { entries: payloads.map((payload) => entry(payload)), revision }
}

/** 轮询间隔压到最短：用例不等真实的 1 秒。 */
const FAST = 5

describe('LogsPage', () => {
  it('逐条显示时间、级别与内核原文', async () => {
    const payload = '[TCP] dial Proxy (match Match/) 127.0.0.1:8608(curl.exe) --> example.com:80 error: refused'
    window.aether = makeAether({ getLogs: vi.fn(async () => snapshot([payload])) })

    render(<LogsPage intervalMs={FAST} />)

    expect(await screen.findByText(payload)).toBeInTheDocument()
    expect(screen.getByText(formatClock(AT))).toBeInTheDocument()
    expect(screen.getByText('warning')).toBeInTheDocument()
    expect(screen.getByText(copy.logs.live)).toBeInTheDocument()
    expect(screen.getByText(copy.logs.count(1))).toBeInTheDocument()
  })

  it('没有来源时说「收不到日志」，而不是「暂无日志」', async () => {
    window.aether = makeAether({ getLogs: vi.fn(async () => null) })

    render(<LogsPage intervalMs={FAST} />)

    expect(await screen.findByText(copy.logs.offline)).toBeInTheDocument()
    expect(screen.getByText(copy.logs.stopped)).toBeInTheDocument()
    expect(screen.queryByText(copy.logs.empty)).toBeNull()
  })

  it('内核已连接但还没有日志：说明的是「还没有」，不是「没有来源」', async () => {
    window.aether = makeAether({ getLogs: vi.fn(async () => snapshot([], 0)) })

    render(<LogsPage intervalMs={FAST} />)

    expect(await screen.findByText(copy.logs.empty)).toBeInTheDocument()
    expect(screen.getByText(copy.logs.live)).toBeInTheDocument()
  })

  it('内核停下后保留最后几条，并明确标注不再更新', async () => {
    const getLogs = vi
      .fn<() => Promise<LogsSnapshot | null>>()
      .mockResolvedValueOnce(snapshot(['first-line']))
      .mockResolvedValue(null)
    window.aether = makeAether({ getLogs })

    render(<LogsPage intervalMs={FAST} />)
    expect(await screen.findByText('first-line')).toBeInTheDocument()

    // 崩溃时最需要日志：条目必须留着，但状态要如实变成「已停止」。
    expect(await screen.findByText(copy.logs.stoppedNote)).toBeInTheDocument()
    expect(screen.getByText('first-line')).toBeInTheDocument()
    expect(screen.getByText(copy.logs.stopped)).toBeInTheDocument()
  })

  it('新日志到达时贴着底部滚动', async () => {
    const getLogs = vi
      .fn<() => Promise<LogsSnapshot | null>>()
      .mockResolvedValueOnce(snapshot(['line-1'], 1))
      .mockResolvedValue(snapshot(['line-1', 'line-2'], 2))
    window.aether = makeAether({ getLogs })

    render(<LogsPage intervalMs={FAST} />)
    const list = await screen.findByRole('log')
    const scroll = attachScrollMetrics(list)

    expect(await screen.findByText('line-2')).toBeInTheDocument()

    // 初始就在底部：新条目到达后仍应停在最新一条。
    await waitFor(() => expect(scroll.top).toBe(scroll.height))
  })

  it('读者往上翻时不被新日志拽回底部', async () => {
    const getLogs = vi
      .fn<() => Promise<LogsSnapshot | null>>()
      .mockResolvedValueOnce(snapshot(['line-1'], 1))
      .mockResolvedValue(snapshot(['line-1', 'line-2'], 2))
    window.aether = makeAether({ getLogs })

    render(<LogsPage intervalMs={FAST} />)
    const list = await screen.findByRole('log')
    // 比视口高的可滚动列表，用户滚到顶部后离底 600px，不算「贴着底」。
    const scroll = attachScrollMetrics(list, { height: 1000, clientHeight: 400 })
    scroll.top = 0
    list.dispatchEvent(new Event('scroll'))
    expect(await screen.findByText('line-2')).toBeInTheDocument()

    await waitFor(() => expect(screen.getByText(copy.logs.count(2))).toBeInTheDocument())
    expect(scroll.top).toBe(0)
  })
})

/**
 * jsdom 不做布局：scrollHeight / clientHeight 恒为 0，scrollTop 也不会保值。
 * 用一个可读写的替身接管这三个属性，才能断言滚动策略本身。
 */
function attachScrollMetrics(
  element: HTMLElement,
  options: { height?: number; clientHeight?: number } = {}
): { top: number; height: number } {
  const state = { top: 0, height: options.height ?? 400 }
  const clientHeight = options.clientHeight ?? 400
  Object.defineProperty(element, 'scrollHeight', {
    configurable: true,
    get: () => state.height
  })
  Object.defineProperty(element, 'clientHeight', {
    configurable: true,
    get: () => clientHeight
  })
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    get: () => state.top,
    set: (value: number) => {
      state.top = value
    }
  })
  return state
}
