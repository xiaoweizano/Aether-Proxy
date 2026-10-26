import type { Mode } from '../../shared/types'
import { copy } from '../copy'
import { formatBytes, formatDuration, UNKNOWN } from '../format'
import type { ActiveProxy } from '../selectors'

export interface NodeCardProps {
  active: ActiveProxy | null
  mode: Mode | null
  /** 内核启动时间；缺省时会话时长显示破折号。 */
  startedAt?: number
  /** 累计流量；缺省时已用流量显示破折号。 */
  totals?: { upTotal: number; downTotal: number } | null
  /** 计算会话时长的时钟，测试可注入固定值。 */
  now?: number
}

const TICK_COUNT = 60

const MODE_LABEL: Record<Mode, string> = {
  rule: copy.mode.rule,
  global: copy.mode.global,
  direct: copy.mode.direct
}

/** 没有节点就没有历史：整条刻度变暗，不能把「无数据」画成「全绿」。 */
function TickStrip({ live }: { live: boolean }) {
  const ticks = Array.from({ length: TICK_COUNT }, (_, index) => index)
  return (
    <div className={live ? 'ticks' : 'ticks dim'} aria-hidden="true" data-testid="tick-strip">
      {ticks.map((index) => (
        <span key={index} className="tick" />
      ))}
    </div>
  )
}

export function NodeCard({ active, mode, startedAt, totals, now }: NodeCardProps) {
  const live = active !== null
  const delay = active?.delay
  const session =
    startedAt === undefined ? UNKNOWN : formatDuration(Math.max(0, (now ?? Date.now()) - startedAt))
  const used = totals === undefined || totals === null ? UNKNOWN : formatBytes(totals.upTotal + totals.downTotal)
  const modeLabel = mode === null ? UNKNOWN : MODE_LABEL[mode]

  return (
    <section className="card hero">
      <div className="label-row">
        <span className="card-label">{copy.dashboard.node.label}</span>
      </div>

      <div className="node-line">
        <b className={live ? 'node-name' : 'node-name muted'}>{active?.node ?? UNKNOWN}</b>
        {active !== null && <span className="chip">{active.group}</span>}
      </div>
      <div className="hero-sub">{mode === null ? UNKNOWN : copy.dashboard.node.sub(MODE_LABEL[mode])}</div>

      <div className="healthline">
        <span>
          {live
            ? copy.dashboard.node.health(delay === undefined ? UNKNOWN : `${delay}ms`)
            : copy.dashboard.node.noSession}
        </span>
        <span className={live ? 'health-pct' : 'health-pct muted'}>
          {live ? copy.dashboard.node.healthRate : UNKNOWN}
        </span>
      </div>
      <TickStrip live={live} />

      <div className="stats3">
        <div>
          <div className="stat-key">{copy.dashboard.node.session}</div>
          <div className={startedAt === undefined ? 'stat-value muted' : 'stat-value'}>{session}</div>
        </div>
        <div>
          <div className="stat-key">{copy.dashboard.node.used}</div>
          <div className={used === UNKNOWN ? 'stat-value muted' : 'stat-value'}>{used}</div>
        </div>
        <div>
          <div className="stat-key">{copy.dashboard.node.mode}</div>
          <div className={mode === null ? 'stat-value muted' : 'stat-value'}>{modeLabel}</div>
        </div>
      </div>
    </section>
  )
}
