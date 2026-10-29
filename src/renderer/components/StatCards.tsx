import { copy } from '../copy'
import { formatBytes, formatRateParts, formatWindow, UNKNOWN } from '../format'
import type { StatsCurrent } from '../hooks/useStats'

export interface StatCardsProps {
  /**
   * 没有任何推送时传 null，速率显示破折号；只要有推送，`down === 0` 就是测得的零，
   * 显示 `0.00 MB/s`。两者不可互换。
   */
  current: StatsCurrent | null
  /** 活跃连接数（不含保留期内的已结束行）；没有采集器时为 null，显示破折号。 */
  active: number | null
  /** 缓冲内条目总数（含已结束行）；没有采集器时为 null。 */
  total: number | null
  /** 已结束连接的保留窗口（毫秒）；没有采集器时为 null。 */
  retainMs: number | null
}

function footFor(total: number | undefined): string {
  return `${copy.dashboard.stats.totalPrefix} ${total === undefined ? UNKNOWN : formatBytes(total)}`
}

function ConnectionFigure({ active }: { active: number | null }) {
  if (active === null) {
    return <div className="stat-figure muted">{UNKNOWN}</div>
  }
  return <div className="stat-figure">{active}</div>
}

function RateFigure({ rate }: { rate: { value: string; unit: string } | null }) {
  if (rate === null) {
    return <div className="stat-figure muted">{UNKNOWN}</div>
  }
  return (
    <div className="stat-figure">
      {rate.value}
      {rate.unit !== '' && <span className="stat-unit">{rate.unit}</span>}
    </div>
  )
}

/**
 * 三张速率卡：下载、上传、活跃连接。连接数与页脚都来自同一份 `/connections` 快照：
 * 活跃数只数 `ended === false` 的行，页脚的条数包含保留期内的已结束行，窗口长度由
 * `retainMs` 推导。没有采集器时连接数是未知（破折号），不是 0。
 */
export function StatCards({ current, active, total, retainMs }: StatCardsProps) {
  const down = current === null ? null : formatRateParts(current.down)
  const up = current === null ? null : formatRateParts(current.up)
  const connectionFoot =
    total === null || retainMs === null
      ? copy.dashboard.stats.connectionsFootUnknown
      : copy.dashboard.stats.connectionsFoot(total, formatWindow(retainMs))

  return (
    <>
      <section className="card stat">
        <div className="stat-head">
          <span className="badge down" aria-hidden="true">
            ↓
          </span>
          {copy.dashboard.stats.down}
        </div>
        <RateFigure rate={down} />
        <div className="stat-foot">{footFor(current?.downTotal)}</div>
      </section>

      <section className="card stat">
        <div className="stat-head">
          <span className="badge up" aria-hidden="true">
            ↑
          </span>
          {copy.dashboard.stats.up}
        </div>
        <RateFigure rate={up} />
        <div className="stat-foot">{footFor(current?.upTotal)}</div>
      </section>

      <section className="card stat">
        <div className="stat-head">
          <span className="badge conn" aria-hidden="true">
            ◉
          </span>
          {copy.dashboard.stats.connections}
        </div>
        <ConnectionFigure active={active} />
        <div className="stat-foot">{connectionFoot}</div>
      </section>
    </>
  )
}
