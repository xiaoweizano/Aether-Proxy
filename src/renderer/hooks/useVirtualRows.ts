import { useMemo } from 'react'

/** 小列表不做虚拟化，避免滚动条与 transform 带来的抖动。 */
export const VIRTUALIZE_THRESHOLD = 200

/** 视口上下各多渲染一行，滚动时不会露出空白。 */
export const OVERSCAN_ROWS = 1

/**
 * 一条被展开的行：列表里只有它是变高的。
 * `index` 是在**完整列表**中的下标；越界或高度非法时按不展开处理。
 */
export interface RowExpansion {
  index: number
  /** 超出行高的额外高度（px）。 */
  extraHeight: number
}

export interface VirtualRows<T> {
  /** 当前窗口内的条目，直接按顺序渲染。 */
  rows: T[]
  /** 窗口在完整列表中的起止下标（`end` 不含）。 */
  start: number
  end: number
  /** 窗口相对列表顶部的偏移，交给 `transform: translateY(...)`。 */
  offset: number
  /** 完整列表的总高度，撑起滚动条。 */
  totalHeight: number
  /** false 表示列表较小，`rows` 就是全部条目。 */
  virtualized: boolean
}

/**
 * 纯计算：给定列表、固定行高、视口高度与滚动位置，返回要挂载的窗口。
 * 拆成普通函数是为了让 hook 只剩 memo，行为可以直接单测。
 *
 * 展开的行只有一条（行内详情），它的额外高度用 `expansion` 传给窗口计算：
 * 总高度、窗口偏移与窗口起点都会把它算进去，避免下面的行互相重叠。
 */
export function computeVirtualRows<T>(
  items: readonly T[],
  rowHeight: number,
  viewportHeight: number,
  scrollTop: number,
  expansion?: RowExpansion
): VirtualRows<T> {
  const row = Number.isFinite(rowHeight) && rowHeight > 0 ? rowHeight : 1
  const expandedIndex =
    expansion !== undefined &&
    Number.isInteger(expansion.index) &&
    expansion.index >= 0 &&
    expansion.index < items.length
      ? expansion.index
      : -1
  const extraHeight =
    expandedIndex >= 0 && Number.isFinite(expansion?.extraHeight) && (expansion?.extraHeight ?? 0) > 0
      ? (expansion?.extraHeight ?? 0)
      : 0
  const offsetOf = (index: number): number =>
    index * row + (expandedIndex >= 0 && index > expandedIndex ? extraHeight : 0)
  const totalHeight = items.length * row + extraHeight

  if (items.length <= VIRTUALIZE_THRESHOLD) {
    return {
      rows: [...items],
      start: 0,
      end: items.length,
      offset: 0,
      totalHeight,
      virtualized: false
    }
  }

  const viewport = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 0
  const top = Number.isFinite(scrollTop) && scrollTop > 0 ? scrollTop : 0

  // 展开行之前的高度与固定行高一致，先按固定行高估一个起点，再往前退到
  // 真正包住 scrollTop 的那一行（展开行可能把目标行往下推了）。
  let first = Math.min(Math.floor(top / row), items.length - 1)
  while (first > 0 && offsetOf(first) > top) first -= 1

  // 从 first 往后累加到视口底部；展开行之后的行自带额外偏移。
  let last = first
  while (last < items.length && offsetOf(last) < top + viewport) last += 1

  const start = Math.max(0, first - OVERSCAN_ROWS)
  const end = Math.min(items.length, last + OVERSCAN_ROWS)

  return {
    rows: items.slice(start, end),
    start,
    end,
    offset: offsetOf(start),
    totalHeight,
    virtualized: true
  }
}

/**
 * 固定行高窗口化：`items` 超过 200 条时只返回视口附近的行。
 * `scrollTop` 由调用方从滚动容器读出；默认 0，便于单测三参数形式。
 */
export function useVirtualRows<T>(
  items: readonly T[],
  rowHeight: number,
  viewportHeight: number,
  scrollTop = 0,
  expansion?: RowExpansion
): VirtualRows<T> {
  return useMemo(
    () => computeVirtualRows(items, rowHeight, viewportHeight, scrollTop, expansion),
    [items, rowHeight, viewportHeight, scrollTop, expansion]
  )
}
