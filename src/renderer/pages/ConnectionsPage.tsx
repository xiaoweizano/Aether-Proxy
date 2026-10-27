import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { ConnectionRow, CONNECTION_ROW_HEIGHT } from '../components/ConnectionRow'
import { copy } from '../copy'
import { useConnections } from '../hooks/useConnections'
import { useVirtualRows } from '../hooks/useVirtualRows'
import {
  connectionHeaders,
  filterConnections,
  sortConnections,
  type ConnectionHeader,
  type SortDirection
} from '../selectors'

/** jsdom 没有布局，Electron 首次渲染前的默认值也够用；挂载后会立刻量真实高度。 */
const FALLBACK_VIEWPORT_HEIGHT = 600

const COLUMN_LABELS: Record<ConnectionHeader, string> = {
  time: copy.connections.columns.time,
  process: copy.connections.columns.process,
  host: copy.connections.columns.host,
  outbound: copy.connections.columns.outbound,
  traffic: copy.connections.columns.traffic,
  duration: copy.connections.columns.duration
}

/** 量滚动容器高度；没有 ResizeObserver 的环境（测试）保留兜底值。 */
function useViewportHeight(ref: RefObject<HTMLDivElement | null>): number {
  const [height, setHeight] = useState(FALLBACK_VIEWPORT_HEIGHT)

  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return
    const update = (): void => {
      const measured = element.clientHeight
      if (measured > 0) setHeight(measured)
    }
    update()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => {
      observer.disconnect()
    }
  }, [ref])

  return height
}

/**
 * 连接页：六列表格 + 虚拟滚动。
 *
 * `now` 取最近一份快照的时刻并按秒取整——时长本来就是秒级，500ms 一帧的推送
 * 不会让可见行每秒重渲染超过一次；已结束行的时长由 `endedAt` 冻结。
 */
export function ConnectionsPage() {
  const { items, at } = useConnections()
  const [query, setQuery] = useState('')
  const [activeOnly, setActiveOnly] = useState(false)
  const [direction, setDirection] = useState<SortDirection>('desc')
  const [scrollTop, setScrollTop] = useState(0)
  const viewportRef = useRef<HTMLDivElement>(null)
  const viewportHeight = useViewportHeight(viewportRef)

  const now = at === null ? null : Math.floor(at / 1000) * 1000
  const visible = useMemo(
    () => sortConnections(filterConnections(items, { query, activeOnly }), direction),
    [items, query, activeOnly, direction]
  )
  const windowed = useVirtualRows(visible, CONNECTION_ROW_HEIGHT, viewportHeight, scrollTop)

  // 筛选或排序变化后列表会换一套，滚回顶部，避免停在一个已经不存在的位置。
  useEffect(() => {
    setScrollTop(0)
    if (viewportRef.current !== null) viewportRef.current.scrollTop = 0
  }, [query, activeOnly, direction])

  const toggleDirection = (): void => {
    setDirection((previous) => (previous === 'desc' ? 'asc' : 'desc'))
  }
  const emptyMessage = items.length === 0 ? copy.connections.empty : copy.connections.noMatches

  return (
    <section className="connections-page" aria-label={copy.connections.label}>
      <div className="conn-toolbar">
        <span className="conn-window">{copy.connections.window}</span>
        <span className="conn-count">{copy.connections.count(visible.length)}</span>
        <input
          className="conn-search"
          type="search"
          value={query}
          placeholder={copy.connections.searchPlaceholder}
          aria-label={copy.connections.searchLabel}
          onChange={(event) => {
            setQuery(event.target.value)
          }}
        />
        <button
          type="button"
          className="conn-toggle"
          aria-pressed={activeOnly}
          onClick={() => {
            setActiveOnly((previous) => !previous)
          }}
        >
          {copy.connections.activeOnly}
        </button>
      </div>

      <div className="conn-table" role="table" aria-label={copy.connections.label}>
        <div className="conn-head" role="rowgroup">
          <div className="conn-head-row" role="row">
            {connectionHeaders.map((header) => (
              <div
                key={header}
                className={`conn-cell conn-head-cell conn-${header}`}
                role="columnheader"
                aria-sort={
                  header === 'time'
                    ? direction === 'desc'
                      ? 'descending'
                      : 'ascending'
                    : undefined
                }
              >
                {header === 'time' ? (
                  <button type="button" className="conn-sort" onClick={toggleDirection}>
                    {COLUMN_LABELS[header]}
                    <span className="conn-sort-arrow" aria-hidden="true">
                      {direction === 'desc' ? '↓' : '↑'}
                    </span>
                  </button>
                ) : (
                  COLUMN_LABELS[header]
                )}
              </div>
            ))}
          </div>
        </div>

        <div
          className="conn-viewport"
          ref={viewportRef}
          role="rowgroup"
          onScroll={(event) => {
            setScrollTop(event.currentTarget.scrollTop)
          }}
        >
          {visible.length === 0 ? (
            <div className="conn-empty" role="row">
              <div className="conn-empty-text" role="cell" aria-colspan={connectionHeaders.length}>
                {emptyMessage}
              </div>
            </div>
          ) : (
            <div className="conn-spacer" style={{ height: windowed.totalHeight }}>
              <div
                className="conn-window-rows"
                style={{ transform: `translateY(${windowed.offset}px)` }}
              >
                {windowed.rows.map((connection) => (
                  <ConnectionRow key={connection.id} connection={connection} now={now} />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
