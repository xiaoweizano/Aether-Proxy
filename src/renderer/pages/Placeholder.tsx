import type { Page } from '../page'
import { copy } from '../copy'

/** 主区中除仪表盘外的四页：节点与连接由后续任务替换，设置与日志仍是占位。 */
export type PlaceholderPage = Exclude<Page, 'dashboard'>

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
