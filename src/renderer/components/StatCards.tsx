import { copy } from '../copy'
import { formatBytes, formatRateParts, UNKNOWN } from '../format'
import type { StatsCurrent } from '../hooks/useStats'

export interface StatCardsProps {
  /**
   * 没有任何推送时传 null，速率显示破折号；只要有推送，`down === 0` 就是测得的零，
   * 显示 `0.00 MB/s`。两者不可互换。
   */
  current: StatsCurrent | null
}

function footFor(total: number | undefined): string {
  return `${copy.dashboard.stats.totalPrefix} ${total === undefined ? UNKNOWN : formatBytes(total)}`
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
 * 三张速率卡：下载、上传、活跃连接。连接数要等连接页那一份计划，
 * 本轮显示破折号并注明来源，不用 0 假装已知。
 */
export function StatCards({ current }: StatCardsProps) {
  const down = current === null ? null : formatRateParts(current.down)
  const up = current === null ? null : formatRateParts(current.up)

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
        <div className="stat-figure muted">{UNKNOWN}</div>
        <div className="stat-foot">{copy.dashboard.stats.connectionsFoot}</div>
      </section>
    </>
  )
}
