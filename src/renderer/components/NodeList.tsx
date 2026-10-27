import { useId, useState } from 'react'
import type { ProxyGroupView } from '../../shared/ipc'
import { copy } from '../copy'
import { formatDelay } from '../format'
import { effectiveSelection } from '../selectors'

export interface NodeListProps {
  groups: ProxyGroupView[]
  /** 点了某个组里的节点：参数是该组的名字与该组内的节点名。 */
  onSelect?(group: string, node: string): void
}

/** `GLOBAL` 只在全局模式下有意义，默认折叠；其它组默认展开。 */
function isGlobal(name: string): boolean {
  return name.toUpperCase() === 'GLOBAL'
}

/**
 * 策略组列表：组头是真正的 disclosure，节点是组内的真实按钮。
 *
 * 选中态**只**来自内核事实（`fixed || now`），不来自点击——切换请求可能被内核拒绝，
 * 界面不能先自己认账。URLTest 等自动组里 `PUT` 只改 `fixed` 不改 `now`，所以两者
 * 必须用同一个有效选中值，否则点击成功却永远看不到选中态。展开状态则相反，是纯粹的
 * 本地 UI 状态：用覆盖表记录用户手动开合过的组，未记录的组按名字决定默认值，
 * 这样首轮轮询后到达的组也能拿到正确默认值。
 */
export function NodeList({ groups, onSelect }: NodeListProps) {
  const baseId = useId()
  const [overrides, setOverrides] = useState<Record<string, boolean>>({})

  return (
    <div className="node-groups">
      {groups.map((group, index) => {
        const expanded = overrides[group.name] ?? !isGlobal(group.name)
        const panelId = `${baseId}-panel-${index}`
        return (
          <section className="node-group" key={`${group.name}-${index}`}>
            <button
              type="button"
              className="node-group-head"
              aria-expanded={expanded}
              aria-controls={panelId}
              onClick={() => {
                setOverrides((previous) => ({ ...previous, [group.name]: !expanded }))
              }}
            >
              <span className="node-group-chevron" aria-hidden="true">
                {expanded ? '▾' : '▸'}
              </span>
              <span className="node-group-name">{group.name}</span>
              <span className="node-group-count">{copy.nodes.count(group.nodes.length)}</span>
            </button>
            {/* 折叠用 hidden 而不是不渲染：`aria-controls` 始终指向存在的元素，
                被 `hidden` 的内容也不进无障碍树，键盘到不了。 */}
            <div
              className="node-group-body"
              id={panelId}
              role="group"
              aria-label={group.name}
              hidden={!expanded}
            >
              {group.nodes.map((node) => {
                const selected = effectiveSelection(group) === node.name
                return (
                  <button
                    key={node.name}
                    type="button"
                    className="node-row"
                    aria-pressed={selected}
                    onClick={() => onSelect?.(group.name, node.name)}
                  >
                    {/* 选中标记是状态点：占位始终保留，未选中时不可见，行首因此不会左右抖动。 */}
                    <span className="node-row-mark" aria-hidden="true" />
                    <span className="node-row-name">{node.name}</span>
                    <span className="node-row-delay">{formatDelay(node.delay)}</span>
                  </button>
                )
              })}
            </div>
          </section>
        )
      })}
    </div>
  )
}
