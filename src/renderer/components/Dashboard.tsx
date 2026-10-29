import type { AppStatusView, DialFailureCounts } from '../../shared/ipc'
import type { ConnectionSummary } from '../hooks/useConnections'
import type { StatsCurrent, TrafficSample } from '../hooks/useStats'
import type { ActiveProxy } from '../selectors'
import { CoreCard } from './CoreCard'
import { NodeCard } from './NodeCard'
import { StatCards } from './StatCards'
import { TrafficChart } from './TrafficChart'

export interface DashboardProps {
  status: AppStatusView | null
  active: ActiveProxy | null
  current: StatsCurrent | null
  history: TrafficSample[]
  /** 连接快照摘要：活跃数、缓冲条数、内核内存与保留窗口；没有采集器时数字为 null。 */
  connections: ConnectionSummary
  /** 拨号失败滚动计数；`null` 表示没有计数来源（内核未运行），不是零次失败。 */
  dialFailures: DialFailureCounts | null
  /** 失败计数可点时的去向：日志页。 */
  onViewLogs?: () => void
}

/** 卡片场：三列等宽，hero 占 2、内核占 1，三张速率卡各占 1，流量图跨满三列。 */
export function Dashboard({
  status,
  active,
  current,
  history,
  connections,
  dialFailures,
  onViewLogs
}: DashboardProps) {
  const mode = status === null ? null : status.mode
  const startedAt = status?.core?.startedAt
  /**
   * 只有 ready 才有真实的会话、速率与健康数据。内核崩溃重连期间，残留的上一份
   * 推送不是当前事实：速率必须是破折号，节点/会话/失败计数都退回未知。
   */
  const live = status?.status === 'ready'

  return (
    <div className="card-grid">
      <NodeCard
        active={live ? active : null}
        mode={mode}
        {...(startedAt === undefined ? {} : { startedAt })}
        totals={
          !live || current === null
            ? null
            : { upTotal: current.upTotal, downTotal: current.downTotal }
        }
        dialFailures={live ? dialFailures : null}
        {...(onViewLogs === undefined ? {} : { onViewLogs })}
      />
      <CoreCard status={status} memory={connections.memory} />
      <StatCards
        current={live ? current : null}
        active={connections.active}
        total={connections.total}
        retainMs={connections.retainMs}
      />
      <TrafficChart history={history} connected={status?.status === 'ready'} />
    </div>
  )
}
