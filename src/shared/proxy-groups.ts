import type { ProxyGroupView } from './ipc'

/**
 * 策略组视图的只读推导：渲染层（节点页 / 仪表盘）与主进程（托盘）共用。
 * 放在 `src/shared` 是为了让主进程不必 import `src/renderer/` 里的模块，
 * 两边也不会各写一份「已选中节点」的判定而慢慢说不到一块去。
 */

/**
 * mihomo `/proxies` 返回的是 Go 类型名，不是 YAML 里的小写写法：
 * 手选组是 `Selector`（旧版本/部分配置也会写成 `select`），自动组是 `URLTest`
 * 等。比较必须忽略大小写，否则 `select` 永远匹配不到，只能退回列表第一项。
 */
export function isSelector(type: string): boolean {
  const normalized = type.toLowerCase()
  return normalized === 'select' || normalized === 'selector'
}

/**
 * 组的有效选中节点：自动组（URLTest / Fallback / LoadBalance）里 `PUT /proxies/<group>`
 * 只写 `fixed`，`now` 仍是自动测速的结果。用户钉住节点后，界面必须显示 `fixed`，
 * 否则点击「成功但选中态永不出现」。空串与缺失等价，都退回内核给的 `now`。
 */
export function effectiveSelection(group: Pick<ProxyGroupView, 'now' | 'fixed'>): string {
  return group.fixed !== undefined && group.fixed !== '' ? group.fixed : group.now
}

export interface ActiveProxy {
  group: string
  node: string
  /** 选中节点最近一次测速结果；没有测速记录时不带该字段。 */
  delay?: number
}

/**
 * 当前真正生效的节点：优先第一个有有效选中的手选组（Selector），
 * 否则退回第一个有有效选中的组（URLTest / fallback 的自动结果或钉选结果）。
 *
 * `GLOBAL` 不参与：它只在全局模式下有意义，且内核总是把它排在用户策略组前面，
 * 普通配置下会让「当前节点」显示成 GLOBAL / DIRECT。
 *
 * `delay` 取该组选中节点在视图里的 `delay`——主进程已经把节点 `history` 的最后一条
 * 折算进这个字段，渲染层不再访问上游原文。
 */
export function pickActiveProxy(groups: ProxyGroupView[]): ActiveProxy | null {
  const selected = groups
    .map((group) => ({ group, node: effectiveSelection(group) }))
    .filter((entry) => entry.node !== '' && entry.group.name.toUpperCase() !== 'GLOBAL')
  if (selected.length === 0) return null
  const picked = selected.find((entry) => isSelector(entry.group.type)) ?? selected[0]
  if (picked === undefined) return null
  const node = picked.group.nodes.find((entry) => entry.name === picked.node)
  const active: ActiveProxy = { group: picked.group.name, node: picked.node }
  if (node?.delay !== undefined) active.delay = node.delay
  return active
}
