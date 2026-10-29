import { describe, expect, it } from 'vitest'
import {
  formatBytes,
  formatClock,
  formatDelay,
  formatDuration,
  formatRate,
  formatWindow,
  UNKNOWN
} from './format'

describe('formatBytes', () => {
  it('0 字节显示真实零值而不是占位符', () => {
    expect(formatBytes(0)).toBe('0 B')
  })

  it('小于 1 KB 用整数字节', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1023)).toBe('1023 B')
  })

  it('KB 与 MB 保留一位小数', () => {
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(1024 * 1024 * 1.2)).toBe('1.2 MB')
    expect(formatBytes(1024 * 1024 * 2.7)).toBe('2.7 MB')
  })

  it('GB 继续进位', () => {
    expect(formatBytes(1024 * 1024 * 1024 * 1.5)).toBe('1.5 GB')
  })

  it('非法值显示破折号，不显示 NaN', () => {
    expect(formatBytes(Number.NaN)).toBe(UNKNOWN)
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe(UNKNOWN)
    expect(formatBytes(-1)).toBe(UNKNOWN)
  })
})

describe('formatRate', () => {
  it('空闲时显示 0.00 MB/s', () => {
    expect(formatRate(0)).toBe('0.00 MB/s')
  })

  it('按 MB/s 保留两位小数', () => {
    expect(formatRate(1024 * 1024)).toBe('1.00 MB/s')
    expect(formatRate(1024 * 1024 * 1.5)).toBe('1.50 MB/s')
    expect(formatRate(566231)).toBe('0.54 MB/s')
  })

  it('非法值显示破折号', () => {
    expect(formatRate(Number.NaN)).toBe(UNKNOWN)
    expect(formatRate(-5)).toBe(UNKNOWN)
  })
})

describe('formatDuration', () => {
  it('0 显示 00:00:00', () => {
    expect(formatDuration(0)).toBe('00:00:00')
  })

  it('按 HH:MM:SS 补零', () => {
    expect(formatDuration(1000)).toBe('00:00:01')
    expect(formatDuration(65 * 1000)).toBe('00:01:05')
    expect(formatDuration((3600 + 10 * 60 + 54) * 1000)).toBe('01:10:54')
  })

  it('非法值显示破折号', () => {
    expect(formatDuration(Number.NaN)).toBe(UNKNOWN)
    expect(formatDuration(-1)).toBe(UNKNOWN)
  })
})

describe('formatDelay', () => {
  it('毫秒整数加 ms 后缀', () => {
    expect(formatDelay(0)).toBe('0ms')
    expect(formatDelay(38)).toBe('38ms')
  })

  it('没有测速记录时是未知，不是 0ms', () => {
    expect(formatDelay(undefined)).toBe(UNKNOWN)
  })

  it('非法值显示破折号', () => {
    expect(formatDelay(Number.NaN)).toBe(UNKNOWN)
    expect(formatDelay(-1)).toBe(UNKNOWN)
  })
})

describe('formatClock', () => {
  it('按本地时间显示 HH:MM:SS', () => {
    const at = new Date(2026, 0, 2, 13, 31, 13).getTime()
    expect(formatClock(at)).toBe('13:31:13')
    expect(formatClock(new Date(2026, 0, 2, 9, 5, 7).getTime())).toBe('09:05:07')
  })

  it('非法值显示破折号', () => {
    expect(formatClock(Number.NaN)).toBe(UNKNOWN)
  })
})

describe('formatWindow', () => {
  it('一小时窗口写成 60 分钟，与既有「最近 60 分钟」文案一致', () => {
    expect(formatWindow(60 * 60_000)).toBe('60 分钟')
  })

  it('窗口长度来自调用方，不写死：窗口换了文案跟着换', () => {
    expect(formatWindow(5 * 60_000)).toBe('5 分钟')
    expect(formatWindow(90 * 60_000)).toBe('90 分钟')
  })

  it('不足一分钟以秒表示', () => {
    expect(formatWindow(30_000)).toBe('30 秒')
  })

  it('非法值显示破折号，绝不退回到某个默认分钟数', () => {
    expect(formatWindow(Number.NaN)).toBe(UNKNOWN)
    expect(formatWindow(0)).toBe(UNKNOWN)
    expect(formatWindow(-1)).toBe(UNKNOWN)
    expect(formatWindow(Number.POSITIVE_INFINITY)).toBe(UNKNOWN)
  })
})
