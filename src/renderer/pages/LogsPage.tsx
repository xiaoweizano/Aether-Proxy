import { useLayoutEffect, useRef } from 'react'
import { copy } from '../copy'
import { formatClock } from '../format'
import { useLogs } from '../hooks/useLogs'

/** 离底部多少像素内算「贴着底」：滚动容器自己汇报，不需要额外测量。 */
const PIN_THRESHOLD_PX = 4

export interface LogsPageProps {
  /** 轮询间隔；测试注入以免等真实的 1 秒。 */
  intervalMs?: number
}

/**
 * 日志页。逐条展示内核 `/logs` 尾巴（主进程最多留 200 条），最新在最后。
 *
 * 三个刻意的取舍：
 * 1. **不美化 payload**：内核原文逐字显示。日志的价值在于「它到底说了什么」，
 *    任何摘要都会让排障变成猜。
 * 2. **不自动滚动打扰读者**：只有本来就在底部时才跟着新条目滚动；往上翻看时位置不动。
 * 3. **断线保留尾巴**：内核崩溃是最需要日志的时刻，这时把已经收到的条目清掉，
 *    等于在最需要证据时擦掉证据。改为明确标注「不再更新」。
 */
export function LogsPage({ intervalMs }: LogsPageProps) {
  const { entries, revision, live, error } = useLogs(intervalMs)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  /** 用户是否贴在底部。初始为 true：刚进页面时应该看到最新的日志。 */
  const pinned = useRef(true)

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (viewport === null || !pinned.current) return
    viewport.scrollTop = viewport.scrollHeight
  }, [revision])

  const handleScroll = (): void => {
    const viewport = viewportRef.current
    if (viewport === null) return
    const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
    pinned.current = distance <= PIN_THRESHOLD_PX
  }

  const stoppedNote = !live && entries.length > 0

  return (
    <section className="logs-page" aria-label={copy.logs.label}>
      <div className="logs-toolbar">
        <span className="logs-status" data-live={live}>
          <span className="logs-dot" aria-hidden="true" />
          {live ? copy.logs.live : copy.logs.stopped}
        </span>
        <span className="logs-count">{copy.logs.count(entries.length)}</span>
        {error !== null && <span className="logs-error">{error}</span>}
      </div>

      {stoppedNote && <p className="logs-note">{copy.logs.stoppedNote}</p>}

      <div
        className="logs-list"
        ref={viewportRef}
        role="log"
        aria-label={copy.logs.label}
        aria-live="polite"
        onScroll={handleScroll}
      >
        {entries.length === 0 ? (
          <p className="logs-empty">{live ? copy.logs.empty : copy.logs.offline}</p>
        ) : (
          entries.map((entry, index) => (
            <div className="log-row" key={`${entry.at}-${index}`}>
              <time className="log-time" dateTime={new Date(entry.at).toISOString()}>
                {formatClock(entry.at)}
              </time>
              <span className="log-level">{entry.level}</span>
              <span className="log-text">{entry.payload}</span>
            </div>
          ))
        )}
      </div>
    </section>
  )
}
