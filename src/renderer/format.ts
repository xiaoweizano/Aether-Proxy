/** 数值格式化的唯一出口；所有未知/非法值统一显示破折号，绝不出现 NaN。 */

export const UNKNOWN = '—'

const KB = 1024
const BYTE_UNITS = ['KB', 'MB', 'GB', 'TB'] as const

/** 速率单位固定在 MB/s；界面把数值与单位分开排版，因此单独暴露。 */
export const RATE_UNIT = 'MB/s'

function isCount(value: number): boolean {
  return Number.isFinite(value) && value >= 0
}

/** 字节数：`512 B` / `1.0 KB` / `1.2 MB`；零是真实零值，写 `0 B`。 */
export function formatBytes(bytes: number): string {
  if (!isCount(bytes)) return UNKNOWN
  if (bytes < KB) return `${Math.round(bytes)} B`
  let value = bytes / KB
  let unit = 0
  while (value >= KB && unit < BYTE_UNITS.length - 1) {
    value /= KB
    unit += 1
  }
  return `${value.toFixed(1)} ${BYTE_UNITS[unit]}`
}

/** 速率统一用 MB/s，固定两位小数：`0.00 MB/s` 表示测得的零，不是缺失。 */
export function formatRate(bytesPerSecond: number): string {
  const parts = formatRateParts(bytesPerSecond)
  return parts.unit === '' ? parts.value : `${parts.value} ${parts.unit}`
}

/** 同上，但数值与单位分开返回，供大字号 + 小单位后缀排版使用。 */
export function formatRateParts(bytesPerSecond: number): { value: string; unit: string } {
  if (!isCount(bytesPerSecond)) return { value: UNKNOWN, unit: '' }
  return { value: (bytesPerSecond / (KB * KB)).toFixed(2), unit: RATE_UNIT }
}

/** 时长 `HH:MM:SS`，小时不封顶（长时间会话保持可读）。 */
export function formatDuration(ms: number): string {
  if (!isCount(ms)) return UNKNOWN
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

/**
 * 节点延迟：`38ms`。没有测速记录（`undefined`）时是未知，不是 0ms——
 * 从没测过和测得 0 毫秒是两件事。
 */
export function formatDelay(delay: number | undefined): string {
  if (delay === undefined || !Number.isFinite(delay) || delay < 0) return UNKNOWN
  return `${delay}ms`
}

/** 本地时间 `HH:MM:SS`；用本地时区，避免把内核启动时间显示成 UTC。 */
export function formatClock(at: number): string {
  if (!Number.isFinite(at)) return UNKNOWN
  const date = new Date(at)
  const part = (value: number): string => String(value).padStart(2, '0')
  return `${part(date.getHours())}:${part(date.getMinutes())}:${part(date.getSeconds())}`
}

/**
 * 滚动窗口长度（`windowMs`）的人类可读写法：`60 分钟` / `30 秒`。
 * 失败计数的文案必须由它推导：窗口改过一次，写死的分钟数就会说谎。
 * 非法值或零窗口显示破折号，绝不退回到某个默认分钟数。
 */
export function formatWindow(windowMs: number): string {
  if (!isCount(windowMs) || windowMs <= 0) return UNKNOWN
  if (windowMs < 60_000) return `${Math.round(windowMs / 1000)} 秒`
  return `${Math.round(windowMs / 60_000)} 分钟`
}
