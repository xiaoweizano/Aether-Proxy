import { useState } from 'react'
import type { AppStatusView } from '../../shared/ipc'
import { copy } from '../copy'
import { ModeSwitch } from './ModeSwitch'

export interface TopBarProps {
  status: AppStatusView | null
  /** 模式或代理状态变化后请求父级重新拉取状态。 */
  onRefresh?(): void
}

type StatusTone = 'ready' | 'error' | 'idle'

function statusLine(status: AppStatusView | null): { label: string; tone: StatusTone } {
  if (status?.status === 'ready') return { label: copy.status.connected, tone: 'ready' }
  if (status?.status === 'core-error') return { label: copy.status.coreError, tone: 'error' }
  return { label: copy.status.disconnected, tone: 'idle' }
}

export function TopBar({ status, onRefresh }: TopBarProps) {
  const [proxyError, setProxyError] = useState<string | null>(null)
  const [proxyPending, setProxyPending] = useState(false)
  const line = statusLine(status)
  const proxyOn = status?.proxyEnabled === true

  async function toggleProxy(): Promise<void> {
    if (proxyPending) return
    setProxyPending(true)
    setProxyError(null)
    try {
      const api = window.aether
      if (api === undefined) throw new Error('aether api is unavailable')
      const result = proxyOn ? await api.disableProxy() : await api.enableProxy()
      if (!result.ok) {
        setProxyError(copy.proxyToggleFailed)
        return
      }
      onRefresh?.()
    } catch {
      setProxyError(copy.proxyToggleFailed)
    } finally {
      setProxyPending(false)
    }
  }

  return (
    <header className="topbar">
      <h1 className="page-title">{copy.dashboard.title}</h1>
      <div className={`topbar-status ${line.tone}`}>
        <span className="status-dot" aria-hidden="true" />
        {line.label}
      </div>
      <div className="topbar-right">
        <ModeSwitch
          value={status?.mode ?? 'rule'}
          onChange={() => {
            onRefresh?.()
          }}
        />
        <button
          type="button"
          className={proxyOn ? 'proxy-pill on' : 'proxy-pill'}
          aria-pressed={proxyOn}
          onClick={() => {
            void toggleProxy()
          }}
        >
          <span className="proxy-dot" aria-hidden="true" />
          {proxyOn ? copy.proxy.on : copy.proxy.off}
        </button>
        {proxyError !== null && (
          <span className="inline-error" role="alert">
            {proxyError}
          </span>
        )}
      </div>
    </header>
  )
}
