import { useEffect, useState } from 'react'
import type { ConnectionView, ConnectionsSnapshot } from '../../shared/ipc'

export interface ConnectionsState {
  items: ConnectionView[]
  /** 内核上报的内存（字节）；缺失保持 null，不填 0。 */
  memory: number | null
  /**
   * 已结束连接的保留窗口（毫秒）；没有采集器（内核未运行）时为 null。
   * 界面用它推导窗口文案，并用 null 区分「没有数据来源」与「测得零条」。
   */
  retainMs: number | null
  /** 最近一份快照的生成时刻；还没有快照时为 null。 */
  at: number | null
}

/** 仪表盘需要的连接摘要；没有采集器时 active/total/retainMs 均为 null（未知，不是 0）。 */
export interface ConnectionSummary {
  /** 真正活跃的连接数（不含仍在保留期内的已结束行）。 */
  active: number | null
  /** 缓冲内条目总数，含已结束行；用来说明活跃数与连接页条数的差异。 */
  total: number | null
  /** 内核内存（字节）；未知为 null。 */
  memory: number | null
  /** 已结束连接的保留窗口（毫秒）；未知为 null。 */
  retainMs: number | null
}

/**
 * 从一份快照派生仪表盘数字。`retainMs === null` 只会在采集器不存在时出现
 * （`getConnections` 的空快照），因此它同时是「有没有数据来源」的判据：
 * 没有来源时连接数是未知，不能用 `items.length` 得到一个看似测量的 0。
 */
export function summarizeConnections(state: ConnectionsState): ConnectionSummary {
  const known = state.retainMs !== null
  return {
    active: known ? state.items.filter((item) => !item.ended).length : null,
    total: known ? state.items.length : null,
    memory: state.memory,
    retainMs: state.retainMs
  }
}

const EMPTY: ConnectionsState = { items: [], memory: null, retainMs: null, at: null }

function isConnection(value: unknown): value is ConnectionView {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string'
  )
}

/** 逐字段校验到视图模型需要的程度；整份快照坏掉时返回 null，保留上一份。 */
type NormalizedSnapshot = Omit<ConnectionsState, 'at'> & { at: number }

function normalize(value: unknown): NormalizedSnapshot | null {
  if (typeof value !== 'object' || value === null) return null
  const snapshot = value as Partial<ConnectionsSnapshot>
  if (!Array.isArray(snapshot.items)) return null
  const at =
    typeof snapshot.at === 'number' && Number.isFinite(snapshot.at) ? snapshot.at : Date.now()
  const memory =
    typeof snapshot.memory === 'number' && Number.isFinite(snapshot.memory)
      ? snapshot.memory
      : null
  const retainMs =
    typeof snapshot.retainMs === 'number' &&
    Number.isFinite(snapshot.retainMs) &&
    snapshot.retainMs >= 0
      ? snapshot.retainMs
      : null
  return { items: snapshot.items.filter(isConnection), memory, retainMs, at }
}

/**
 * 订阅主进程的连接快照。
 *
 * 先订阅再补首屏：首屏可能比推送慢一拍，所以在收到过任何推送后直接丢弃首屏结果。
 * 推送之间**不做** `at` 排序——系统时钟回拨（NTP / 手动改时间）时，
 * 用旧时间戳挡住新快照会让页面永久冻住；推送就是最新事实。
 */
export function useConnections(): ConnectionsState {
  const [state, setState] = useState<ConnectionsState>(EMPTY)

  useEffect(() => {
    const api = window.aether
    if (api === undefined) return

    let active = true
    let receivedPush = false

    const applyPush = (value: unknown): void => {
      const next = normalize(value)
      if (next === null) return
      receivedPush = true
      setState(next)
    }

    const applyInitial = (value: unknown): void => {
      // 推送已经到过就没必要再补首屏；否则用首屏填第一帧。
      if (receivedPush) return
      const next = normalize(value)
      if (next === null) return
      setState(next)
    }

    const off = api.onConnections((snapshot) => {
      if (active) applyPush(snapshot)
    })
    void api.getConnections().then(
      (snapshot) => {
        if (active) applyInitial(snapshot)
      },
      () => {
        // 首屏失败时保留空状态；后续推送到达会自然补齐。
      }
    )

    return () => {
      active = false
      off()
    }
  }, [])

  return state
}
