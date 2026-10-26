import type { ProxyGroupView } from '../shared/ipc'

export interface ActiveProxy {
  group: string
  node: string
  /** 选中节点最近一次测速结果；没有测速记录时不带该字段。 */
  delay?: number
}

/**
 * mihomo `/proxies` 返回的是 Go 类型名，不是 YAML 里的小写写法：
 * 手选组是 `Selector`（旧版本/部分配置也会写成 `select`），自动组是 `URLTest`
 * 等。比较必须忽略大小写，否则 `select` 永远匹配不到，只能退回列表第一项。
 */
function isSelector(type: string): boolean {
  const normalized = type.toLowerCase()
  return normalized === 'select' || normalized === 'selector'
}

/**
 * 当前真正生效的节点：优先第一个有 `now` 的手选组（Selector），
 * 否则退回第一个有 `now` 的组（URLTest / fallback 的自动结果）。
 *
 * `GLOBAL` 不参与：它只在全局模式下有意义，且内核总是把它排在用户策略组前面，
 * 普通配置下会让「当前节点」显示成 GLOBAL / DIRECT。
 *
 * `delay` 取该组选中节点在视图里的 `delay`——主进程已经把节点 `history` 的最后一条
 * 折算进这个字段，渲染层不再访问上游原文。
 */
export function pickActiveProxy(groups: ProxyGroupView[]): ActiveProxy | null {
  const selected = groups.filter(
    (group) => group.now !== '' && group.name.toUpperCase() !== 'GLOBAL'
  )
  if (selected.length === 0) return null
  const group = selected.find((entry) => isSelector(entry.type)) ?? selected[0]
  if (group === undefined) return null
  const node = group.nodes.find((entry) => entry.name === group.now)
  const active: ActiveProxy = { group: group.name, node: group.now }
  if (node?.delay !== undefined) active.delay = node.delay
  return active
}
