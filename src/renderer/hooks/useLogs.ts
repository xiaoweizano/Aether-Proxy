import { useCallback, useEffect, useRef, useState } from 'react'
import type { LogEntryView } from '../../shared/ipc'

/** 轮询间隔。日志是低频数据，1 秒足够；与状态、计数两条轮询保持一致的心跳。 */
export const LOGS_POLL_MS = 1000

export interface LogsState {
  /** 已知的日志尾巴，最新在最后。 */
  entries: LogEntryView[]
  /** 主进程给的累计追加条数；没有结果时为 -1。 */
  revision: number
  /**
   * 采集器是否存在（内核在跑）。false 时 `entries` 是断开前的尾巴：
   * 界面必须说「不再更新」，不能让它看起来还在实时滚动。
   */
  live: boolean
  error: string | null
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 轮询日志尾巴。
 *
 * 为什么是轮询而不是推送：日志是低频、量小、且天然可以晚一秒的数据；
 * 一条常驻的推送通道（每条日志一次 IPC）比每秒一次快照更贵，也更难在窗口销毁时收尾。
 *
 * 断线时**保留已有条目**：内核崩溃恰恰是最需要看日志的时刻，把尾巴清掉等于在最需要时
 * 把证据擦掉。`live` 翻转成 false，由界面说明它已经停更。
 */
export function useLogs(intervalMs = LOGS_POLL_MS): LogsState {
  const [state, setState] = useState<LogsState>({
    entries: [],
    revision: -1,
    live: false,
    error: null
  })
  const mounted = useRef(true)
  const lastRevision = useRef(-1)

  const refresh = useCallback(async () => {
    const api = window.aether
    if (api === undefined) return
    try {
      const snapshot = await api.getLogs()
      if (!mounted.current) return
      if (snapshot === null) {
        // 没有采集器：来源消失，但已经拿到的条目保留。
        setState((previous) =>
          previous.live ? { ...previous, live: false, error: null } : previous
        )
        return
      }
      if (snapshot.revision === lastRevision.current) {
        // 没有新日志：不换 entries 引用，避免整页每秒重渲染一次。
        setState((previous) =>
          previous.live && previous.error === null
            ? previous
            : { ...previous, live: true, error: null }
        )
        return
      }
      lastRevision.current = snapshot.revision
      setState({
        entries: snapshot.entries,
        revision: snapshot.revision,
        live: true,
        error: null
      })
    } catch (error) {
      if (!mounted.current) return
      // 通道失败同样保留条目：这是「读不到」，不是「没有」。
      setState((previous) => ({
        ...previous,
        live: false,
        error: describeError(error)
      }))
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void refresh()
    const timer = setInterval(() => {
      void refresh()
    }, intervalMs)
    return () => {
      mounted.current = false
      clearInterval(timer)
    }
  }, [intervalMs, refresh])

  return state
}
