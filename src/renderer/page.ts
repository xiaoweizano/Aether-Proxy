import { copy } from './copy'

/**
 * 主区的五个页面。单窗口、无深链接，所以页面只是本地状态，不引入路由器：
 * 每个值同时是侧栏导航项的身份与顶栏标题的键。
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

/**
 * 初始页面。默认仪表盘；`?page=logs` 只认这五个值之一。
 *
 * 为什么要支持它：截图冒烟要能拍到任意一页（`AETHER_SHOT_PAGE=logs npm run shot`），
 * 否则新页面只有单元测试、没有一次真实渲染。未知值静默回退到仪表盘——
 * URL 只能在这五个身份里选，不能决定渲染什么。
 */
export function initialPage(search: string): Page {
  const value = new URLSearchParams(search).get('page')
  if (value === null) return 'dashboard'
  return Object.hasOwn(PAGE_TITLES, value) ? (value as Page) : 'dashboard'
}
