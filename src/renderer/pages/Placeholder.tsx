import type { Page } from '../page'
import { copy } from '../copy'

/** 主区中尚未实现的页面：仪表盘、连接页、节点页与设置页已有真实内容，其余仍是占位。 */
export type PlaceholderPage = Exclude<Page, 'dashboard' | 'connections' | 'nodes' | 'settings'>

export interface PlaceholderProps {
  page: PlaceholderPage
}

/**
 * 页面还没实现时的主区内容。标题由顶栏负责，这里只说明「这一页在后续计划中」，
 * 不重复 h1，也不假装功能已经可用。
 */
export function Placeholder({ page }: PlaceholderProps) {
  return (
    <section className="placeholder" aria-label={copy.pages.planned}>
      <div className="placeholder-card">
        <span className="chip solid muted">{copy.pages.planned}</span>
        <p className="placeholder-note">{copy.pages[page].note}</p>
      </div>
    </section>
  )
}
