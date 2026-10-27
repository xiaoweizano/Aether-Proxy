import { memo } from 'react'
import type { ConnectionView } from '../../shared/ipc'
import { copy } from '../copy'
import { formatBytes, formatClock, formatDuration, UNKNOWN } from '../format'
import {
  connectionDurationMs,
  connectionHost,
  formatOutbound,
  isRejectedConnection,
  truncateMiddle
} from '../selectors'

/** 与 tokens.css 的 `--conn-row-height` 保持一致；虚拟滚动依赖它。 */
export const CONNECTION_ROW_HEIGHT = 28

export interface ConnectionRowProps {
  connection: ConnectionView
  /**
   * 当前时刻（毫秒，页面已按秒取整）。已结束的行用 `endedAt` 冻结时长，
   * 因此它的变化不会让已结束行重渲染。
   */
  now: number | null
  /** 测试用的渲染计数器；产品代码不传。 */
  onRender?: (id: string) => void
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

/**
 * 快照每 500ms 都会给每条连接新建对象与 chains 副本。默认的浅比较会把每一行都
 * 重渲染一次，所以这里逐字段比较：只有这一行真正显示的内容变了才放行。
 *
 * 已结束行的时长冻结在 `endedAt`，`now` 前进不影响它。
 */
function sameConnection(a: ConnectionView, b: ConnectionView): boolean {
  return (
    a.id === b.id &&
    a.startedAt === b.startedAt &&
    a.rule === b.rule &&
    a.rulePayload === b.rulePayload &&
    a.host === b.host &&
    a.process === b.process &&
    a.processPath === b.processPath &&
    a.network === b.network &&
    a.destinationIp === b.destinationIp &&
    a.destinationPort === b.destinationPort &&
    a.sourceIp === b.sourceIp &&
    a.sourcePort === b.sourcePort &&
    a.upload === b.upload &&
    a.download === b.download &&
    a.ended === b.ended &&
    a.endedAt === b.endedAt &&
    sameStrings(a.chains, b.chains)
  )
}

function propsEqual(previous: ConnectionRowProps, next: ConnectionRowProps): boolean {
  if (previous.onRender !== next.onRender) return false
  if (!sameConnection(previous.connection, next.connection)) return false
  if (previous.now === next.now) return true
  // 两边都已结束且 endedAt 相同：时长与 now 无关。
  return (
    previous.connection.ended &&
    next.connection.ended &&
    previous.connection.endedAt !== null &&
    previous.connection.endedAt === next.connection.endedAt
  )
}

function ConnectionRowView({ connection, now, onRender }: ConnectionRowProps) {
  onRender?.(connection.id)

  const rejected = isRejectedConnection(connection)
  const host = connectionHost(connection)
  const duration = connectionDurationMs(connection, now)
  const dotClass = [
    'conn-dot',
    connection.ended ? 'ended' : '',
    rejected ? 'rejected' : ''
  ]
    .filter(Boolean)
    .join(' ')
  const rowClass = ['conn-row', connection.ended ? 'ended' : '', rejected ? 'rejected' : '']
    .filter(Boolean)
    .join(' ')
  const dotTitle =
    connection.ended && rejected
      ? `${copy.connections.ended} · ${copy.connections.rejected}`
      : connection.ended
        ? copy.connections.ended
        : rejected
          ? copy.connections.rejected
          : undefined

  return (
    <div className={rowClass} role="row" data-connection-id={connection.id}>
      <div className="conn-cell conn-time" role="cell">
        <span className={dotClass} title={dotTitle} aria-hidden="true" />
        <span className="conn-time-text">
          {connection.startedAt === null ? UNKNOWN : formatClock(connection.startedAt)}
        </span>
      </div>
      <div
        className="conn-cell conn-ellipsis"
        role="cell"
        title={connection.process ?? undefined}
      >
        {connection.process ?? UNKNOWN}
      </div>
      <div
        className="conn-cell conn-ellipsis"
        role="cell"
        title={connection.host ?? connection.destinationIp ?? undefined}
      >
        {truncateMiddle(host)}
      </div>
      <div
        className="conn-cell conn-ellipsis conn-outbound"
        role="cell"
        title={connection.chains.join(' ▸ ')}
      >
        {formatOutbound(connection.chains)}
      </div>
      <div className="conn-cell conn-traffic" role="cell">
        {`↑${formatBytes(connection.upload)} ↓${formatBytes(connection.download)}`}
      </div>
      <div className="conn-cell conn-duration" role="cell">
        {duration === null ? UNKNOWN : formatDuration(duration)}
      </div>
    </div>
  )
}

export const ConnectionRow = memo(ConnectionRowView, propsEqual)
