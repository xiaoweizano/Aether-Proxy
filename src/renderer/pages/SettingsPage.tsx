import { useCallback, useEffect, useState } from 'react'
import type { AutostartStateView, SimpleResult, UrlImportResult } from '../../shared/ipc'
import { copy } from '../copy'

/**
 * 设置页。本计划唯一的新 UI 页，M1 只有一项：开机自启。
 *
 * 三条产品约束直接决定这个页面的形状：
 * 1. **关闭自启要同屏显示警告**，不能是悬浮提示或折叠说明——DESIGN.md 禁止把有后果
 *    的事实藏进 hover 文本（这条规则在这个仓库里已经踩过一次并修正过）。
 * 2. **开关的位置只来自主进程回的真实状态**。本地不维护「乐观值」：切换请求返回后，
 *    一律用返回的 `state` 覆盖；失败时开关因此自然弹回系统实际值。
 * 3. **开发态与系统值不一致都要如实说**，而不是把开关画成「已开启」了事。
 */

interface SettingsPageProps {
  /**
   * 读取自启状态。缺省走 `window.aether`；测试可注入以固定首屏结果。
   *
   * 之所以不在这里新建一个 hook：这一页只有一个状态源，读一次 + 切换回写就够，
   * 关窗重建会重新挂载整页，不需要订阅。
   */
  read?: () => Promise<AutostartStateView>
  write?: (enabled: boolean) => Promise<{ ok: boolean; state: AutostartStateView }>
  /** 订阅导入。缺省走 `window.aether.importConfigFromUrl`；测试可注入。 */
  importUrl?: (url: string) => Promise<UrlImportResult>
  /** 导入后没生效时给用户的出口。缺省走 `window.aether.restartCore`。 */
  restartCore?: () => Promise<SimpleResult>
}

/** 主进程状态视图；渲染层只做显示，不再推导「应该」是什么。 */
type State = AutostartStateView

