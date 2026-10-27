import { useEffect, useState } from 'react'
import type { ConnectionView, ConnectionsSnapshot } from '../../shared/ipc'

export interface ConnectionsState {
  items: ConnectionView[]
  /** 内核上报的内存；缺失保持 null，不填 0。 */
  memory: number | null
  /** 最近一份快照的生成时刻；还没有快照时为 null。 */
  at: number | null
}

const EMPTY: ConnectionsState = { items: [], memory: null, at: null }

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
  return { items: snapshot.items.filter(isConnection), memory, at }
}

/**
 * 订阅主进程的连接快照。
 *
 * 先订阅再补首屏：窗口重建时两者可能交错到达，用 `at` 挡住更旧的快照，
 * 避免慢一拍的首屏把新推送覆盖掉。主进程在窗口销毁期间仍继续采集，
 * 这里只负责渲染层这一份最新快照。
 */
export function useConnections(): ConnectionsState {
  const [state, setState] = useState<ConnectionsState>(EMPTY)

  useEffect(() => {
    const api = window.aether
    if (api === undefined) return

    let active = true
    const apply = (value: unknown): void => {
      const next = normalize(value)
      if (next === null) return
      setState((previous) => {
        if (previous.at !== null && next.at < previous.at) return previous
        return next
      })
    }

    const off = api.onConnections((snapshot) => {
      if (active) apply(snapshot)
    })
    void api.getConnections().then(
      (snapshot) => {
        if (active) apply(snapshot)
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
