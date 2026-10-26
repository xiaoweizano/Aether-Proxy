import type { AppStatusView } from '../../shared/ipc'
import { copy } from '../copy'
import { formatClock, UNKNOWN } from '../format'

export interface CoreCardProps {
  status: AppStatusView | null
}

/** 内核状态：版本、三个事实 chip、启动时间与守护状态；缺一项就显示破折号。 */
export function CoreCard({ status }: CoreCardProps) {
  const core = status?.core
  const running = core !== undefined && status?.status !== 'core-error'
  const version = core?.version ?? UNKNOWN
  const port = core === undefined ? UNKNOWN : String(core.proxyPort)
  const groupCount = status?.profile?.groupCount
  const startedAt = core === undefined ? UNKNOWN : formatClock(core.startedAt)

  return (
    <section className="card core">
      <div className="label-row">
        <span className="card-label">{copy.dashboard.core.label}</span>
      </div>

      <div className={core === undefined ? 'core-version muted' : 'core-version'}>
        {copy.dashboard.core.version(version)}
      </div>

      <div className="chips">
        <span className={running ? 'chip solid on' : 'chip solid muted'}>
          {running ? copy.dashboard.core.running : copy.dashboard.core.stopped}
        </span>
        <span className={core === undefined ? 'chip solid muted' : 'chip solid'}>
          {copy.dashboard.core.port(port)}
        </span>
        <span className={groupCount === undefined ? 'chip solid muted' : 'chip solid'}>
          {copy.dashboard.core.groups(groupCount === undefined ? UNKNOWN : String(groupCount))}
        </span>
      </div>

      <div className="core-rows">
        <div>
          <span>{copy.dashboard.core.startedAt}</span>
          <b className={core === undefined ? 'muted' : undefined}>{startedAt}</b>
        </div>
        <div>
          <span>{copy.dashboard.core.guard}</span>
          <b className={core === undefined ? 'muted' : undefined}>
            {core === undefined ? UNKNOWN : copy.dashboard.core.guardOk}
          </b>
        </div>
      </div>
    </section>
  )
}
