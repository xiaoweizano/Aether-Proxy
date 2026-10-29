import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { computeVirtualRows, scrollTopForRow, useVirtualRows } from './useVirtualRows'

const ROW_HEIGHT = 28
const VIEWPORT_HEIGHT = 600
const VISIBLE_ROWS = Math.ceil(VIEWPORT_HEIGHT / ROW_HEIGHT)

function makeItems(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index)
}

describe('useVirtualRows', () => {
  it('1000 条 / 600px / 28px：窗口不超过视口行数 + 2', () => {
    const items = makeItems(1000)
    const { result } = renderHook(() => useVirtualRows(items, ROW_HEIGHT, VIEWPORT_HEIGHT))

    expect(result.current.virtualized).toBe(true)
    expect(result.current.start).toBe(0)
    expect(result.current.end).toBeLessThanOrEqual(VISIBLE_ROWS + 2)
    expect(result.current.end - result.current.start).toBe(result.current.rows.length)
    expect(result.current.totalHeight).toBe(items.length * ROW_HEIGHT)
    expect(result.current.offset).toBe(0)
  })

  it('滚动后窗口跟随 scrollTop，长度仍受限', () => {
    const items = makeItems(1000)
    const { result } = renderHook(() =>
      useVirtualRows(items, ROW_HEIGHT, VIEWPORT_HEIGHT, 1_400)
    )

    expect(result.current.start).toBe(49)
    expect(result.current.rows[0]).toBe(49)
    expect(result.current.offset).toBe(49 * ROW_HEIGHT)
    expect(result.current.end - result.current.start).toBeLessThanOrEqual(VISIBLE_ROWS + 2)
  })

  it('滚动位置超出末尾时会夹紧，不返回空窗口', () => {
    const items = makeItems(1000)
    const { result } = renderHook(() =>
      useVirtualRows(items, ROW_HEIGHT, VIEWPORT_HEIGHT, 99_999)
    )

    expect(result.current.rows.length).toBeGreaterThan(0)
    expect(result.current.end).toBe(items.length)
  })

  it('恰好 200 条不虚拟化，返回全部行', () => {
    const items = makeItems(200)
    const { result } = renderHook(() => useVirtualRows(items, ROW_HEIGHT, VIEWPORT_HEIGHT))

    expect(result.current.virtualized).toBe(false)
    expect(result.current.rows).toEqual(items)
    expect(result.current.start).toBe(0)
    expect(result.current.end).toBe(200)
    expect(result.current.offset).toBe(0)
    expect(result.current.totalHeight).toBe(200 * ROW_HEIGHT)
  })

  it('201 条开始虚拟化', () => {
    const { result } = renderHook(() => useVirtualRows(makeItems(201), ROW_HEIGHT, VIEWPORT_HEIGHT))

    expect(result.current.virtualized).toBe(true)
    expect(result.current.rows.length).toBeLessThan(201)
  })

  it('空列表返回空窗口与零高度', () => {
    const { result } = renderHook(() => useVirtualRows([], ROW_HEIGHT, VIEWPORT_HEIGHT))

    expect(result.current.rows).toEqual([])
    expect(result.current.start).toBe(0)
    expect(result.current.end).toBe(0)
    expect(result.current.totalHeight).toBe(0)
    expect(result.current.offset).toBe(0)
  })

  it('视口还未知（0）时不崩溃，至少给一行', () => {
    const { result } = renderHook(() => useVirtualRows(makeItems(1000), ROW_HEIGHT, 0))

    expect(result.current.rows.length).toBeGreaterThan(0)
    expect(result.current.rows.length).toBeLessThanOrEqual(3)
  })

  it('展开行计入总高度，后续行的偏移整体下移', () => {
    const items = makeItems(1000)
    const without = computeVirtualRows(items, ROW_HEIGHT, VIEWPORT_HEIGHT, 1_400)
    const withDetail = computeVirtualRows(items, ROW_HEIGHT, VIEWPORT_HEIGHT, 1_400, {
      index: 10,
      extraHeight: 112
    })

    expect(withDetail.totalHeight).toBe(items.length * ROW_HEIGHT + 112)
    // 窗口起点在展开行之后，因此偏移 = 起点行高之和 + 详情高度。
    expect(withDetail.start).toBeGreaterThan(10)
    expect(withDetail.offset).toBe(withDetail.start * ROW_HEIGHT + 112)
    expect(withDetail.start).toBeLessThan(without.start)
  })

  it('滚动位置落在展开行内部时窗口仍包含该行，不会跳过它', () => {
    const items = makeItems(1000)
    // 展开行 top = 10 * 28 = 280，往下 60px 已在详情区域内。
    const result = computeVirtualRows(items, ROW_HEIGHT, VIEWPORT_HEIGHT, 280 + 60, {
      index: 10,
      extraHeight: 112
    })

    expect(result.start).toBeLessThanOrEqual(10)
    expect(result.end).toBeGreaterThan(10)
    expect(result.offset).toBe(result.start * ROW_HEIGHT)
  })

  it('展开下标越界或高度非法时按不展开处理', () => {
    const items = makeItems(10)

    expect(
      computeVirtualRows(items, ROW_HEIGHT, VIEWPORT_HEIGHT, 0, { index: 99, extraHeight: 112 })
        .totalHeight
    ).toBe(items.length * ROW_HEIGHT)
    expect(
      computeVirtualRows(items, ROW_HEIGHT, VIEWPORT_HEIGHT, 0, {
        index: 2,
        extraHeight: Number.NaN
      }).totalHeight
    ).toBe(items.length * ROW_HEIGHT)
  })

  describe('展开行在窗口边界上的四个位置', () => {
    const EXTRA = 112
    const items = makeItems(1000)
    const without = computeVirtualRows(items, ROW_HEIGHT, VIEWPORT_HEIGHT, 1_400)

    /** 窗口偏移必须与「起点行之前是否包含展开行」一致。 */
    function expectConsistentOffset(result: ReturnType<typeof computeVirtualRows>, index: number): void {
      const expected = result.start * ROW_HEIGHT + (result.start > index ? EXTRA : 0)
      expect(result.offset).toBe(expected)
      expect(result.totalHeight).toBe(items.length * ROW_HEIGHT + EXTRA)
      // 展开行必须留在窗口里，否则详情行不会挂载。
      expect(result.start).toBeLessThanOrEqual(index)
      expect(result.end).toBeGreaterThan(index)
    }

    it('首行展开', () => {
      const result = computeVirtualRows(items, ROW_HEIGHT, VIEWPORT_HEIGHT, 0, {
        index: 0,
        extraHeight: EXTRA
      })

      expect(result.start).toBe(0)
      expect(result.offset).toBe(0)
      expectConsistentOffset(result, 0)
    })

    it('末行展开', () => {
      const last = items.length - 1
      const result = computeVirtualRows(items, ROW_HEIGHT, VIEWPORT_HEIGHT, last * ROW_HEIGHT, {
        index: last,
        extraHeight: EXTRA
      })

      expect(result.end).toBe(items.length)
      expectConsistentOffset(result, last)
    })

    it('展开行恰好落在窗口起点', () => {
      const result = computeVirtualRows(items, ROW_HEIGHT, VIEWPORT_HEIGHT, 1_400, {
        index: without.start,
        extraHeight: EXTRA
      })

      expectConsistentOffset(result, without.start)
    })

    it('展开行在窗口上方一行', () => {
      const index = without.start - 1
      const result = computeVirtualRows(items, ROW_HEIGHT, VIEWPORT_HEIGHT, 1_400, {
        index,
        extraHeight: EXTRA
      })

      // 起点要向前让出空间，才能把展开行与详情一起放进窗口。
      expect(result.start).toBeLessThan(without.start)
      expectConsistentOffset(result, index)
    })
  })
})

