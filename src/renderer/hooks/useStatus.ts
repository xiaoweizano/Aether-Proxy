import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppStatusView } from '../../shared/ipc'

export interface StatusState {
  status: AppStatusView | null
  error: string | null
}

export type UseStatusResult = StatusState & { refresh(): Promise<void> }

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 轮询主进程状态；任何失败都收进 error，不向调用方抛错。 */
export function useStatus(intervalMs = 1000): UseStatusResult {
  const [state, setState] = useState<StatusState>({ status: null, error: null })
  const mounted = useRef(true)

  const refresh = useCallback(async () => {
    const api = window.aether
    if (api === undefined) return
    try {
      const status = await api.getStatus()
      if (mounted.current) setState({ status, error: null })
    } catch (error) {
      if (mounted.current) {
        setState((previous) => ({ status: previous.status, error: describeError(error) }))
      }
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

  return { ...state, refresh }
}
