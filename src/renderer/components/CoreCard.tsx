import type { AppStatusView } from '../../shared/ipc'
import { copy } from '../copy'
import { formatBytes, formatClock, UNKNOWN } from '../format'

export interface CoreCardProps {
  status: AppStatusView | null
  /**
   * 内核内存（字节），来自 `/connections` 帧的 `memory`（已实测为字节）；
   * 没有快照或字段缺失时为 null，显示破折号。
   */
  memory: number | null
}

/**
 * 内核状态：版本、三个事实 chip、启动时间、内存与守护状态。
 *
 * 内存来自连接快照（与 `/memory` 的 `inuse` 同值同单位），未知时显示破折号。
 * 进程守护还没有数据源，保持破折号——「没有」和「不知道」在界面上必须是两件事。
 */
export function CoreCard({ status, memory }: CoreCardProps) {
  const core = status?.core
  // 重连中内核已经不在了：与 core-error 一样不能说「运行中」。
  const running =
    core !== undefined && status?.status !== 'core-error' && status?.status !== 'reconnecting'
  const version = core?.version ?? UNKNOWN
  const port = core === undefined ? UNKNOWN : String(core.proxyPort)
  const groupCount = status?.profile?.groupCount
  const startedAt = core === undefined ? UNKNOWN : formatClock(core.startedAt)
  const memoryText = memory === null ? UNKNOWN : formatBytes(memory)

  return (
    <section className="card core">
      <div className="label-row">
        <span className="card-label">{copy.dashboard.core.label}</span>
      </div>

      <div className={core === undefined ? 'core-version muted' : 'core-version'}>
        {copy.dashboard.core.version(version)}
      </div>

      <div className="chips">
        <span className={running ? 'chip solid on' : 'chip solid muted'}>
          {running ? copy.dashboard.core.running : copy.dashboard.core.stopped}
        </span>
        <span className={core === undefined ? 'chip solid muted' : 'chip solid'}>
          {copy.dashboard.core.port(port)}
        </span>
        <span className={groupCount === undefined ? 'chip solid muted' : 'chip solid'}>
          {copy.dashboard.core.groups(groupCount === undefined ? UNKNOWN : String(groupCount))}
        </span>
      </div>

      <div className="core-rows">
        <div>
          <span>{copy.dashboard.core.startedAt}</span>
          <b className={core === undefined ? 'muted' : undefined}>{startedAt}</b>
        </div>
        <div>
          <span>{copy.dashboard.core.memory}</span>
          <b className={memory === null ? 'muted' : undefined}>{memoryText}</b>
        </div>
        <div>
          <span>{copy.dashboard.core.guard}</span>
          <b className="muted">{UNKNOWN}</b>
        </div>
      </div>
    </section>
  )
}
