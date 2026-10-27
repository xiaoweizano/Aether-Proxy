import type { DialFailureCounts } from '../../shared/ipc'
import type { Mode } from '../../shared/types'
import { copy } from '../copy'
import { formatBytes, formatDuration, formatWindow, UNKNOWN } from '../format'
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
  /** 拨号失败滚动计数；`null` 表示没有计数来源（内核未运行），不是零次失败。 */
  dialFailures: DialFailureCounts | null
  /** 点击失败计数时的去向；缺省时计数仍显示，只是不可点。 */
  onViewLogs?: () => void
}

const TICK_COUNT = 60

const MODE_LABEL: Record<Mode, string> = {
  rule: copy.mode.rule,
  global: copy.mode.global,
  direct: copy.mode.direct
}

/**
 * 60 格刻度条。DESIGN.md 的刻度条靠「高度表示失败分钟、颜色表示健康」，
 * 而滚动计数只有一个小时间隔的总数，没有逐分钟记录；因此任何一格涂绿或压矮
 * 都会是编造。整条一律保持无历史的 dim 形态。
 */
function TickStrip() {
  const ticks = Array.from({ length: TICK_COUNT }, (_, index) => index)
  return (
    <div className="ticks dim" aria-hidden="true" data-testid="tick-strip">
      {ticks.map((index) => (
        <span key={index} className="tick" />
      ))}
    </div>
  )
}

/** `windowMs` 非法时文案退化为未知，绝不编造一个窗口长度。 */
function windowLabel(dialFailures: DialFailureCounts): string | null {
  const label = formatWindow(dialFailures.windowMs)
  return label === UNKNOWN ? null : label
}

export function NodeCard({
  active,
  mode,
  startedAt,
  totals,
  now,
  dialFailures,
  onViewLogs
}: NodeCardProps) {
  const live = active !== null
  const delay = active?.delay
  const delayText =
    delay === undefined || !Number.isFinite(delay) ? null : copy.dashboard.node.healthDelay(`${delay}ms`)

  /**
   * 三种健康态，区别是「我们知道什么」：
   * - 没有计数来源（null）：计数未知，用 `healthUnknown`（唯一写死窗口的一句，
   *   因为它后面没有可推导的计数）；
   * - 有来源且窗口内零次失败：零不等于健康，值仍是破折号，窗口由 `windowMs` 推导；
   * - 有真实失败：窗口与次数都来自计数，次数可点，去日志看是哪一条。
   *
   * `recent` 非整数时整条丢弃：`1.5 次失败` 不是任何真实观测。
   */
  const valid = dialFailures !== null && Number.isInteger(dialFailures.recent) && dialFailures.recent >= 0
  const windowMs = valid ? windowLabel(dialFailures) : null
  const count = valid ? dialFailures.recent : 0
  const countsText =
    !valid || windowMs === null
      ? copy.dashboard.node.healthUnknown
      : count > 0
        ? copy.dashboard.node.healthFailures(windowMs, count)
        : copy.dashboard.node.healthNoFailures(windowMs)
  const canOpenLogs = valid && windowMs !== null && count > 0

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
        {!live ? (
          <span>{copy.dashboard.node.noSession}</span>
        ) : (
          /* 计数与延迟是同一句话的两段，用 4px 收紧；外层 8px 留给右侧百分比。 */
          <span className="health-counts">
            {canOpenLogs && onViewLogs !== undefined ? (
              <button
                type="button"
                className="health-action"
                aria-label={copy.dashboard.node.healthFailuresAction(countsText)}
                onClick={onViewLogs}
              >
                {countsText}
              </button>
            ) : (
              <span>{countsText}</span>
            )}
            {delayText !== null && <span>{delayText}</span>}
          </span>
        )}
        {/* 健康百分比需要逐分钟的成功/失败记录；滚动计数给不出，所以保持未知。 */}
        <span className="health-pct muted">{UNKNOWN}</span>
      </div>
      <TickStrip />

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