export function SettingsPage({ read, write, importUrl, restartCore }: SettingsPageProps) {
  const [state, setState] = useState<State | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const [url, setUrl] = useState('')
  const [importing, setImporting] = useState(false)
  const [importMessage, setImportMessage] = useState<string | null>(null)
  const [importFailed, setImportFailed] = useState(false)
  const [needsRestart, setNeedsRestart] = useState(false)
  const [restarting, setRestarting] = useState(false)

  const load = useCallback(async () => {
    const api = window.aether
    const reader = read ?? api?.getAutostart.bind(api)
    if (reader === undefined) {
      setFailed(copy.settings.autostart.loadFailed)
      return
    }
    try {
      setState(await reader())
      setFailed(null)
    } catch {
      setFailed(copy.settings.autostart.loadFailed)
    }
  }, [read])

  useEffect(() => {
    void load()
  }, [load])

  /**
   * 切换。**先禁用再发请求**：连点两次会让两个写注册表的动作交错，
   * 后一次失败时开关要往哪边回位就没有答案了。
   *
   * 无论成功失败都用返回的 `state` 覆盖本地值——这是「诚实优先」的落点：
   * 主进程回的是重新读到的系统状态，不是请求的意图。
   */
  const toggle = useCallback(async () => {
    if (state === null || busy) return
    const api = window.aether
    const writer = write ?? api?.setAutostart.bind(api)
    if (writer === undefined) {
      setFailed(copy.settings.autostart.changeFailed)
      return
    }
    setBusy(true)
    setFailed(null)
    try {
      const result = await writer(!state.enabled)
      setState(result.state)
      setFailed(result.ok ? null : copy.settings.autostart.changeFailed)
    } catch {
      // 通道本身失败（主进程已退出等）：重新读一次真实状态，不能停在点击后的样子。
      // 先 load 再置错误——`load` 成功时会把 `failed` 清空，顺序反过来错误会被吞掉。
      await load()
      setFailed(copy.settings.autostart.changeFailed)
    } finally {
      setBusy(false)
    }
  }, [state, busy, write, load])

  /**
   * 订阅导入。空地址本地拦下（不白跑一趟主进程）；其余一律以主进程回的结果为准——
   * 成功文案明说「重启内核后生效」，因为落盘不等于生效。
   */
  const submitImport = useCallback(async () => {
    if (importing) return
    const target = url.trim()
    if (target === '') {
      setImportMessage(copy.settings.subscription.empty)
      setImportFailed(true)
      return
    }
    const api = window.aether
    const runner = importUrl ?? api?.importConfigFromUrl.bind(api)
    if (runner === undefined) {
      setImportMessage(copy.settings.subscription.failed)
      setImportFailed(true)
      return
    }
    setImporting(true)
    setImportMessage(null)
    setImportFailed(false)
    setNeedsRestart(false)
    try {
      const result = await runner(target)
      if (result.ok) {
        setUrl('')
        // 三种成功状态必须分开说：已生效 / 需要重启 / 内核拒收。只说「已导入」
        // 会让用户以为新订阅已经跑起来了。
        if (result.applied === 'reloaded') {
          setImportMessage(copy.settings.subscription.reloaded)
          setImportFailed(false)
        } else if (result.applied === 'reload-failed') {
          setImportMessage(
            `${copy.settings.subscription.reloadFailed}${result.message ?? ''}`
          )
          setImportFailed(true)
          setNeedsRestart(true)
        } else {
          setImportMessage(copy.settings.subscription.imported)
          setImportFailed(false)
          setNeedsRestart(true)
        }
      } else {
        setImportMessage(result.message || copy.settings.subscription.failed)
        setImportFailed(true)
      }
    } catch {
      setImportMessage(copy.settings.subscription.failed)
      setImportFailed(true)
    } finally {
      setImporting(false)
    }
  }, [importing, url, importUrl])

  /**
   * 导入后的「立即重启内核」。只在需要重启时出现，并且**仍然以主进程回的结果为准**：
   * 重启失败（例如新配置校验不过）时如实显示原因，不把按钮变成「已生效」。
   */
  const restartKernel = useCallback(async () => {
    if (restarting) return
    const api = window.aether
    const call = restartCore ?? api?.restartCore.bind(api)
    if (call === undefined) {
      setImportMessage(copy.settings.subscription.restartFailed)
      setImportFailed(true)
      return
    }
    setRestarting(true)
    try {
      const result = await call()
      if (result.ok) {
        setNeedsRestart(false)
        setImportMessage(copy.settings.subscription.reloaded)
        setImportFailed(false)
      } else {
        setImportMessage(result.message || copy.settings.subscription.restartFailed)
        setImportFailed(true)
      }
    } catch {
      setImportMessage(copy.settings.subscription.restartFailed)
      setImportFailed(true)
    } finally {
      setRestarting(false)
    }
  }, [restarting, restartCore])

  /**
   * 订阅导入卡片。与自启开关分开成一张卡：两者的状态源互不相干，
   * 合成一张会让「自启读失败」连带把导入按钮也锁死。
   *
   * 成功态只说「已导入，重启内核后生效」——写进 config.yaml 不等于 mihomo 已经加载，
   * 这里不替内核打包票。
   */
  const importCard = (
    <div className="settings-card">
      <div className="settings-row settings-row-column">
        <div className="settings-text">
          <span className="settings-label" id="subscription-label">
            {copy.settings.subscription.label}
          </span>
          <span className="settings-desc">{copy.settings.subscription.description}</span>
        </div>
        <div className="settings-import">
          <input
            type="url"
            className="settings-input"
            aria-labelledby="subscription-label"
            placeholder={copy.settings.subscription.placeholder}
            value={url}
            disabled={importing}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => {
              setUrl(event.target.value)
              setImportMessage(null)
              setImportFailed(false)
              setNeedsRestart(false)
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              void submitImport()
            }}
          />
          <button
            type="button"
            className="state-action primary"
            disabled={importing || restarting}
            onClick={() => {
              void submitImport()
            }}
          >
            {importing ? copy.settings.subscription.importing : copy.settings.subscription.action}
          </button>
          {needsRestart && (
            <button
              type="button"
              className="state-action"
              disabled={restarting || importing}
              onClick={() => {
                void restartKernel()
              }}
            >
              {restarting ? copy.settings.subscription.restarting : copy.settings.subscription.restart}
            </button>
          )}
        </div>
      </div>
      {importMessage !== null && (
        <p
          className={importFailed ? 'settings-error' : 'settings-note'}
          role={importFailed ? 'alert' : 'status'}
        >
          {importMessage}
        </p>
      )}
    </div>
  )

  // 首屏还没回来：只占位，不画一个「已关闭」的假开关。
  if (state === null) {
    return (
      <section className="settings-page" aria-label={copy.settings.label}>
        <div className="settings-card">
          <div className="settings-row">
            <div className="settings-text">
              <span className="settings-label">{copy.settings.autostart.label}</span>
              <span className="settings-desc">{copy.settings.autostart.description}</span>
            </div>
          </div>
          {failed !== null && (
            <p className="settings-error" role="alert">
              {failed}
            </p>
          )}
        </div>
        {importCard}
      </section>
    )
  }

  const error = failed ?? state.error ?? null
  const showWarning = !state.enabled

  return (
    <section className="settings-page" aria-label={copy.settings.label}>
      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-text">
            <span className="settings-label" id="autostart-label">
              {copy.settings.autostart.label}
            </span>
            <span className="settings-desc">{copy.settings.autostart.description}</span>
            {!state.appliesToSystem && (
              <span className="settings-note">{copy.settings.autostart.devOnly}</span>
            )}
            {state.systemDiffers && (
              <span className="settings-note">
                {copy.settings.autostart.systemDiffers(state.enabled)}
              </span>
            )}
          </div>
          <button
            type="button"
            role="switch"
            className="settings-switch"
            aria-checked={state.enabled}
            aria-labelledby="autostart-label"
            aria-describedby={showWarning ? 'autostart-warning' : undefined}
            disabled={busy}
            data-state={state.enabled ? 'on' : 'off'}
            onClick={() => {
              void toggle()
            }}
          >
            <span className="settings-switch-track" aria-hidden="true">
              <span className="settings-switch-thumb" />
            </span>
            <span className="settings-switch-text">
              {state.enabled ? copy.settings.autostart.on : copy.settings.autostart.off}
            </span>
          </button>
        </div>

        {showWarning && (
          <p className="settings-warning" id="autostart-warning">
            <strong className="settings-warning-title">{copy.settings.autostart.warningTitle}</strong>
            {copy.settings.autostart.warning}
          </p>
        )}

        {error !== null && (
          <p className="settings-error" role="alert">
            {error}
          </p>
        )}
      </div>
      {importCard}
    </section>
  )
}
