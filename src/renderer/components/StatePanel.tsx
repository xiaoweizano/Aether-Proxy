import { useState } from 'react'
import type { AppStatusView, PickImportResult, SimpleResult } from '../../shared/ipc'
import { copy } from '../copy'

export interface StatePanelProps {
  status: AppStatusView['status']
  /** 状态轮询本身的错误；有它时一并展示，避免状态页看起来一切正常。 */
  proxyError?: string
  /** 重启成功后请求父级重新拉取状态。 */
  onRefresh?(): void
  /** 测试注入；缺省走 window.aether。 */
  importConfig?(): Promise<PickImportResult>
  restartCore?(): Promise<SimpleResult>
}

type PanelStatus = 'no-config' | 'config-error' | 'core-error' | 'in-use' | 'reconnecting'

function describe(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== '' ? error.message : fallback
}

function copyFor(status: PanelStatus): { title: string; detail: string } {
  switch (status) {
    case 'no-config':
      return copy.state.noConfig
    case 'config-error':
      return copy.state.configError
    case 'core-error':
      return copy.state.coreError
    case 'reconnecting':
      return copy.state.reconnecting
    case 'in-use':
      return copy.state.inUse
  }
}

/**
 * 非 ready 状态的主视图：每个状态只给一个主操作，其余入口保持次要或占位。
 * `in-use` 不提供任何操作——另一个实例持有系统代理，这里的写操作都会落空；
 * 而且 M1 不做单实例锁，本实例本来就该继续运行（规格 7.7），没有「关掉再试」可点。
 */
export function StatePanel({
  status,
  proxyError,
  onRefresh,
  importConfig,
  restartCore
}: StatePanelProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [imported, setImported] = useState(false)

  if (status === 'ready') return null
  const panelStatus: PanelStatus = status
  const text = copyFor(panelStatus)
  const shownError = error ?? proxyError ?? null

  async function runImport(): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const call = importConfig ?? window.aether?.importConfig
      if (call === undefined) throw new Error(copy.state.apiUnavailable)
      const result = await call()
      if (!result.ok) {
        // 取消不是错误：用户主动关掉了对话框，界面保持原样。
        if (result.cancelled !== true) {
          setImported(false)
          setError(result.message ?? copy.state.importFailed)
        }
        return
      }
      setImported(true)
    } catch (err) {
      setImported(false)
      setError(describe(err, copy.state.importFailed))
    } finally {
      setBusy(false)
    }
  }

  async function runRestart(): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const call = restartCore ?? window.aether?.restartCore
      if (call === undefined) throw new Error(copy.state.apiUnavailable)
      const result = await call()
      if (!result.ok) {
        // 重启失败就回到该状态的常规操作集：清掉「已导入」，
        // 否则 config-error 会卡在只剩重启按钮的死胡同里。
        setImported(false)
        setError(result.message ?? copy.state.restartFailed)
        return
      }
      setImported(false)
      onRefresh?.()
    } catch (err) {
      setImported(false)
      setError(describe(err, copy.state.restartFailed))
    } finally {
      setBusy(false)
    }
  }

  function logsButton() {
    return (
      <span className="state-logs">
        <button
          type="button"
          className="state-action"
          disabled
          title={copy.state.logsPlaceholder}
        >
          {copy.state.logsAction}
        </button>
        <span className="state-note">{copy.state.logsPlaceholder}</span>
      </span>
    )
  }

  function actions() {
    if (panelStatus === 'in-use') return null

    /**
     * 正在自动重连：只说明，不提供主操作。后台已有退避定时器在拉内核，
     * 再给一个「重启内核」会让用户的手动操作和自动重启互相抢，拉起两个进程。
     */
    if (panelStatus === 'reconnecting') return null

    if (imported) {
      return (
        <div className="state-actions">
          <button
            type="button"
            className="state-action"
            onClick={() => {
              void runRestart()
            }}
            disabled={busy}
          >
            {copy.state.noConfig.restartAction}
          </button>
        </div>
      )
    }

    if (panelStatus === 'no-config') {
      return (
        <div className="state-actions">
          <button
            type="button"
            className="state-action primary"
            onClick={() => {
              void runImport()
            }}
            disabled={busy}
          >
            {copy.state.noConfig.importAction}
          </button>
        </div>
      )
    }

    if (panelStatus === 'config-error') {
      return (
        <div className="state-actions">
          <button
            type="button"
            className="state-action primary"
            onClick={() => {
              void runImport()
            }}
            disabled={busy}
          >
            {copy.state.configError.importAction}
          </button>
          <button
            type="button"
            className="state-action"
            onClick={() => {
              void runRestart()
            }}
            disabled={busy}
          >
            {copy.state.coreError.restartAction}
          </button>
          {logsButton()}
        </div>
      )
    }

    return (
      <div className="state-actions">
        <button
          type="button"
          className="state-action primary"
          onClick={() => {
            void runRestart()
          }}
          disabled={busy}
        >
          {copy.state.coreError.restartAction}
        </button>
        {logsButton()}
      </div>
    )
  }

  return (
    <section className="state-panel" aria-label={text.title}>
      <div className="state-card">
        <h2 className="state-title">{text.title}</h2>
        <p className="state-detail">{text.detail}</p>
        {imported && shownError === null && (
          <p className="state-success" role="status">
            {copy.state.noConfig.imported}
          </p>
        )}
        {shownError !== null && (
          <p className="state-error" role="alert">
            {shownError}
          </p>
        )}
        {actions()}
      </div>
    </section>
  )
}
