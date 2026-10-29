/**
 * 常驻内存测量的纯函数层。
 *
 * 规格 `app-lifecycle`：`Aether.exe` 全部进程与 `mihomo.exe` 的 Working Set 之和
 * 低于 150 MB。把「跑 PowerShell」留在 `scripts/measure-memory.mjs`，把
 * 「PowerShell 输出长什么样 → 总量是多少」全部放在这里，是因为后者才是会悄悄坏掉的部分：
 * `Get-Process` 的字段名（`ProcessName` / `Id` / `WorkingSet64`）或 `Win32_Process`
 * 的字段名（`Name` / `ProcessId` / `WorkingSetSize`）一变，脚本若静默跳过就会得到
 * 一个永远通过的闸门。所以这里对未知形状一律抛错，只有「确实没有进程」才算零。
 *
 * 两个系列都可以缺席（例如内核没起、或应用没开）：缺席是有效测量，不是错误，
 * 由 `missingFamilies` 如实标出。
 */

/** 两个受测进程系列。`Aether.exe` 覆盖 Electron 的主进程、GPU、渲染与工具进程。 */
export const PROCESS_FAMILIES = Object.freeze(['Aether.exe', 'mihomo.exe'])

/** 规格预算：两者 Working Set 之和低于 150 MB。 */
export const MEMORY_BUDGET_MB = 150

const BYTES_PER_MB = 1024 * 1024

/**
 * 把进程名归一到受测系列。
 * `Get-Process` 的 `ProcessName` 不带 `.exe`，`Win32_Process` 的 `Name` 带，
 * 两条命令都可能带上 `Get-Process` 的完整路径，所以先取 basename 再比较。
 * @param {unknown} raw
 * @returns {string | null} 匹配到的 `PROCESS_FAMILIES` 成员；不属于受测系列时为 null
 */
export function normaliseProcessName(raw) {
  if (typeof raw !== 'string') return null
  const base = raw.trim().split(/[\\/]/).pop() ?? ''
  if (base === '') return null
  const withExtension = base.toLowerCase().endsWith('.exe') ? base : `${base}.exe`
  const lower = withExtension.toLowerCase()
  return PROCESS_FAMILIES.find((family) => family.toLowerCase() === lower) ?? null
}

/**
 * @param {string} text
 * @returns {string}
 */
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {number} index
 * @returns {number}
 */
function requireNumber(value, field, index) {
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof parsed !== 'number' || !Number.isFinite(parsed) || parsed < 0) {
    throw new Error(
      `PowerShell 输出的第 ${index + 1} 条进程记录缺少可用的 ${field}（收到 ${JSON.stringify(value)}）；` +
        '字段名可能已变化，闸门不能静默跳过。'
    )
  }
  return parsed
}

/**
 * @param {Record<string, unknown>} record
 * @param {number} index
 */
function toProcessRecord(record, index) {
  const name = record['Name'] ?? record['ProcessName']
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error(
      `PowerShell 输出的第 ${index + 1} 条进程记录缺少 Name/ProcessName；字段名可能已变化。`
    )
  }
  const pid = requireNumber(record['Id'] ?? record['ProcessId'], 'Id/ProcessId', index)
  const bytes = requireNumber(record['WorkingSet64'] ?? record['WorkingSetSize'], 'WorkingSet64/WorkingSetSize', index)
  const path = record['Path'] ?? record['ExecutablePath']
  return {
    name,
    pid,
    bytes,
    path: typeof path === 'string' && path !== '' ? path : null
  }
}

/**
 * 解析 PowerShell 的 JSON 输出。
 *
 * 兼容三种形态：`ConvertTo-Json` 对单条记录输出对象（不是数组）、多条记录输出数组、
 * 没有匹配进程时输出空字符串。`null` 同样按「没有进程」处理。
 * @param {unknown} text stdout 原文
 * @returns {{ name: string, pid: number, bytes: number, path: string | null }[]}
 */
