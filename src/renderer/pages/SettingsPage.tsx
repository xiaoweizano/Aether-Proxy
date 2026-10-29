import { useCallback, useEffect, useState } from 'react'
import type { AutostartStateView } from '../../shared/ipc'
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
}

/** 主进程状态视图；渲染层只做显示，不再推导「应该」是什么。 */
type State = AutostartStateView

export function SettingsPage({ read, write }: SettingsPageProps) {
  const [state, setState] = useState<State | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)

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
          <p className="settings-warning" id="autostart-warning" role="alert">
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
    </section>
  )
}
