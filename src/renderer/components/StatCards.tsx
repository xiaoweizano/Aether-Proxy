import { copy } from '../copy'
import { formatBytes, formatRateParts, UNKNOWN } from '../format'
import type { StatsCurrent } from '../hooks/useStats'

export interface StatCardsProps {
  /** 没有任何推送时传 null；速率仍显示 0.00，因为「当前为 0」是测得的零。 */
  current: StatsCurrent | null
}

function footFor(total: number | undefined): string {
  return `${copy.dashboard.stats.totalPrefix} ${total === undefined ? UNKNOWN : formatBytes(total)}`
}

/**
 * 三张速率卡：下载、上传、活跃连接。连接数要等连接页那一份计划，
 * 本轮显示破折号并注明来源，不用 0 假装已知。
 */
export function StatCards({ current }: StatCardsProps) {
  const down = formatRateParts(current?.down ?? 0)
  const up = formatRateParts(current?.up ?? 0)

  return (
    <>
      <section className="card stat">
        <div className="stat-head">
          <span className="badge down" aria-hidden="true">
            ↓
          </span>
          {copy.dashboard.stats.down}
        </div>
        <div className="stat-figure">
          {down.value}
          {down.unit !== '' && <span className="stat-unit">{down.unit}</span>}
        </div>
        <div className="stat-foot">{footFor(current?.downTotal)}</div>
      </section>

      <section className="card stat">
        <div className="stat-head">
          <span className="badge up" aria-hidden="true">
            ↑
          </span>
          {copy.dashboard.stats.up}
        </div>
        <div className="stat-figure">
          {up.value}
          {up.unit !== '' && <span className="stat-unit">{up.unit}</span>}
        </div>
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
