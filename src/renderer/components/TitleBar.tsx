import { copy } from '../copy'

/**
 * 原生窗口边框仍然保留，所以这里只画品牌标识，不画假的 — ▢ ✕。
 * 真正的窗口控制要经 IPC 接入，排在下一个计划。
 */
export function TitleBar() {
  return (
    <header className="titlebar">
      <span className="titlebar-mark" aria-hidden="true" />
      <span className="titlebar-name">{copy.app.name}</span>
    </header>
  )
}
