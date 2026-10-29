import { describe, expect, it } from 'vitest'
import {
  MEMORY_BUDGET_MB,
  PROCESS_FAMILIES,
  exitCodeFor,
  formatMb,
  formatReport,
  normaliseProcessName,
  parseProcessOutput,
  resolveAppRoot,
  summariseMemory
} from './memory.mjs'

const MB = 1024 * 1024

/** `Get-Process | Select-Object ProcessName,Id,WorkingSet64` 的真实形状（名字不带 .exe）。 */
const GET_PROCESS_SHAPE = JSON.stringify([
  { ProcessName: 'Aether', Id: 100, WorkingSet64: 40 * MB },
  { ProcessName: 'Aether', Id: 101, WorkingSet64: 20 * MB },
  { ProcessName: 'mihomo', Id: 102, WorkingSet64: 23.8 * MB }
])

describe('normaliseProcessName', () => {
  it('把 Get-Process 的无扩展名与 Win32_Process 的带扩展名归一', () => {
    expect(normaliseProcessName('Aether')).toBe('Aether.exe')
    expect(normaliseProcessName('Aether.exe')).toBe('Aether.exe')
    expect(normaliseProcessName('MIHOMO.EXE')).toBe('mihomo.exe')
    expect(normaliseProcessName('mihomo')).toBe('mihomo.exe')
  })

  it('接受完整路径，取 basename', () => {
    expect(normaliseProcessName('D:\\a-proxy\\vendor\\mihomo.exe')).toBe('mihomo.exe')
    expect(normaliseProcessName('/opt/aether/mihomo')).toBe('mihomo.exe')
  })

  it('不认识的名字返回 null，而不是猜一个系列', () => {
    expect(normaliseProcessName('clash-party')).toBeNull()
    expect(normaliseProcessName('AetherPro')).toBeNull()
    expect(normaliseProcessName(null)).toBeNull()
    expect(normaliseProcessName('')).toBeNull()
  })
})

describe('parseProcessOutput', () => {
  it('解析 Get-Process 的数组输出', () => {
    const records = parseProcessOutput(GET_PROCESS_SHAPE)
    expect(records).toHaveLength(3)
    expect(records[0]).toEqual({ name: 'Aether', pid: 100, bytes: 40 * MB, path: null })
  })

  it('单条记录时 ConvertTo-Json 输出对象而非数组，也要解析', () => {
    const records = parseProcessOutput(
      JSON.stringify({ ProcessName: 'mihomo', Id: 7, WorkingSet64: 5 * MB })
    )
    expect(records).toEqual([{ name: 'mihomo', pid: 7, bytes: 5 * MB, path: null }])
  })

  it('没有匹配进程时输出空串或 null，都算空表', () => {
    expect(parseProcessOutput('')).toEqual([])
    expect(parseProcessOutput('  \r\n')).toEqual([])
    expect(parseProcessOutput('null')).toEqual([])
  })

  it('容忍 BOM 与 Win32_Process 的字段名', () => {
    const text = `\uFEFF${JSON.stringify([
      { Name: 'Aether.exe', ProcessId: 9, WorkingSetSize: 3 * MB, ExecutablePath: 'C:\\A\\Aether.exe' }
    ])}`
    expect(parseProcessOutput(text)).toEqual([
      { name: 'Aether.exe', pid: 9, bytes: 3 * MB, path: 'C:\\A\\Aether.exe' }
    ])
  })

  it('字段改名后必须抛错，不能静默跳过让闸门永远通过', () => {
    expect(() => parseProcessOutput(JSON.stringify([{ Name: 'Aether', Id: 1, WsSize: 123 }]))).toThrow(
      /WorkingSet64/
    )
    expect(() => parseProcessOutput(JSON.stringify([{ Id: 1, WorkingSet64: 123 }]))).toThrow(/Name/)
    expect(() => parseProcessOutput(JSON.stringify([{ ProcessName: 'Aether', WorkingSet64: 1 }]))).toThrow(
      /Id/
    )
  })

  it('拒绝非数字、负数与非对象记录', () => {
    expect(() =>
      parseProcessOutput(JSON.stringify([{ ProcessName: 'Aether', Id: 1, WorkingSet64: 'abc' }]))
    ).toThrow(/WorkingSet64/)
    expect(() =>
      parseProcessOutput(JSON.stringify([{ ProcessName: 'Aether', Id: 1, WorkingSet64: -5 }]))
    ).toThrow(/WorkingSet64/)
    expect(() => parseProcessOutput(JSON.stringify([42]))).toThrow(/不是对象/)
  })

  it('无法解析的 JSON 抛错并带上片段', () => {
    expect(() => parseProcessOutput('Get-Process : 找不到进程')).toThrow(/JSON/)
  })
})

