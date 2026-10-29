/**
 * 8 小时长稳的判定逻辑（纯函数）。
 *
 * 规格 8.4：预热 30 分钟后每 5 分钟采样一次，**末小时中位数不超过首小时的 110%**。
 * 把「算中位数 / 取首末小时 / 判超标」放在这里而不是写进 `soak.mjs`，理由与
 * `memory.mjs` 相同：这里才是会悄悄算错的地方——窗口取错一位、中位数遇到偶数个
 * 样本时取上界而不是平均、首小时中位数为 0 时除零，都会让闸门永远「稳定」。
 *
 * 约定：
 * - 首小时 = 采样阶段最开始的 `hourSamples` 个样本；末小时 = 最后 `hourSamples` 个样本。
 * - 两个窗口必须**不重叠**，才有「首末比较」的意义。样本少于 `2 * hourSamples` 时
 *   判为「不可判定」，而不是拿重叠窗口硬比出一个结论。
 * - 退出码 2 专给「不可判定 / 没测到」：把「工具或时长不够」与「内存真的涨了」分开，
 *   与 `measure-memory.mjs` 的 0/1/2 约定一致。
 */

/** 5 分钟一次采样 → 一小时 12 个样本。 */
export const DEFAULT_SAMPLES_PER_HOUR = 12

/** 末小时中位数允许达到首小时的 110%。 */
export const DEFAULT_GROWTH_LIMIT = 1.1

export const SOAK_EXIT = Object.freeze({ STABLE: 0, EXCEEDED: 1, UNMEASURABLE: 2 })

/**
 * 中位数。偶数个样本取中间两个的平均值（不是取上界，也不是取下界）。
 * @param {number[]} values
 * @returns {number | null} 空数组返回 null，不返回 0——0 会伪装成一次有效测量
 */
export function median(values) {
  if (!Array.isArray(values) || values.length === 0) return null
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`中位数的输入必须全是有限数字，收到 ${JSON.stringify(value)}`)
    }
  }
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle]
  return (sorted[middle - 1] + sorted[middle]) / 2
}

/**
 * 把一个样本压成参与判定的总量（MB）。
 * @param {{ totalBytes: number }} sample
 * @returns {number}
 */
function totalMb(sample) {
  if (sample === null || typeof sample !== 'object') {
    throw new Error(`样本必须是对象，收到 ${JSON.stringify(sample)}`)
  }
  const bytes = sample.totalBytes
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
    throw new Error(`样本缺少可用的 totalBytes：${JSON.stringify(sample)}`)
  }
  return bytes / (1024 * 1024)
}

/**
 * 判定长稳结果。
 *
 * @param {{ totalBytes: number }[]} samples 采样阶段的样本，按时间先后排列
 * @param {{ hourSamples?: number, limit?: number }} [options]
 * @returns {{
 *   judgeable: boolean,
 *   reason: string,
 *   sampleCount: number,
 *   hourSamples: number,
 *   limit: number,
 *   firstMedian: number | null,
 *   lastMedian: number | null,
 *   ratio: number | null,
 *   exceeded: boolean,
 *   exitCode: 0 | 1 | 2
 * }}
 */
export function evaluateSoak(samples, options = {}) {
  const hourSamples = options.hourSamples ?? DEFAULT_SAMPLES_PER_HOUR
  const limit = options.limit ?? DEFAULT_GROWTH_LIMIT
  if (!Number.isInteger(hourSamples) || hourSamples < 1) {
    throw new Error(`hourSamples 必须是正整数，收到 ${JSON.stringify(hourSamples)}`)
  }
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error(`limit 必须是正数，收到 ${JSON.stringify(limit)}`)
  }

  const list = Array.isArray(samples) ? samples : []
  const sampleCount = list.length

  if (sampleCount < hourSamples * 2) {
    return {
      judgeable: false,
      reason:
        `样本只有 ${sampleCount} 个，首末小时需要至少 ${hourSamples * 2} 个（窗口不能重叠）；` +
        '这次运行无法判定内存是否长期稳定。',
      sampleCount,
      hourSamples,
      limit,
      firstMedian: null,
      lastMedian: null,
      ratio: null,
      exceeded: false,
      exitCode: SOAK_EXIT.UNMEASURABLE
    }
  }

  const firstMedian = median(list.slice(0, hourSamples).map(totalMb))
  const lastMedian = median(list.slice(-hourSamples).map(totalMb))
  // 首小时中位数为 0 时比值无意义：0 → 0 视为没涨，0 → 正数视为涨到无穷。
  const ratio =
    firstMedian === 0 ? (lastMedian === 0 ? 1 : Number.POSITIVE_INFINITY) : lastMedian / firstMedian
  const exceeded = lastMedian > firstMedian * limit

  return {
    judgeable: true,
    reason: exceeded
      ? `末小时中位数 ${lastMedian.toFixed(1)} MB 超过首小时 ${firstMedian.toFixed(1)} MB 的 ${(limit * 100).toFixed(0)}%`
      : `末小时中位数 ${lastMedian.toFixed(1)} MB 未超过首小时 ${firstMedian.toFixed(1)} MB 的 ${(limit * 100).toFixed(0)}%`,
    sampleCount,
    hourSamples,
    limit,
    firstMedian,
    lastMedian,
    ratio,
    exceeded,
    exitCode: exceeded ? SOAK_EXIT.EXCEEDED : SOAK_EXIT.STABLE
  }
}

export const CSV_HEADER = [
  'timestamp',
  'elapsed_minutes',
  'total_mb',
  'aether_mb',
  'mihomo_mb',
  'aether_count',
  'mihomo_count',
  'foreign_mb',
  'missing'
].join(',')

/**
 * 一个采样点 → 一行 CSV。分隔符里的逗号只可能出现在 `missing` 里，
 * 所以只对它做引号包裹；其余字段都是数字或 ISO 时间。
 * @param {{
 *   timestamp: string,
 *   elapsedMinutes: number,
 *   summary: ReturnType<import('./memory.mjs').summariseMemory>
 * }} sample
 * @returns {string}
 */
export function toCsvRow({ timestamp, elapsedMinutes, summary }) {
  const mb = (bytes) => (bytes / (1024 * 1024)).toFixed(1)
  const fields = [
    timestamp,
    elapsedMinutes.toFixed(1),
    mb(summary.totalBytes),
    mb(summary.byFamily['Aether.exe'].bytes),
    mb(summary.byFamily['mihomo.exe'].bytes),
    String(summary.byFamily['Aether.exe'].count),
    String(summary.byFamily['mihomo.exe'].count),
    mb(summary.foreign.reduce((sum, entry) => sum + entry.bytes, 0)),
    summary.missingFamilies.join(' ')
  ]
  return fields
    .map((field, index) => (index === fields.length - 1 && field.includes(',') ? `"${field}"` : field))
    .join(',')
}
