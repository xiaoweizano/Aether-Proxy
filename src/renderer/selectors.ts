import type { ConnectionView } from '../shared/ipc'
import { UNKNOWN } from './format'

/**
 * 策略组推导（`effectiveSelection` / `pickActiveProxy` / `isSelector`）已经搬到
 * `src/shared/proxy-groups.ts`：主进程的托盘要用同一套判定，而主进程不得
 * import `src/renderer/`。这里原样转出，渲染层的导入路径保持不变。
 */
export { effectiveSelection, isSelector, pickActiveProxy } from '../shared/proxy-groups'
export type { ActiveProxy } from '../shared/proxy-groups'

/** 连接表六列的身份与顺序，和设计文档「行解剖」一致。文案在 copy.ts。 */
export const connectionHeaders = ['time', 'process', 'host', 'outbound', 'traffic', 'duration'] as const
export type ConnectionHeader = (typeof connectionHeaders)[number]

/** 域名中间省略的字符上限；设计文档要求至少保留 24 个字符。 */
export const MIDDLE_TRUNCATE_LIMIT = 32

/**
 * 域名这类「头尾信息量大于中间」的字符串用中间省略。
 * 保留头尾、中间放一个省略号，结果长度不超过 `limit`。
 */
export function truncateMiddle(value: string, limit = MIDDLE_TRUNCATE_LIMIT): string {
  if (!Number.isFinite(limit) || limit < 2) return value.length <= limit ? value : '…'
  // 按码点切分：`slice` 作用在 UTF-16 码元上，会把 astral 字符（emoji）劈成半个。
  const characters = Array.from(value)
  if (characters.length <= limit) return value
  const keep = limit - 1
  const tail = Math.floor(keep / 2)
  const head = keep - tail
  // tail 为 0 时 `slice(-0)` 会返回整个字符串，必须单独处理。
  if (tail === 0) return `${characters.slice(0, head).join('')}…`
  return `${characters.slice(0, head).join('')}…${characters.slice(-tail).join('')}`
}

/**
 * 出站链路：`chains` 在 Task 1 已反转为「最外层策略组 → 实际出站」，
 * 这里直接取首尾两段，**不再反转**。三段及以上用省略号表示中间层。
 */
export function formatOutbound(chains: readonly string[]): string {
  const segments = chains.filter((segment) => segment !== '')
  const first = segments[0]
  if (first === undefined) return UNKNOWN
  if (segments.length === 1) return first
  const last = segments[segments.length - 1] ?? first
  if (segments.length === 2) return `${first} ▸ ${last}`
  return `${first} ▸ … ▸ ${last}`
}

/**
 * 行内详情的「命中规则」：`DomainSuffix(github.com)`。
 * 负载为空只显示规则名；规则本身缺失时是未知，不能拼出 `(github.com)`。
 */
export function formatRule(rule: string | null, rulePayload: string | null): string {
  if (rule === null || rule === '') return UNKNOWN
  if (rulePayload === null || rulePayload === '') return rule
  return `${rule}(${rulePayload})`
}

/**
 * 目标地址：`ip:port`。端口未知时只显示 IP；IP 未知时整体是未知——
 * 单独一个端口定位不到目标，编造 IP 更糟。
 */
export function formatDestination(ip: string | null, port: string | null): string {
  if (ip === null || ip === '') return UNKNOWN
  if (port === null || port === '') return ip
  return `${ip}:${port}`
}

const REJECTED_CHAINS = new Set(['REJECT', 'REJECT-DROP'])
/** 被拒绝：链路上出现 REJECT / REJECT-DROP（DIRECT 不算）。 */
export function isRejectedConnection(connection: Pick<ConnectionView, 'chains'>): boolean {
  return connection.chains.some((segment) => REJECTED_CHAINS.has(segment))
}

/** 域名列：host 优先，缺失退回目标 IP，两者都缺才是未知。 */
export function connectionHost(
  connection: Pick<ConnectionView, 'host' | 'destinationIp'>
): string {
  return connection.host ?? connection.destinationIp ?? UNKNOWN
}

/**
 * 时长（毫秒）。已结束的连接冻结在 `endedAt`；建立时刻或终止时刻未知时返回 null，
 * 交给 `formatDuration` 统一显示破折号。
 */
export function connectionDurationMs(
  connection: Pick<ConnectionView, 'startedAt' | 'ended' | 'endedAt'>,
  now: number | null
): number | null {
  if (connection.startedAt === null) return null
  const end = connection.ended ? (connection.endedAt ?? now) : now
  if (end === null) return null
  const duration = end - connection.startedAt
  return Number.isFinite(duration) && duration >= 0 ? duration : null
}

export interface ConnectionFilter {
  query: string
  activeOnly: boolean
}

/**
 * 文本搜索匹配域名（含退回的目标 IP）与进程名，不区分大小写。
 * 空查询不过滤；`activeOnly` 只去掉已结束的行。
 */
export function filterConnections(
  items: readonly ConnectionView[],
  filter: ConnectionFilter
): ConnectionView[] {
  const query = filter.query.trim().toLowerCase()
  return items.filter((item) => {
    if (filter.activeOnly && item.ended) return false
    if (query === '') return true
    const host = (item.host ?? item.destinationIp ?? '').toLowerCase()
    const process = (item.process ?? '').toLowerCase()
    return host.includes(query) || process.includes(query)
  })
}

export type SortDirection = 'asc' | 'desc'

/**
 * 按建立时刻排序，默认调用方传 `desc`。建立时刻未知的条目无论方向都排在最后：
 * 未知不是「最旧」，不能让它挤掉真实数据。
 */
export function sortConnections(
  items: readonly ConnectionView[],
  direction: SortDirection
): ConnectionView[] {
  return [...items].sort((a, b) => {
    if (a.startedAt === null && b.startedAt === null) return 0
    if (a.startedAt === null) return 1
    if (b.startedAt === null) return -1
    return direction === 'desc' ? b.startedAt - a.startedAt : a.startedAt - b.startedAt
  })
}