describe('summariseMemory', () => {
  const parse = (text) => summariseMemory(parseProcessOutput(text))

  it('汇总全部 Aether.exe 进程与 mihomo.exe', () => {
    const summary = parse(GET_PROCESS_SHAPE)
    expect(summary.totalBytes).toBe(83.8 * MB)
    expect(summary.byFamily['Aether.exe']).toEqual({ count: 2, bytes: 60 * MB })
    expect(summary.byFamily['mihomo.exe']).toEqual({ count: 1, bytes: 23.8 * MB })
    expect(summary.missingFamilies).toEqual([])
    expect(summary.overBudget).toBe(false)
  })

  it('少了内核是有效测量，不是错误', () => {
    const summary = parse(
      JSON.stringify([{ ProcessName: 'Aether', Id: 1, WorkingSet64: 10 * MB }])
    )
    expect(summary.totalBytes).toBe(10 * MB)
    expect(summary.missingFamilies).toEqual(['mihomo.exe'])
    expect(summary.overBudget).toBe(false)
  })

  it('两个系列都没起：总量为零，两个系列都标为缺席', () => {
    const summary = parse('')
    expect(summary.totalBytes).toBe(0)
    expect(summary.missingFamilies).toEqual([...PROCESS_FAMILIES])
    expect(summary.overBudget).toBe(false)
  })

  it('超过 150 MB 判超标，恰好 150 MB 不算', () => {
    const at = (bytes) =>
      parse(JSON.stringify([{ ProcessName: 'Aether', Id: 1, WorkingSet64: bytes }]))
    expect(at(150 * MB).overBudget).toBe(false)
    expect(at(150 * MB + 1).overBudget).toBe(true)
    expect(MEMORY_BUDGET_MB).toBe(150)
  })

  it('不属于受测系列的记录不计入总量', () => {
    const records = parseProcessOutput(
      JSON.stringify([
        { ProcessName: 'Aether', Id: 1, WorkingSet64: 10 * MB },
        { ProcessName: 'clash-party', Id: 2, WorkingSet64: 999 * MB }
      ])
    )
    const summary = summariseMemory(records)
    expect(summary.totalBytes).toBe(10 * MB)
    expect(summary.ignoredCount).toBe(1)
    expect(summary.entries).toHaveLength(1)
  })

  it('输出顺序稳定：Aether 在前，同系列按 pid', () => {
    const summary = parse(
      JSON.stringify([
        { ProcessName: 'mihomo', Id: 99, WorkingSet64: 1 * MB },
        { ProcessName: 'Aether', Id: 20, WorkingSet64: 1 * MB },
        { ProcessName: 'Aether', Id: 3, WorkingSet64: 1 * MB }
      ])
    )
    expect(summary.entries.map((entry) => entry.pid)).toEqual([3, 20, 99])
  })
})

describe('mihomo 归属：别家内核不能记到 Aether 头上', () => {
  const APP = 'C:\\Program Files\\Aether\\Aether.exe'
  const OWN_KERNEL = 'C:\\Program Files\\Aether\\resources\\mihomo.exe'
  const FOREIGN_KERNEL = 'D:\\科学上网\\mihomo\\Clash Party\\resources\\sidecar\\mihomo.exe'

  const records = parseProcessOutput(
    JSON.stringify([
      { ProcessName: 'Aether', Id: 10, WorkingSet64: 50 * MB, ExecutablePath: APP },
      { ProcessName: 'mihomo', Id: 11, WorkingSet64: 20 * MB, ExecutablePath: OWN_KERNEL },
      { ProcessName: 'mihomo', Id: 12, WorkingSet64: 300 * MB, ExecutablePath: FOREIGN_KERNEL }
    ])
  )

  it('resolveAppRoot 取 Aether.exe 所在目录；没有 Aether.exe 时为 null', () => {
    expect(resolveAppRoot(records)).toBe('C:\\Program Files\\Aether')
    expect(resolveAppRoot(parseProcessOutput(''))).toBeNull()
    expect(
      resolveAppRoot([{ name: 'Aether', pid: 1, bytes: 1, path: null }])
    ).toBeNull()
  })

  it('只计 Aether 目录下的 mihomo.exe，外部内核单独列出且不参与总量', () => {
    const summary = summariseMemory(records, { appRoot: resolveAppRoot(records) })
    expect(summary.totalBytes).toBe(70 * MB)
    expect(summary.foreign).toHaveLength(1)
    expect(summary.foreign[0]?.pid).toBe(12)
    expect(summary.byFamily['mihomo.exe'].count).toBe(1)
    expect(summary.attributionVerified).toBe(true)
  })

  it('外部内核超过预算也不会误判超标', () => {
    const summary = summariseMemory(records, { appRoot: resolveAppRoot(records) })
    expect(summary.overBudget).toBe(false)
  })

  it('路径大小写与斜杠差异不影响归属', () => {
    const summary = summariseMemory(
      [
        { name: 'Aether', pid: 10, bytes: 1 * MB, path: 'C:/Program Files/Aether/Aether.exe' },
        {
          name: 'mihomo',
          pid: 11,
          bytes: 2 * MB,
          path: 'c:\\program files\\aether\\resources\\mihomo.exe'
        }
      ],
      { appRoot: 'C:\\Program Files\\Aether' }
    )
    expect(summary.entries).toHaveLength(2)
    expect(summary.foreign).toHaveLength(0)
  })

  it('没有 appRoot 时全部计入，并标明归属无法核实', () => {
    const summary = summariseMemory(records)
    expect(summary.totalBytes).toBe(370 * MB)
    expect(summary.foreign).toHaveLength(0)
    expect(summary.attributionVerified).toBe(false)
    expect(formatReport(summary).join('\n')).toContain('无法核实')
  })

  it('路径不可读的 mihomo.exe 视为无法归属，不静默计入', () => {
    const summary = summariseMemory(
      [{ name: 'mihomo', pid: 11, bytes: 5 * MB, path: null }],
      { appRoot: 'C:\\Program Files\\Aether' }
    )
    expect(summary.totalBytes).toBe(0)
    expect(summary.foreign).toHaveLength(1)
  })

  it('报告把被排除的外部内核连同路径写出来', () => {
    const summary = summariseMemory(records, { appRoot: resolveAppRoot(records) })
    const text = formatReport(summary).join('\n')
    expect(text).toContain('已排除')
    expect(text).toContain('Clash Party')
    expect(text).toContain('合计 70.0 MB')
  })
})

