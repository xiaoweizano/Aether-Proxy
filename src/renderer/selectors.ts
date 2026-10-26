import type { ProxyGroupView } from '../shared/ipc'

export interface ActiveProxy {
  group: string
  node: string
  /** 选中节点最近一次测速结果；没有测速记录时不带该字段。 */
  delay?: number
}

/**
 * 当前真正生效的节点：优先第一个有 `now` 的 `select` 组（用户手选的策略组），
 * 否则退回第一个有 `now` 的组（url-test / fallback 的自动结果）。
 *
 * `delay` 取该组选中节点在视图里的 `delay`——主进程已经把节点 `history` 的最后一条
 * 折算进这个字段，渲染层不再访问上游原文。
 */
export function pickActiveProxy(groups: ProxyGroupView[]): ActiveProxy | null {
  const selected = groups.filter((group) => group.now !== '')
  if (selected.length === 0) return null
  const group = selected.find((entry) => entry.type === 'select') ?? selected[0]
  if (group === undefined) return null
  const node = group.nodes.find((entry) => entry.name === group.now)
  const active: ActiveProxy = { group: group.name, node: group.now }
  if (node?.delay !== undefined) active.delay = node.delay
  return active
}
