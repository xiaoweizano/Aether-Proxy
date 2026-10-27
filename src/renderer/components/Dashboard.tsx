import type { AppStatusView, DialFailureCounts } from '../../shared/ipc'
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
  /** 拨号失败滚动计数；`null` 表示没有计数来源（内核未运行），不是零次失败。 */
  dialFailures: DialFailureCounts | null
  /** 失败计数可点时的去向：日志页。 */
  onViewLogs?: () => void
}

/** 卡片场：三列等宽，hero 占 2、内核占 1，三张速率卡各占 1，流量图跨满三列。 */
export function Dashboard({ status, active, current, history, dialFailures, onViewLogs }: DashboardProps) {
  const mode = status === null ? null : status.mode
  const startedAt = status?.core?.startedAt

  return (
    <div className="card-grid">
      <NodeCard
        active={active}
        mode={mode}
        {...(startedAt === undefined ? {} : { startedAt })}
        totals={current === null ? null : { upTotal: current.upTotal, downTotal: current.downTotal }}
        dialFailures={dialFailures}
        {...(onViewLogs === undefined ? {} : { onViewLogs })}
      />
      <CoreCard status={status} />
      <StatCards current={current} />
      <TrafficChart history={history} connected={status?.status === 'ready'} />
    </div>
  )
}