describe('scrollTopForRow', () => {
  const ROW = 28
  const VIEWPORT = 600
  const INSET = 28
  // 一屏约 21 行；用 100 行的列表做边界。
  const CONTENT = 100 * ROW

  it('行在视口上方：行顶对齐到表头下沿', () => {
    expect(scrollTopForRow(2, ROW, 1_000, VIEWPORT, 0, INSET, CONTENT)).toBe(2 * ROW - INSET)
  })

  it('行在视口下方：行底对齐到视口底部', () => {
    expect(scrollTopForRow(40, ROW, 0, VIEWPORT, 0, INSET, CONTENT)).toBe(
      40 * ROW + ROW - VIEWPORT
    )
  })

  it('行已完整可见：原样返回，不产生无谓滚动', () => {
    const scrollTop = 25 * ROW
    expect(scrollTopForRow(30, ROW, scrollTop, VIEWPORT, 0, INSET, CONTENT)).toBe(scrollTop)
  })

  it('第一行：向上滚到顶，结果不小于 0', () => {
    expect(scrollTopForRow(0, ROW, 300, VIEWPORT, 0, INSET, CONTENT)).toBe(0)
  })

  it('最后一行：滚到列表末尾，不超过 maxScroll', () => {
    const next = scrollTopForRow(99, ROW, 0, VIEWPORT, 0, INSET, CONTENT)
    expect(next).toBe(CONTENT - VIEWPORT)
    expect(next).toBeLessThanOrEqual(CONTENT - VIEWPORT)
  })

  it('列表比视口还短：任何行都不需要滚动', () => {
    const shortContent = 5 * ROW
    expect(scrollTopForRow(4, ROW, 0, VIEWPORT, 0, INSET, shortContent)).toBe(0)
    expect(scrollTopForRow(0, ROW, 0, VIEWPORT, 0, INSET, shortContent)).toBe(0)
  })

  it('展开行在目标行上方时把额外高度算进位置', () => {
    expect(scrollTopForRow(20, ROW, 0, VIEWPORT, 112, INSET, CONTENT + 112)).toBe(
      20 * ROW + 112 + ROW - VIEWPORT
    )
  })

  it('结果始终夹在 [0, maxScroll]', () => {
    expect(scrollTopForRow(99, ROW, 0, VIEWPORT, 0, INSET, CONTENT)).toBeLessThanOrEqual(
      CONTENT - VIEWPORT
    )
    expect(scrollTopForRow(0, ROW, 10_000, VIEWPORT, 0, INSET, CONTENT)).toBe(0)
  })
})
