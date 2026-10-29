import { describe, expect, it } from 'vitest'
import {
  CSV_HEADER,
  DEFAULT_GROWTH_LIMIT,
  DEFAULT_SAMPLES_PER_HOUR,
  SOAK_EXIT,
  evaluateSoak,
  median,
  toCsvRow
} from './soak.mjs'
import { summariseMemory } from './memory.mjs'

const MB = 1024 * 1024
const sample = (mb) => ({ totalBytes: mb * MB })
const samples = (values) => values.map(sample)

describe('median', () => {
  it('奇数个取中间值', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([10])).toBe(10)
  })

  it('偶数个取中间两个的平均，而不是上界或下界', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5)
    expect(median([10, 20])).toBe(15)
  })

  it('取平均后不会受输入顺序影响', () => {
    expect(median([4, 1, 3, 2])).toBe(2.5)
  })

  it('空数组返回 null，而不是 0', () => {
    expect(median([])).toBeNull()
    expect(median(undefined)).toBeNull()
  })

  it('非数字或非有限值抛错，不静默跳过', () => {
    expect(() => median([1, Number.NaN])).toThrow(/有限数字/)
    expect(() => median([1, Number.POSITIVE_INFINITY])).toThrow(/有限数字/)
    expect(() => median([1, '2'])).toThrow(/有限数字/)
  })
})

describe('evaluateSoak', () => {
  it('常量默认值符合规格：每小时 12 个样本、上限 110%', () => {
    expect(DEFAULT_SAMPLES_PER_HOUR).toBe(12)
    expect(DEFAULT_GROWTH_LIMIT).toBe(1.1)
  })

  it('样本不足两个不重叠窗口时判不可判定，退出码 2', () => {
    const result = evaluateSoak(samples([100, 100, 100]))
    expect(result.judgeable).toBe(false)
    expect(result.exitCode).toBe(SOAK_EXIT.UNMEASURABLE)
    expect(result.exitCode).toBe(2)
    expect(result.reason).toContain('无法判定')
  })

  it('恰好 24 个样本（两小时）可判定', () => {
    const values = [...Array(12).fill(100), ...Array(12).fill(110)]
    const result = evaluateSoak(samples(values))
    expect(result.judgeable).toBe(true)
    expect(result.sampleCount).toBe(24)
    expect(result.firstMedian).toBeCloseTo(100)
    expect(result.lastMedian).toBeCloseTo(110)
  })

  it('末小时恰好 110% 不算超标（规格是「不超过 110%」）', () => {
    const values = [...Array(12).fill(100), ...Array(12).fill(110)]
    const result = evaluateSoak(samples(values))
    expect(result.ratio).toBeCloseTo(1.1)
    expect(result.exceeded).toBe(false)
    expect(result.exitCode).toBe(0)
  })

  it('末小时超过 110% 判超标，退出码 1', () => {
    const values = [...Array(12).fill(100), ...Array(12).fill(110.01)]
    const result = evaluateSoak(samples(values))
    expect(result.exceeded).toBe(true)
    expect(result.exitCode).toBe(SOAK_EXIT.EXCEEDED)
    expect(result.exitCode).toBe(1)
    expect(result.reason).toContain('超过')
  })

  it('只看首末窗口，中间起伏不影响判定', () => {
    const values = [
      ...Array(12).fill(100),
      ...Array(12).fill(500),
      ...Array(12).fill(105)
    ]
    const result = evaluateSoak(samples(values))
    expect(result.firstMedian).toBeCloseTo(100)
    expect(result.lastMedian).toBeCloseTo(105)
    expect(result.exceeded).toBe(false)
  })

  it('首小时中位数为 0、末小时大于 0 视为无限增长', () => {
    const values = [...Array(12).fill(0), ...Array(12).fill(50)]
    const result = evaluateSoak(samples(values))
    expect(result.ratio).toBe(Number.POSITIVE_INFINITY)
    expect(result.exceeded).toBe(true)
    expect(result.exitCode).toBe(1)
  })

  it('首末都为 0 时不判超标（比值取 1）', () => {
    const result = evaluateSoak(samples(Array(24).fill(0)))
    expect(result.ratio).toBe(1)
    expect(result.exceeded).toBe(false)
  })

  it('样本里缺少 totalBytes 时抛错，不静默当 0', () => {
    expect(() => evaluateSoak([{}, ...samples(Array(23).fill(100))])).toThrow(/totalBytes/)
  })

  it('可自定义窗口与上限', () => {
    const result = evaluateSoak(samples([100, 100, 120, 120]), { hourSamples: 2, limit: 1.15 })
    expect(result.judgeable).toBe(true)
    expect(result.firstMedian).toBeCloseTo(100)
    expect(result.lastMedian).toBeCloseTo(120)
    expect(result.exceeded).toBe(true)
  })

  it('非法参数抛错', () => {
    expect(() => evaluateSoak([], { hourSamples: 0 })).toThrow(/正整数/)
    expect(() => evaluateSoak([], { limit: 0 })).toThrow(/正数/)
  })
})

describe('toCsvRow', () => {
  const summary = summariseMemory(
    [
      { name: 'Aether', pid: 1, bytes: 40 * MB },
      { name: 'Aether', pid: 2, bytes: 20 * MB },
      { name: 'mihomo', pid: 3, bytes: 23.8 * MB }
    ],
    { appRoot: null }
  )

  it('列数与表头一致', () => {
    const row = toCsvRow({ timestamp: '2026-10-29T00:00:00.000Z', elapsedMinutes: 30, summary })
    expect(row.split(',')).toHaveLength(CSV_HEADER.split(',').length)
  })

  it('写出总量、分项与进程数', () => {
    const row = toCsvRow({ timestamp: '2026-10-29T00:00:00.000Z', elapsedMinutes: 30, summary })
    expect(row).toContain('83.8')
    expect(row).toContain('60.0')
    expect(row).toContain('23.8')
    expect(row.startsWith('2026-10-29T00:00:00.000Z,30.0,')).toBe(true)
  })

  it('缺席系列写进最后一列', () => {
    const onlyApp = summariseMemory([{ name: 'Aether', pid: 1, bytes: 5 * MB }])
    const row = toCsvRow({ timestamp: 't', elapsedMinutes: 1, summary: onlyApp })
    expect(row.endsWith('mihomo.exe')).toBe(true)
  })
})
