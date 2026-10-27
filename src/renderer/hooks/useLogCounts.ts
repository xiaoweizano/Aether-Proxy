import { useEffect, useState } from 'react'
import type { DialFailureCounts } from '../../shared/ipc'

/**
 * 轮询间隔；规格要求失败出现后 5 秒内可见，取 3 秒留出一次 IPC 往返的余量。
 * **不能只依赖推送**：采集器只在新失败到达时推送，失败滚出窗口没有任何回调，
 * 只订阅会让仪表盘无限期显示过期的非零计数。
 */
export const LOG_COUNTS_POLL_MS = 3000

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/**
 * 逐字段校验；任何一项非法就整条丢弃，`NaN` 不得顺着文案渲染出去。
 * `windowMs` 为 0 或负数视为畸形：文案要由一个真实窗口长度推导。
 */
function normalizeCounts(value: unknown): DialFailureCounts | null {
  if (typeof value !== 'object' || value === null) return null
  const { recent, windowMs } = value as { recent?: unknown; windowMs?: unknown }
  if (!isCount(recent)) return null
  if (!isCount(windowMs) || windowMs === 0) return null
  return { recent, windowMs }
}

/**
 * 拨号失败计数：订阅推送 + 定时轮询，返回最新一份合法计数；没有采集器时为 null。
 *
 * 三条规则：
 * - `null` 表示「没有计数来源」，与 `recent: 0` 是两件事，界面必须区别对待；
 * - 轮询是必须的：计数窗口到期只会让 `getLogCounts()` 变小，不会推送；
 * - 轮询结果比已经落地的推送旧时丢弃，避免在途请求把计数写回去（计数倒退）。
 */
export function useLogCounts(pollMs: number = LOG_COUNTS_POLL_MS): DialFailureCounts | null {
  const [state, setState] = useState<DialFailureCounts | null>(null)

  useEffect(() => {
    const api = window.aether
    if (api === undefined) return

    let active = true
    /** 每落地一次更新就自增；在途请求用它在返回时判断自己是否已经过期。 */
    let epoch = 0
    /** 同一时刻只允许一个轮询在途，避免响应乱序。 */
    let inFlight = false

    const apply = (next: DialFailureCounts | null): void => {
      epoch += 1
      // 值没变就保留原对象：轮询每 3 秒一次，无谓的重渲染会白刷整张卡。
      setState((previous) =>
        previous === next ||
        (previous !== null &&
          next !== null &&
          previous.recent === next.recent &&
          previous.windowMs === next.windowMs)
          ? previous
          : next
      )
    }

    const off = api.onLogCounts((counts) => {
      if (!active) return
      const normalized = normalizeCounts(counts)
      if (normalized !== null) apply(normalized)
    })

    const poll = async (): Promise<void> => {
      if (!active || inFlight) return
      inFlight = true
      const startedAt = epoch
      try {
        const value = await api.getLogCounts()
        if (!active) return
        // 请求期间已有更新落地（推送或更晚的轮询）：这份结果是更早的事实，丢弃。
        if (epoch !== startedAt) return
        if (value === null) {
          apply(null)
          return
        }
        const normalized = normalizeCounts(value)
        if (normalized !== null) apply(normalized)
      } catch {
        // 内核重启期间调用会失败：保留上一个已知值，不把异常抛给界面。
      } finally {
        inFlight = false
      }
    }

    void poll()
    const timer = setInterval(() => {
      void poll()
    }, pollMs)

    return () => {
      active = false
      clearInterval(timer)
      off()
    }
  }, [pollMs])

  return state
}
