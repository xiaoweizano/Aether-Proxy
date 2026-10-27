import type { ConnectionView } from '../../shared/ipc'
import { copy } from '../copy'
import { formatBytes, formatClock, UNKNOWN } from '../format'
import { formatDestination, formatRule } from '../selectors'

/**
 * 详情展开后增加的高度；与 tokens.css 的 `--conn-detail-height` 保持一致。
 * 虚拟滚动用它补偿展开行的高度差，否则后面的行会叠在一起。
 */
export const CONNECTION_DETAIL_HEIGHT = 112

export interface ConnectionDetailProps {
  connection: ConnectionView
}

/**
 * 行内详情：四组信息，由连接页渲染为展开行之后的一条独立 `role="row"`。
 *
 * 与列表里的 `formatOutbound` 不同，这里显示**完整**链路，不省略中间层。
 * 所有缺失字段统一显示破折号，绝不渲染 `undefined`。
 */
export function ConnectionDetail({ connection }: ConnectionDetailProps) {
  const segments = connection.chains.filter((segment) => segment !== '')
  const chain = segments.length === 0 ? UNKNOWN : segments.join(' ▸ ')
  const rule = formatRule(connection.rule, connection.rulePayload)
  const process = connection.process ?? UNKNOWN
  const processPath = connection.processPath ?? UNKNOWN
  const startedAt = connection.startedAt === null ? UNKNOWN : formatClock(connection.startedAt)
  const endedAt = connection.endedAt === null ? UNKNOWN : formatClock(connection.endedAt)
  const traffic = `↑${formatBytes(connection.upload)} ↓${formatBytes(connection.download)}`
  const network = connection.network ?? UNKNOWN
  const destination = formatDestination(connection.destinationIp, connection.destinationPort)
  const { detail } = copy.connections

  return (
    <div className="conn-detail">
      <dl className="conn-detail-grid">
        <div className="conn-detail-group">
          <dt className="conn-detail-label">{detail.chain}</dt>
          <dd className="conn-detail-values">
            <span className="conn-detail-value" title={chain}>
              {chain}
            </span>
          </dd>
        </div>
        <div className="conn-detail-group">
          <dt className="conn-detail-label">{detail.rule}</dt>
          <dd className="conn-detail-values">
            <span className="conn-detail-value" title={rule}>
              {rule}
            </span>
          </dd>
        </div>
        <div className="conn-detail-group">
          <dt className="conn-detail-label">{detail.process}</dt>
          <dd className="conn-detail-values">
            <span className="conn-detail-value" title={process}>
              {process}
            </span>
            <span className="conn-detail-value conn-detail-path" title={processPath}>
              {processPath}
            </span>
          </dd>
        </div>
        <div className="conn-detail-group">
          <dt className="conn-detail-label">{detail.data}</dt>
          <dd className="conn-detail-values">
            <span className="conn-detail-value">{traffic}</span>
            <span className="conn-detail-value">
              {`${detail.start} ${startedAt} · ${detail.end} ${endedAt}`}
            </span>
            <span className="conn-detail-value">{`${network} · ${destination}`}</span>
          </dd>
        </div>
      </dl>
    </div>
  )
}
