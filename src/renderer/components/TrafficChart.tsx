import { copy } from '../copy'
import { formatRate } from '../format'
import type { TrafficSample } from '../hooks/useStats'

export interface TrafficChartProps {
  history: TrafficSample[]
  /** 内核是否在跑：决定空图时的说明是「启动内核后」还是「暂无流量」。 */
  connected?: boolean
}

/** 与视觉稿一致的坐标系；`preserveAspectRatio="none"` 让曲线随卡片宽度拉伸。 */
export const CHART_WIDTH = 1000
export const CHART_HEIGHT = 190
const TOP_PADDING = 10

interface Point {
  x: number
  y: number
}

function isRate(value: number): boolean {
  return Number.isFinite(value) && value >= 0
}

/**
 * 把一串样本折成坐标点。点数恒等于样本数（每个样本一个点）；空样本返回空数组，
 * 由调用方画基线而不是画一条归零的假曲线。
 *
 * `peak` 由两条线共用：各自归一化会让 20 KB/s 的上传和 2 MB/s 的下载一样高，
 * 一眼看过去就是假的。空样本或全零时曲线压在底边——那是测得的零。
 */
export function chartPoints(
  samples: TrafficSample[],
  key: 'up' | 'down',
  peak: number
): Point[] {
  if (samples.length === 0) return []
  const usable = CHART_HEIGHT - TOP_PADDING
  const step = samples.length === 1 ? 0 : CHART_WIDTH / (samples.length - 1)
  const safePeak = isRate(peak) && peak > 0 ? peak : 0

  return samples.map((sample, index) => {
    const value = sample[key]
    const ratio = safePeak === 0 ? 0 : (isRate(value) ? value : 0) / safePeak
    return {
      x: Number((index * step).toFixed(2)),
      y: Number((CHART_HEIGHT - ratio * usable).toFixed(2))
    }
  })
}

/** `M` + `L` 序列；空数组返回空串（渲染层只画基线），绝不产出 `NaN`。 */
export function pathOf(points: Point[]): string {
  if (points.length === 0) return ''
  return points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x},${point.y}`)
    .join(' ')
}

/** 下载面积：折线 + 回到底边的闭合路径；没有点时返回空串。 */
export function areaPathOf(points: Point[]): string {
  if (points.length === 0) return ''
  const last = points[points.length - 1]
  if (last === undefined) return ''
  return `${pathOf(points)} L${last.x},${CHART_HEIGHT} L0,${CHART_HEIGHT} Z`
}

function peakOf(history: TrafficSample[]): number {
  return history.reduce(
    (max, sample) => (isRate(sample.down) && sample.down > max ? sample.down : max),
    0
  )
}

/** 两条线共用的纵轴峰值：取上下行里较大的那个，保证相对高度是真的。 */
function scalePeakOf(history: TrafficSample[]): number {
  return history.reduce((max, sample) => {
    const down = isRate(sample.down) ? sample.down : 0
    const up = isRate(sample.up) ? sample.up : 0
    return Math.max(max, down, up)
  }, 0)
}

function averageOf(history: TrafficSample[]): number {
  if (history.length === 0) return 0
  const total = history.reduce((sum, sample) => sum + (isRate(sample.down) ? sample.down : 0), 0)
  return total / history.length
}

const GRID_LINES = [20, 65, 110, 155]

/**
 * 最近 60 个样本的双折线。空历史只画三条网格与一条基线，并给出一句说明：
 * 「还没测到」与「测到的是 0」在界面上是两件事。
 */
export function TrafficChart({ history, connected = true }: TrafficChartProps) {
  const peak = scalePeakOf(history)
  const downPoints = chartPoints(history, 'down', peak)
  const upPoints = chartPoints(history, 'up', peak)
  const empty = history.length === 0
  const baseline = CHART_HEIGHT - 1

  return (
    <section className={empty ? 'card chart empty' : 'card chart'}>
      <div className="chart-head">
        <span className="chart-title">{copy.dashboard.chart.title}</span>
        {!empty && (
          <>
            <span className="chip solid">
              {copy.dashboard.chart.peak} {formatRate(peakOf(history))}
            </span>
            <span className="chip solid">
              {copy.dashboard.chart.average} {formatRate(averageOf(history))}
            </span>
          </>
        )}
        <span className="chart-legend">
          <span className="legend-down">
            <i />
            {copy.dashboard.chart.downLegend}
          </span>
          <span className="legend-up">
            <i />
            {copy.dashboard.chart.upLegend}
          </span>
        </span>
      </div>

      <svg
        className="chart-svg"
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={copy.dashboard.chart.label}
        data-testid="chart"
      >
        <g className="chart-grid">
          {GRID_LINES.map((y) => (
            <line key={y} x1={0} y1={y} x2={CHART_WIDTH} y2={y} />
          ))}
        </g>
        {empty ? (
          <line
            className="chart-baseline"
            x1={0}
            y1={baseline}
            x2={CHART_WIDTH}
            y2={baseline}
            data-testid="chart-baseline"
          />
        ) : (
          <>
            <path className="chart-area" d={areaPathOf(downPoints)} />
            <path className="chart-down" d={pathOf(downPoints)} data-testid="down-line" />
            <path className="chart-up" d={pathOf(upPoints)} data-testid="up-line" />
          </>
        )}
      </svg>

      {empty && (
        <div className="chart-note">
          {connected ? copy.dashboard.chart.idleNote : copy.dashboard.chart.offlineNote}
        </div>
      )}
    </section>
  )
}
