import { useState } from 'react'
import type { AppStatusView } from '../../shared/ipc'
import { copy } from '../copy'
import { statusTone, type StatusTone } from '../status'
import { ModeSwitch } from './ModeSwitch'

export interface TopBarProps {
  status: AppStatusView | null
  /** 当前页面的标题；顶栏是外壳的一部分，所以它跟着侧栏切换而不是每页各自画 h1。 */
  title?: string
  /** 模式或代理状态变化后请求父级重新拉取状态。 */
  onRefresh?(): void
}

function statusLine(status: AppStatusView | null): { label: string; tone: StatusTone } {
  const tone = statusTone(status)
  if (tone === 'ready') return { label: copy.status.connected, tone }
  if (tone === 'error') return { label: copy.status.coreError, tone }
  return { label: copy.status.disconnected, tone }
}

export function TopBar({ status, title, onRefresh }: TopBarProps) {
  const [proxyError, setProxyError] = useState<string | null>(null)
  const [proxyPending, setProxyPending] = useState(false)
  const line = statusLine(status)
  // 没有内核时模式与系统代理都没有真实能力：控件禁用（不隐藏），也不显示选中段。
  const ready = status?.status === 'ready'
  const proxyOn = ready && status?.proxyEnabled === true

  async function toggleProxy(): Promise<void> {
    if (!ready || proxyPending) return
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
      <h1 className="page-title">{title ?? copy.dashboard.title}</h1>
      <div className={`topbar-status ${line.tone}`}>
        <span className="status-dot" aria-hidden="true" />
        {line.label}
      </div>
      <div className="topbar-right">
        <ModeSwitch
          value={status?.mode ?? 'rule'}
          disabled={!ready}
          onChange={() => {
            onRefresh?.()
          }}
        />
        <button
          type="button"
          className={proxyOn ? 'proxy-pill on' : 'proxy-pill'}
          aria-pressed={proxyOn}
          disabled={!ready}
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
