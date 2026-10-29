import type { WindowAction } from '../../shared/ipc'
import { copy } from '../copy'

/**
 * 窗口标题栏。窗口是 `frame: false`（主进程 `createBrowserWindow`），所以这一条
 * 40px 的带子既是品牌区，也是整个应用唯一的拖动区与窗控入口。
 *
 * 两条 CSS 级约束（jsdom 里测不到，靠 `styles/app.css` 的注释与 token 检查兜底）：
 * - `.titlebar` 必须 `-webkit-app-region: drag`，否则无边框窗口根本拖不动；
 * - 按钮组必须 `-webkit-app-region: no-drag`，否则拖动区会把点击吞掉。
 *
 * 双击标题栏的拖动区**不需要**在这里处理：Windows + Electron 会对
 * `-webkit-app-region: drag` 区域原生响应双击最大化/还原（已实测），渲染层
 * 收不到 `dblclick` 事件。自己再加一个 dblclick 处理器反而会和原生行为打架。
 */

function MinimizeIcon() {
  return (
    <svg className="titlebar-icon" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M0 5h10" />
    </svg>
  )
}

function MaximizeIcon({ maximized }: { maximized: boolean }) {
  return (
    <svg className="titlebar-icon" viewBox="0 0 10 10" aria-hidden="true">
      {maximized ? (
        // 还原态：两个错开的方框。
        <>
          <rect x="0.5" y="2.5" width="7" height="7" />
          <path d="M2.5 2.5V0.5h7v7h-2" />
        </>
      ) : (
        <rect x="0.5" y="0.5" width="9" height="9" />
      )}
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg className="titlebar-icon" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />
    </svg>
  )
}

interface WindowButton {
  action: WindowAction
  label: string
  className?: string
  icon: React.ReactNode
}

export interface TitleBarProps {
  /** 当前是否最大化；决定中间按钮画的是「最大化」还是「还原」。 */
  maximized?: boolean
}

export function TitleBar({ maximized = false }: TitleBarProps) {
  /**
   * 失败一律吞掉：窗控是 OS 级动作，失败时主进程已经回 `ok:false`，
   * 界面没有可展示的错误面，也不该因为一次点击弹一个错误。
   */
  const control = (action: WindowAction): void => {
    void window.aether?.windowControl(action).catch(() => {})
  }

  const buttons: WindowButton[] = [
    { action: 'minimize', label: copy.window.minimize, icon: <MinimizeIcon /> },
    {
      action: 'maximize',
      label: maximized ? copy.window.restore : copy.window.maximize,
      icon: <MaximizeIcon maximized={maximized} />
    },
    {
      action: 'close',
      label: copy.window.close,
      className: 'titlebar-btn-close',
      icon: <CloseIcon />
    }
  ]

  return (
    <header className="titlebar">
      <span className="titlebar-mark" aria-hidden="true" />
      <span className="titlebar-name">{copy.app.name}</span>
      <div className="titlebar-drag" aria-hidden="true" />
      <div className="titlebar-buttons">
        {buttons.map((button) => (
          <button
            key={button.action}
            type="button"
            className={`titlebar-btn${button.className === undefined ? '' : ` ${button.className}`}`}
            aria-label={button.label}
            title={button.label}
            onClick={() => control(button.action)}
          >
            {button.icon}
          </button>
        ))}
      </div>
    </header>
  )
}
