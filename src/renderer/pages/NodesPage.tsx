import { useState } from 'react'
import type { ProxyGroupView } from '../../shared/ipc'
import { NodeList } from '../components/NodeList'
import { copy } from '../copy'

export interface NodesPageProps {
  /** 由 App 轮询后传入：本页不再自己开第二个轮询器。 */
  groups: ProxyGroupView[]
}

/**
 * 节点页：按策略组列出节点，点击即切换。
 *
 * 成功时什么都不做——下一次 `getProxies` 轮询把新的 `now` 或 `fixed` 带回来，
 * 选中态自然跟上。自动组（URLTest / Fallback / LoadBalance）里内核只把选择写进
 * `fixed`、不改 `now`，所以 NodeList 用 `fixed || now` 作为有效选中值；保留可点击
 * 是因为钉选节点是这些组的真实能力，选中点会如实跟随 `fixed`。
 * 提前把点击目标画成选中会造成「界面说切了、内核没切」的假象；失败时只留一行错误，
 * 选中态仍然只反映内核给的事实。
 */
export function NodesPage({ groups }: NodesPageProps) {
  const [error, setError] = useState<string | null>(null)

  async function select(group: string, node: string): Promise<void> {
    const api = window.aether
    if (api === undefined) {
      setError(copy.nodes.switchFailed)
      return
    }
    setError(null)
    try {
      const result = await api.switchNode({ group, node })
      if (!result.ok) setError(copy.nodes.switchFailed)
    } catch {
      setError(copy.nodes.switchFailed)
    }
  }

  return (
    <section className="nodes-page" aria-label={copy.nodes.label}>
      {error !== null && (
        <p className="nodes-error" role="alert">
          {error}
        </p>
      )}
      {groups.length === 0 ? (
        <p className="nodes-empty">{copy.nodes.empty}</p>
      ) : (
        <NodeList
          groups={groups}
          onSelect={(group, node) => {
            void select(group, node)
          }}
        />
      )}
    </section>
  )
}
