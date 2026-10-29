import { useEffect, useRef, useState } from 'react'
import type { ProxyGroupView } from '../../shared/ipc'

const DEFAULT_INTERVAL_MS = 3000

export interface ProxiesState {
  groups: ProxyGroupView[]
  error: string | null
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 轮询策略组（3 秒一次）。任何失败都收进 `error`，并保留上一份数据：
 * 内核重启期间界面不该把已有节点清空，也不该把异常抛给调用方。
 */
export function useProxies(intervalMs = DEFAULT_INTERVAL_MS): ProxiesState {
  const [state, setState] = useState<ProxiesState>({ groups: [], error: null })
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    const api = window.aether
    if (api === undefined) {
      return () => {
        mounted.current = false
      }
    }

    async function load(): Promise<void> {
      try {
        const groups = await api.getProxies()
        if (mounted.current) setState({ groups, error: null })
      } catch (error) {
        if (mounted.current) {
          setState((previous) => ({ groups: previous.groups, error: describeError(error) }))
        }
      }
    }

    void load()
    const timer = setInterval(() => {
      void load()
    }, intervalMs)

    return () => {
      mounted.current = false
      clearInterval(timer)
    }
  }, [intervalMs])

  return state
}