describe('输出格式', () => {
  it('MB 保留一位小数', () => {
    expect(formatMb(0)).toBe('0.0')
    expect(formatMb(23.8 * MB)).toBe('23.8')
  })

  it('报告含分项、pid 与合计', () => {
    const summary = summariseMemory(parseProcessOutput(GET_PROCESS_SHAPE))
    const text = formatReport(summary).join('\n')
    expect(text).toContain('Aether.exe')
    expect(text).toContain('mihomo.exe')
    expect(text).toContain('pid     100')
    expect(text).toContain('23.8 MB')
    expect(text).toContain('合计 83.8 MB / 150 MB')
    expect(text).toContain('在预算内')
  })

  it('没有 Aether.exe 时明确说这次测量不能判断预算', () => {
    const summary = summariseMemory(
      parseProcessOutput(JSON.stringify([{ ProcessName: 'mihomo', Id: 5, WorkingSet64: MB }]))
    )
    const text = formatReport(summary).join('\n')
    expect(text).toContain('没有找到 Aether.exe')
    expect(text).toContain('不能用来判断 150 MB 预算')
  })

  it('超标时报告写明超出预算', () => {
    const summary = summariseMemory(
      parseProcessOutput(
        JSON.stringify([{ ProcessName: 'Aether', Id: 1, WorkingSet64: 200 * MB }])
      )
    )
    expect(formatReport(summary).join('\n')).toContain('超出预算')
  })

  it('什么都没在跑时不写「在预算内」：那是没测到，不是达标', () => {
    const text = formatReport(summariseMemory([])).join('\n')
    expect(text).toContain('未测量')
    expect(text).not.toContain('在预算内')
  })

  it('只有内核、没有 Aether.exe 时结论是未判定', () => {
    const summary = summariseMemory(
      parseProcessOutput(
        JSON.stringify([{ ProcessName: 'mihomo', Id: 5, WorkingSet64: 5 * MB }])
      )
    )
    const text = formatReport(summary).join('\n')
    expect(text).toContain('未判定')
    expect(text).not.toContain('在预算内')
  })
})

describe('exitCodeFor', () => {
  const summarise = (bytes) =>
    summariseMemory(
      parseProcessOutput(
        JSON.stringify([{ ProcessName: 'Aether', Id: 1, WorkingSet64: bytes }])
      )
    )

  it('在预算内 0，超出 1', () => {
    expect(exitCodeFor(summarise(100 * MB))).toBe(0)
    expect(exitCodeFor(summarise(200 * MB))).toBe(1)
  })

  it('缺少 Aether.exe 时是 2（没测到），不是 0（通过）', () => {
    const summary = summariseMemory(
      parseProcessOutput(JSON.stringify([{ ProcessName: 'mihomo', Id: 5, WorkingSet64: MB }]))
    )
    expect(exitCodeFor(summary)).toBe(2)
  })

  it('外部内核虽大但已排除时仍按真实总量判定', () => {
    const records = parseProcessOutput(
      JSON.stringify([
        { ProcessName: 'Aether', Id: 1, WorkingSet64: 100 * MB, ExecutablePath: 'C:\A\Aether.exe' },
        {
          ProcessName: 'mihomo',
          Id: 2,
          WorkingSet64: 400 * MB,
          ExecutablePath: 'D:\Other\mihomo.exe'
        }
      ])
    )
    expect(exitCodeFor(summariseMemory(records, { appRoot: 'C:\A' }))).toBe(0)
  })
})
