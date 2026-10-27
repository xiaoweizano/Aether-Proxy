import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useVirtualRows } from './useVirtualRows'

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
})
