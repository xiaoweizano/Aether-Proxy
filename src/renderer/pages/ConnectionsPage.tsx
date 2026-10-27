import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject
} from 'react'
import { CONNECTION_DETAIL_HEIGHT } from '../components/ConnectionDetail'
import { ConnectionRow, CONNECTION_ROW_HEIGHT } from '../components/ConnectionRow'
import { copy } from '../copy'
import { useConnections } from '../hooks/useConnections'
import { useVirtualRows, type RowExpansion } from '../hooks/useVirtualRows'
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

const INTERACTIVE_SELECTOR = 'button, input, textarea, select, a, [contenteditable="true"]'

/**
 * 单键快捷键只在列表本身获得焦点时生效：焦点落在表头排序按钮等控件上时，
 * Enter / Space 属于控件自己，列表不得抢。
 */
function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest(INTERACTIVE_SELECTOR) !== null
}

/**
 * 连接页：六列表格 + 虚拟滚动 + 行内详情。
 *
 * `now` 取最近一份快照的时刻并按秒取整——时长本来就是秒级，500ms 一帧的推送
 * 不会让可见行每秒重渲染超过一次；已结束行的时长由 `endedAt` 冻结。
 *
 * 选中与展开是两份状态：键盘移动选中行时详情会收起，详情永远属于当前选中行。
 */
