import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject
} from 'react'
import { CONNECTION_DETAIL_HEIGHT, ConnectionDetail } from '../components/ConnectionDetail'
import { ConnectionRow, CONNECTION_ROW_HEIGHT } from '../components/ConnectionRow'
import { copy } from '../copy'
import { useConnections } from '../hooks/useConnections'
import { scrollTopForRow, useVirtualRows, type RowExpansion } from '../hooks/useVirtualRows'
import {
  connectionHeaders,
  connectionHost,
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
  const [announcement, setAnnouncement] = useState('')
  const viewportRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const headerRef = useRef<HTMLDivElement>(null)
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
  // 展开的详情是独立一行：它把后面的行整体下移，虚拟滚动按额外高度补偿。
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
  // 表头 1 行 + 数据行；详情展开时它自己也是一行。空状态保留一行提示。
  const rowCount =
    visible.length === 0 ? 2 : visible.length + 1 + (expandedIndex >= 0 ? 1 : 0)

  // 选中行从快照里消失或被筛掉后清空，否则下一次 ↑/↓ 会从数组两端重新起跳。
  useEffect(() => {
    if (selectedId !== null && selectedIndex === -1) setSelectedId(null)
  }, [selectedId, selectedIndex])

  // 展开的行被筛选掉（例如打开「只看活跃」）后收起，避免之后恢复时又冒出来。
  useEffect(() => {
    if (expandedId !== null && expandedIndex === -1) setExpandedId(null)
  }, [expandedId, expandedIndex])

  // 展开 / 收起时通过 polite 状态区播报，屏幕阅读器不需要靠视觉发现。
  const previousExpandedId = useRef<string | null>(null)
  useEffect(() => {
    const previous = previousExpandedId.current
    previousExpandedId.current = expandedId
    if (previous === expandedId) return
    if (expandedId === null) {
      if (previous !== null) setAnnouncement(copy.connections.detail.collapsed)
      return
    }
    const row = items.find((item) => item.id === expandedId)
    if (row !== undefined) {
      setAnnouncement(copy.connections.detail.expanded(connectionHost(row)))
    }
  }, [expandedId, items])

  // 筛选或排序变化后列表会换一套，滚回顶部，避免停在一个已经不存在的位置。
  // 用 layout effect：在浏览器绘制前完成，不会闪一帧旧滚动位置。
  useLayoutEffect(() => {
    setScrollTop(0)
    if (viewportRef.current !== null) viewportRef.current.scrollTop = 0
  }, [query, activeOnly, direction])

  const toggleDirection = (): void => {
    setDirection((previous) => (previous === 'desc' ? 'asc' : 'desc'))
  }

  /**
   * 没有选中行时从当前滚动位置所在的行开始，而不是跳到列表头/尾。
   * 详情只在有选中行时展开，所以这里不需要补偿详情行的高度。
   */
  const scrollAnchorIndex = useMemo(() => {
    if (visible.length === 0) return 0
    const estimated = Math.floor(scrollTop / CONNECTION_ROW_HEIGHT)
    return Math.min(Math.max(0, estimated), visible.length - 1)
  }, [scrollTop, visible.length])

  /**
   * 把第 `index` 行滚进视口（行已可见时不动）。吸顶表头会挡住滚动容器顶部，
   * 所以要从可用高度里扣掉它；`extraTotal` 是展开行的额外高度，用于钳制最大值。
   */
  const scrollRowIntoView = (index: number, extraTotal = 0): void => {
    const element = viewportRef.current
    if (element === null) return
    const headerHeight = headerRef.current?.offsetHeight ?? 0
    const next = scrollTopForRow(
      index,
      CONNECTION_ROW_HEIGHT,
      element.scrollTop,
      viewportHeight,
      0,
      headerHeight > 0 ? headerHeight : CONNECTION_ROW_HEIGHT,
      visible.length * CONNECTION_ROW_HEIGHT + extraTotal
    )
    if (next === element.scrollTop) return
    element.scrollTop = next
    setScrollTop(next)
  }

  // 行组件是 memo 的，`onActivate` 必须保持稳定；它需要的最新状态经 ref 读取。
  const latest = useRef({ visible, expandedId })
  latest.current = { visible, expandedId }
  const scrollRowIntoViewRef = useRef(scrollRowIntoView)
  scrollRowIntoViewRef.current = scrollRowIntoView

  /** 鼠标点行：选中并切换详情，同时把焦点交给列表，接着就能用键盘。 */
  const activateRow = useCallback((id: string) => {
    setSelectedId(id)
    setExpandedId((previous) => (previous === id ? null : id))
    viewportRef.current?.focus({ preventScroll: true })
    const index = latest.current.visible.findIndex((item) => item.id === id)
    if (index === -1) return
    const expanding = latest.current.expandedId !== id
    scrollRowIntoViewRef.current(index, expanding ? CONNECTION_DETAIL_HEIGHT : 0)
  }, [])

  /**
   * ↑ ↓ 移动选中行，到两端停住，不回卷。详情跟着选中行走，所以移动即收起，
   * 不会出现「选中 A、详情属于 B」的两套高亮。没有选中时从当前滚动位置起跳。
   */
  const moveSelection = (delta: 1 | -1): void => {
    if (visible.length === 0) return
    const next =
      selectedIndex === -1
        ? scrollAnchorIndex
        : Math.min(visible.length - 1, Math.max(0, selectedIndex + delta))
    const target = visible[next]
    if (target === undefined) return
    setSelectedId(target.id)
    setExpandedId(null)
    scrollRowIntoView(next)
  }

  /** Enter：展开 / 收起当前选中行的详情；没有选中时选中滚动位置所在的行。 */
  const toggleDetail = (): void => {
    const index = selectedIndex >= 0 ? selectedIndex : scrollAnchorIndex
    const target = visible[index]
    if (target === undefined) return
    const expanding = expandedId !== target.id
    setSelectedId(target.id)
    setExpandedId(expanding ? target.id : null)
    scrollRowIntoView(index, expanding ? CONNECTION_DETAIL_HEIGHT : 0)
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

  // `/` 与 `Esc` 是主视图 / 全局作用域：焦点不在列表或搜索框时也生效。
  // ↑ ↓ Enter A 仍然只在列表内生效，由 onListKeyDown 处理。
  useEffect(() => {
    const onWindowKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.defaultPrevented) return
      if (event.ctrlKey || event.metaKey || event.altKey) return
      if (event.key === 'Escape') {
        if (!collapseOrClear()) return
        event.preventDefault()
        return
      }
      if (event.key === '/' && !isInteractiveTarget(event.target)) {
        event.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onWindowKeyDown)
    return () => {
      window.removeEventListener('keydown', onWindowKeyDown)
    }
  }, [expandedId, query])

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.ctrlKey || event.metaKey || event.altKey) return
    // 表头聚焦时 Enter / Space 属于排序按钮；方向键与 Esc 仍应操作列表，
    // 否则 Tab 到排序按钮后方向键会「失灵」。操作完把焦点交还列表。
    const inHeader =
      event.target instanceof HTMLElement && event.target.closest('.conn-head') !== null
    if (inHeader) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        moveSelection(event.key === 'ArrowDown' ? 1 : -1)
        viewportRef.current?.focus()
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        collapseOrClear()
        viewportRef.current?.focus()
      }
      return
    }
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
      default:
        break
    }
    if (event.key.toLowerCase() === 'a') {
      if (event.repeat) return
      event.preventDefault()
      setActiveOnly((previous) => !previous)
    }
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
        role="grid"
        // 列表本身可获得焦点，键盘快捷键的作用域就是这里；搜索框在工具栏里，
        // 不在这个子树内，所以输入时不会被单键快捷键拦截。
        tabIndex={0}
        aria-label={copy.connections.label}
        aria-colcount={connectionHeaders.length}
        aria-rowcount={rowCount}
        aria-activedescendant={selected === undefined ? undefined : `conn-row-${selected.id}`}
        onKeyDown={onListKeyDown}
        onScroll={(event) => {
          setScrollTop(event.currentTarget.scrollTop)
        }}
      >
        <div className="conn-head" role="rowgroup" ref={headerRef}>
          <div className="conn-grid conn-head-row" role="row" aria-rowindex={1}>
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
            <div className="conn-empty" role="row" aria-rowindex={2}>
              <div
                className="conn-empty-text"
                role="gridcell"
                aria-colspan={connectionHeaders.length}
              >
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
                {windowed.rows.map((connection, offset) => {
                  const absolute = windowed.start + offset
                  // 详情行插在展开行之后，所以它后面的数据行号整体 +1。
                  const rowIndex =
                    absolute + 2 + (expandedIndex >= 0 && absolute > expandedIndex ? 1 : 0)
                  return (
                    <Fragment key={connection.id}>
                      <ConnectionRow
                        connection={connection}
                        now={now}
                        rowIndex={rowIndex}
                        selected={connection.id === selectedId}
                        expanded={connection.id === expandedId}
                        onActivate={activateRow}
                      />
                      {connection.id === expandedId && (
                        <div className="conn-detail-row" role="row" aria-rowindex={rowIndex + 1}>
                          <div
                            className="conn-detail-cell"
                            role="gridcell"
                            aria-colspan={connectionHeaders.length}
                            aria-label={copy.connections.detail.label}
                          >
                            <ConnectionDetail connection={connection} />
                          </div>
                        </div>
                      )}
                    </Fragment>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </div>
      <span className="conn-sr-only" role="status">
        {announcement}
      </span>
    </section>
  )
}
