import { copy } from '../copy'

/** 纯装饰的 Windows 标题栏；窗口控制逻辑尚未接入。 */
export function TitleBar() {
  return (
    <header className="titlebar">
      <span className="titlebar-mark" aria-hidden="true" />
      <span className="titlebar-name">{copy.app.name}</span>
      <span className="titlebar-spacer" />
      <div className="window-buttons" aria-hidden="true">
        <span className="window-button">{copy.window.minimize}</span>
        <span className="window-button">{copy.window.maximize}</span>
        <span className="window-button">{copy.window.close}</span>
      </div>
    </header>
  )
}