export function ConnectionsPage() {
  const { items, at } = useConnections()
  const [query, setQuery] = useState('')
  const [activeOnly, setActiveOnly] = useState(false)
  const [direction, setDirection] = useState<SortDirection>('desc')
  const [scrollTop, setScrollTop] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const viewportHeight = useViewportHeight(viewportRef)

  const now = at === null ? null : Math.floor(at / 1000) * 1000
  const visible = useMemo(
    () => sortConnections(filterConnections(items, { query, activeOnly }), direction),
    [items, query, activeOnly, direction]
  )
  const selectedIndex = useMemo(
    () => (selectedId === null ? -1 : visible.findIndex((item) => item.id === selectedId)),
    [visible, selectedId]
  )
  const expandedIndex = useMemo(
    () => (expandedId === null ? -1 : visible.findIndex((item) => item.id === expandedId)),
    [visible, expandedId]
  )
  // 展开行把固定行高戳破；把额外高度交给虚拟滚动，后面的行才不会叠在一起。
  const expansion = useMemo<RowExpansion>(
    () => ({ index: expandedIndex, extraHeight: CONNECTION_DETAIL_HEIGHT }),
    [expandedIndex]
  )
  const windowed = useVirtualRows(
    visible,
    CONNECTION_ROW_HEIGHT,
    viewportHeight,
    scrollTop,
    expansion
  )

  // 展开的行被筛选掉（例如打开「只看活跃」）后收起，避免之后恢复时又冒出来。
  useEffect(() => {
    if (expandedId !== null && expandedIndex === -1) setExpandedId(null)
  }, [expandedId, expandedIndex])

  // 筛选或排序变化后列表会换一套，滚回顶部，避免停在一个已经不存在的位置。
  // 用 layout effect：在浏览器绘制前完成，不会闪一帧旧滚动位置。
  useLayoutEffect(() => {
    setScrollTop(0)
    if (viewportRef.current !== null) viewportRef.current.scrollTop = 0
  }, [query, activeOnly, direction])

  const toggleDirection = (): void => {
    setDirection((previous) => (previous === 'desc' ? 'asc' : 'desc'))
  }

  /** 鼠标点行：选中并切换详情，同时把焦点交给列表，接着用键盘。 */
  const activateRow = useCallback((id: string) => {
    setSelectedId(id)
    setExpandedId((previous) => (previous === id ? null : id))
    viewportRef.current?.focus({ preventScroll: true })
  }, [])

  /**
   * ↑ ↓ 移动选中行，到两端停住，不回卷。详情跟着选中行走，所以移动即收起，
   * 不会出现「选中 A、详情属于 B」的两套高亮。
   */
  const moveSelection = (delta: 1 | -1): void => {
    if (visible.length === 0) return
    const current = visible.findIndex((item) => item.id === selectedId)
    const next =
      current === -1
        ? delta > 0
          ? 0
          : visible.length - 1
        : Math.min(visible.length - 1, Math.max(0, current + delta))
    const target = visible[next]
    if (target === undefined) return
    setSelectedId(target.id)
    setExpandedId(null)
  }

  /** Enter：展开 / 收起当前选中行的详情；没有选中时先选第一行。 */
  const toggleDetail = (): void => {
    const target = selectedIndex >= 0 ? visible[selectedIndex] : visible[0]
    if (target === undefined) return
    setSelectedId(target.id)
    setExpandedId((previous) => (previous === target.id ? null : target.id))
  }

  /** Esc：详情已展开时先收起，否则清空搜索。返回是否消费了这次按键。 */
  const collapseOrClear = (): boolean => {
    if (expandedId !== null) {
      setExpandedId(null)
      return true
    }
    if (query !== '') {
      setQuery('')
      return true
    }
    return false
  }

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.ctrlKey || event.metaKey || event.altKey) return
    if (isInteractiveTarget(event.target)) return
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        moveSelection(1)
        return
      case 'ArrowUp':
        event.preventDefault()
        moveSelection(-1)
        return
      case 'Enter':
        if (event.repeat) return
        event.preventDefault()
        toggleDetail()
        return
      case 'Escape':
        event.preventDefault()
        collapseOrClear()
        return
      case '/':
        event.preventDefault()
        searchRef.current?.focus()
        return
      default:
        break
    }
    if (event.key.toLowerCase() === 'a') {
      if (event.repeat) return
      event.preventDefault()
      setActiveOnly((previous) => !previous)
    }
  }

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    collapseOrClear()
  }

  const emptyMessage = items.length === 0 ? copy.connections.empty : copy.connections.noMatches
  const selected = selectedIndex >= 0 ? visible[selectedIndex] : undefined

  return (
    <section className="connections-page">
      <div className="conn-toolbar">
        <span className="conn-window">{copy.connections.window}</span>
        <span className="conn-count">{copy.connections.count(visible.length)}</span>
        <input
          className="conn-search"
          type="search"
          ref={searchRef}
          value={query}
          placeholder={copy.connections.searchPlaceholder}
          aria-label={copy.connections.searchLabel}
          onChange={(event) => {
            setQuery(event.target.value)
          }}
          onKeyDown={onSearchKeyDown}
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

      <div
        className="conn-table"
        ref={viewportRef}
        role="table"
        // 列表本身可获得焦点，键盘快捷键的作用域就是这里；搜索框在工具栏里，
        // 不在这个子树内，所以输入时不会被单键快捷键拦截。
        tabIndex={0}
        aria-label={copy.connections.label}
        aria-colcount={connectionHeaders.length}
        aria-rowcount={visible.length + 1}
        aria-activedescendant={selected === undefined ? undefined : `conn-row-${selected.id}`}
        onKeyDown={onListKeyDown}
        onScroll={(event) => {
          setScrollTop(event.currentTarget.scrollTop)
        }}
      >
        <div className="conn-head" role="rowgroup">
          <div className="conn-grid conn-head-row" role="row">
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

        <div className="conn-body" role="rowgroup">
          {visible.length === 0 ? (
            <div className="conn-empty" role="row">
              <div className="conn-empty-text" role="cell" aria-colspan={connectionHeaders.length}>
                {emptyMessage}
              </div>
            </div>
          ) : (
            <div
              className="conn-spacer"
              role="presentation"
              style={{ height: windowed.totalHeight }}
            >
              <div
                className="conn-window-rows"
                role="presentation"
                style={{ transform: `translateY(${windowed.offset}px)` }}
              >
                {windowed.rows.map((connection) => (
                  <ConnectionRow
                    key={connection.id}
                    connection={connection}
                    now={now}
                    selected={connection.id === selectedId}
                    expanded={connection.id === expandedId}
                    onActivate={activateRow}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