export function parseProcessOutput(text) {
  if (typeof text !== 'string') {
    throw new Error('PowerShell 输出不是字符串；测量命令的调用方式可能已变化。')
  }
  const cleaned = stripBom(text).trim()
  if (cleaned === '' || cleaned === 'null') return []

  let data
  try {
    data = JSON.parse(cleaned)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`无法把 PowerShell 输出解析为 JSON（${reason}）：${cleaned.slice(0, 200)}`)
  }

  const records = Array.isArray(data) ? data : [data]
  return records.map((record, index) => {
    if (record === null || typeof record !== 'object') {
      throw new Error(`PowerShell 输出的第 ${index + 1} 条记录不是对象：${JSON.stringify(record)}`)
    }
    return toProcessRecord(/** @type {Record<string, unknown>} */ (record), index)
  })
}

/**
 * 汇总测量结果。
 *
 * 不属于两个受测系列的记录被计入 `ignoredCount` 而不是总量：命令本身已经按名字过滤，
 * 出现别的名字说明调用方放宽了过滤，把它算进预算会让闸门失去意义。
 *
 * `appRoot`（Aether.exe 所在目录）给了以后，路径不在它下面的 `mihomo.exe` 会被归为
 * 「外部内核」并**排除出总量**：这台机器上可能同时跑着别家客户端自带的 `mihomo.exe`
 * （例如 Clash Party 的 sidecar），按名字匹配会把别人的内存记到 Aether 头上。
 * 没有 Aether.exe 可参照时无从判断归属，全部计入并如实标注。
 * @param {{ name: string, pid: number, bytes: number, path?: string | null }[]} records
 * @param {{ budgetMb?: number, appRoot?: string | null }} [options]
 */
export function summariseMemory(records, options = {}) {
  const budgetMb = options.budgetMb ?? MEMORY_BUDGET_MB
  const appRoot = options.appRoot ?? null
  const entries = []
  const foreign = []
  let ignoredCount = 0

  for (const record of records) {
    const family = normaliseProcessName(record.name)
    if (family === null) {
      ignoredCount += 1
      continue
    }
    const entry = {
      family,
      name: record.name,
      pid: record.pid,
      bytes: record.bytes,
      path: record.path ?? null
    }
    if (family === 'mihomo.exe' && appRoot !== null && !isUnder(entry.path, appRoot)) {
      foreign.push(entry)
      continue
    }
    entries.push(entry)
  }

  // 固定顺序：先 Aether，再 mihomo；同系列内按 pid，输出稳定、便于比对两次测量。
  const byFamilyOrder = (left, right) => {
    const familyDelta =
      PROCESS_FAMILIES.indexOf(left.family) - PROCESS_FAMILIES.indexOf(right.family)
    return familyDelta !== 0 ? familyDelta : left.pid - right.pid
  }
  entries.sort(byFamilyOrder)
  foreign.sort(byFamilyOrder)

  /** @type {Record<string, { count: number, bytes: number }>} */
  const byFamily = {}
  for (const family of PROCESS_FAMILIES) byFamily[family] = { count: 0, bytes: 0 }
  let totalBytes = 0
  for (const entry of entries) {
    totalBytes += entry.bytes
    const bucket = byFamily[entry.family]
    if (bucket !== undefined) {
      bucket.count += 1
      bucket.bytes += entry.bytes
    }
  }

  const budgetBytes = budgetMb * BYTES_PER_MB
  return {
    entries,
    foreign,
    byFamily,
    ignoredCount,
    totalBytes,
    totalMb: totalBytes / BYTES_PER_MB,
    budgetMb,
    budgetBytes,
    // 规格是「低于 150 MB」，恰好等于预算不算超出。
    overBudget: totalBytes > budgetBytes,
    missingFamilies: PROCESS_FAMILIES.filter((family) => byFamily[family].count === 0),
    /** 没有 Aether.exe 路径可对照时，mihomo.exe 的归属无法核实。 */
    attributionVerified: appRoot !== null
  }
}

/**
 * Aether.exe 的安装目录（第一条记录的 dirname），用来判断某个 mihomo.exe 是否属于本应用。
 * 没有 Aether.exe 在跑时返回 null——那时也判断不了预算，报告里会明说。
 * @param {{ name: string, path?: string | null }[]} records
 * @returns {string | null}
 */
