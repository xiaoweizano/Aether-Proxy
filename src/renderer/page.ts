import { copy } from './copy'

/**
 * 主区的五个页面。单窗口、无深链接，所以页面只是本地状态，不引入路由器：
 * 每个值同时是侧栏导航项的身份和 `<Placeholder>` 的文案键。
 */
export type Page = 'dashboard' | 'nodes' | 'connections' | 'settings' | 'logs'

/** 顶栏 h1 只反映当前页面，不能永远写「仪表盘」。 */
export const PAGE_TITLES: Record<Page, string> = {
  dashboard: copy.dashboard.title,
  nodes: copy.nav.nodes,
  connections: copy.nav.connections,
  settings: copy.nav.settings,
  logs: copy.nav.logs
}