export function resolveAppRoot(records) {
  for (const record of records) {
    if (normaliseProcessName(record.name) !== 'Aether.exe') continue
    if (typeof record.path !== 'string' || record.path === '') continue
    const index = Math.max(record.path.lastIndexOf('\\'), record.path.lastIndexOf('/'))
    if (index > 0) return record.path.slice(0, index)
  }
  return null
}

/**
 * 汇总结果 → 退出码。
 * 0 在预算内 / 1 超出预算 / 2 没测到（缺少 Aether.exe）。2 单独一个码，
 * 是为了让 CI 区分「真的超标」与「根本没测到应用」：后者绝不能被当成通过。
 * @param {{ overBudget: boolean, missingFamilies: string[] }} summary
 * @returns {0 | 1 | 2}
 */
export function exitCodeFor(summary) {
  if (summary.missingFamilies.includes('Aether.exe')) return summary.overBudget ? 1 : 2
  return summary.overBudget ? 1 : 0
}

/**
 * @param {string | null} target
 * @param {string} root
 * @returns {boolean}
 */
function isUnder(target, root) {
  if (target === null) return false
  const normalise = (value) => value.replace(/\//g, '\\').toLowerCase().replace(/\\+$/, '')
  const child = normalise(target)
  const parent = normalise(root)
  return child === parent || child.startsWith(`${parent}\\`)
}

/**
 * `bytes` → 一位小数的 MB。
 * @param {number} bytes
 * @returns {string}
 */
export function formatMb(bytes) {
  return (bytes / BYTES_PER_MB).toFixed(1)
}

/**
 * 人可读的测量报告。分项一定带 pid 与可执行文件路径：这台机器上可能同时有
 * 别家的 `mihomo.exe`（例如 Clash Party 的 sidecar），路径是唯一能分辨它们的线索。
 * @param {ReturnType<typeof summariseMemory>} summary
 * @returns {string[]} 逐行输出
 */
export function formatReport(summary) {
  const lines = ['Aether 常驻内存测量（Aether.exe 全部进程 + mihomo.exe 的 Working Set）']

  if (summary.entries.length === 0) {
    lines.push('  没有找到任何受测进程。')
  }
  for (const entry of summary.entries) {
    const where = entry.path === null ? '（路径不可读）' : entry.path
    lines.push(`  ${entry.family.padEnd(11)} pid ${String(entry.pid).padStart(7)}  ${formatMb(entry.bytes).padStart(8)} MB  ${where}`)
  }

  for (const family of summary.missingFamilies) {
    lines.push(`  提示：没有找到 ${family} 进程；这类缺席是有效测量（例如内核未启动）。`)
  }
  if (summary.missingFamilies.includes('Aether.exe')) {
    lines.push('  警告：没有找到 Aether.exe，本次测量不包含应用本体，不能用来判断 150 MB 预算是否达标。')
  }
  if (summary.foreign.length > 0) {
    lines.push('  已排除：以下 mihomo.exe 不在 Aether 的安装目录下，属于其他程序，不计入预算。')
    for (const entry of summary.foreign) {
      lines.push(
        `    pid ${String(entry.pid).padStart(7)}  ${formatMb(entry.bytes).padStart(8)} MB  ${entry.path ?? '（路径不可读）'}`
      )
    }
  }
  if (summary.ignoredCount > 0) {
    lines.push(`  提示：忽略了 ${summary.ignoredCount} 条不属于受测系列的记录。`)
  }
  if (!summary.attributionVerified && summary.byFamily['mihomo.exe'].count > 0) {
    lines.push(
      '  警告：没有 Aether.exe 可对照，无法核实 mihomo.exe 是否属于本应用；若机器上还有别家内核，合计可能偏高。'
    )
  }

  /**
   * 没有 Aether.exe 时不能给出「在预算内」：那不是「达标」，是「没测到」。
   * 退出码仍按 overBudget 走（缺席的进程系列是有效测量），但结论行必须如实。
   */
  const verdict =
    summary.entries.length === 0
      ? '未测量（没有受测进程在运行）'
      : summary.missingFamilies.includes('Aether.exe')
        ? '未判定（缺少 Aether.exe）'
        : summary.overBudget
          ? '超出预算'
          : '在预算内'
  lines.push(`  合计 ${formatMb(summary.totalBytes)} MB / ${summary.budgetMb} MB — ${verdict}`)
  return lines
}
