#!/usr/bin/env node
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  enumerateProcesses,
  resolveAppRoot,
  summariseMemory
} from './lib/memory.mjs'
import {
  CSV_HEADER,
  DEFAULT_GROWTH_LIMIT,
  DEFAULT_SAMPLES_PER_HOUR,
  SOAK_EXIT,
  evaluateSoak,
  toCsvRow
} from './lib/soak.mjs'

/**
 * 8 小时长稳采样（规格 8.4）。
 *
 * 流程：先预热 `warmupMinutes`（默认 30），然后每 `intervalMinutes`（默认 5）采一次内存，
 * 边采边追加 CSV；结束时把「采样阶段」的样本交给 `lib/soak.mjs` 判定：
 * 末小时中位数超过首小时 110% → 退出 1。
 *
 * 用法：
 *   node scripts/soak.mjs                                 默认预热 30 分钟 + 采样 8 小时
 *   node scripts/soak.mjs --hours 8 --out docs/soak.csv
 *   node scripts/soak.mjs --quick                         15 秒预热 + 每 2 秒采样、共 60 个点（自测用）
 *   node scripts/soak.mjs --hours 8 --resume docs/soak.csv 续跑：追加到已有 CSV，并在其上判定
 *
 * 退出码（与 measure-memory.mjs 的 0/1/2 约定一致）：
 *   0  稳定：末小时中位数不超过首小时的 110%
 *   1  增长：超过 110%
 *   2  测不了：非 Windows、PowerShell/枚举失败、采样期间没有任何受测进程、
 *      或样本不足两个不重叠小时。**这不是通过**。
 *
 * 预热与采样时长是时间常量，不影响判定；判定只看 CSV 里的样本序列，因此
 * `--quick` 也能走完全部代码路径（含真实 PowerShell 枚举），只是窗口会缩成
 * 12 个样本的「模拟小时」——`--quick` 把 hourSamples 设为 30，凑够 60 点才可判定。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const IS_WINDOWS = process.platform === 'win32'

const DEFAULTS = Object.freeze({
  warmupMinutes: 30,
  intervalMinutes: 5,
  hours: 8,
  limit: DEFAULT_GROWTH_LIMIT,
  hourSamples: DEFAULT_SAMPLES_PER_HOUR,
  resume: null,
  out: null
})

function parseArgs(argv) {
  const options = { ...DEFAULTS }
  /** @param {string} raw @param {string} name */
  const positive = (raw, name) => {
    const value = Number(raw)
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${name} 需要一个正数，收到 ${JSON.stringify(raw)}`)
    }
    return value
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      const raw = argv[index + 1]
      if (raw === undefined) throw new Error(`${arg} 缺少值`)
      index += 1
      return raw
    }
    switch (arg) {
      case '--hours':
        options.hours = positive(next(), '--hours')
        break
      case '--warmup-minutes':
        options.warmupMinutes = positive(next(), '--warmup-minutes')
        break
      case '--interval-minutes':
        options.intervalMinutes = positive(next(), '--interval-minutes')
        break
      case '--limit':
        options.limit = positive(next(), '--limit')
        break
      case '--hour-samples': {
        const raw = next()
        const value = positive(raw, '--hour-samples')
        if (!Number.isInteger(value)) throw new Error(`--hour-samples 必须是整数，收到 ${raw}`)
        options.hourSamples = value
        break
      }
      case '--out':
        options.out = path.resolve(process.cwd(), next())
        break
      case '--resume':
        options.resume = path.resolve(process.cwd(), next())
        break
      case '--quick':
        options.warmupMinutes = 0.25
        options.intervalMinutes = 1 / 30
        options.hours = 60 / 3600
        options.hourSamples = 30
        break
      case '--help':
      case '-h':
        options.help = true
        break
      default:
        throw new Error(
          `未知参数 ${JSON.stringify(arg)}；支持 --hours / --warmup-minutes / --interval-minutes / ` +
            '--limit / --hour-samples / --out / --resume / --quick / --help。'
        )
    }
  }
  return options
}

function helpText() {
  return [
    '用法：node scripts/soak.mjs [--hours 8] [--out <csv>] [--resume <csv>] [--quick]',
    '',
    '  预热 30 分钟后每 5 分钟采样一次内存，写 CSV；',
    '  末小时中位数超过首小时 110% 时退出 1；测不了退出 2；稳定退出 0。'
  ].join('\n')
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 只读 CSV 里 `total_mb` 一列，用于 `--resume` 时把历史样本并入判定。 */
async function readResumeSamples(file) {
  const { readFile } = await import('node:fs/promises')
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') throw new Error(`--resume 指向的文件不存在：${file}`)
    throw error
  }
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '')
  if (lines.length === 0 || lines[0] !== CSV_HEADER) {
    throw new Error(`--resume 的文件表头与当前版本不一致，无法续跑：${file}`)
  }
  const samples = []
  for (const line of lines.slice(1)) {
    const columns = line.split(',')
    const total = Number(columns[2])
    if (!Number.isFinite(total) || total < 0) {
      throw new Error(`--resume 的文件有无法解析的 total_mb 行：${line}`)
    }
    samples.push({ totalBytes: total * 1024 * 1024 })
  }
  return samples
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help === true) {
    console.log(helpText())
    return 0
  }
  if (!IS_WINDOWS) {
    console.error('[soak] 只支持 Windows：需要 PowerShell 的 Get-Process 与 Win32_Process。')
    return SOAK_EXIT.UNMEASURABLE
  }

  const intervalMs = options.intervalMinutes * 60_000
  const warmupMs = options.warmupMinutes * 60_000
  const totalSamples = Math.max(
    options.hourSamples * 2,
    Math.round((options.hours * 60) / options.intervalMinutes)
  )

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const out = options.out ?? path.join(repoRoot, 'docs', 'soak', `soak-${stamp}.csv`)
  await mkdir(path.dirname(out), { recursive: true })

  const samples = options.resume === null ? [] : await readResumeSamples(options.resume)
  if (options.resume === null) await writeFile(out, `${CSV_HEADER}\n`, 'utf8')

  console.log(
    `[soak] CSV：${out}\n` +
      `[soak] 预热 ${options.warmupMinutes} 分钟，之后每 ${options.intervalMinutes} 分钟采样，` +
      `计划 ${totalSamples} 个点；判定窗口 ${options.hourSamples} 个样本/小时、上限 ${(options.limit * 100).toFixed(0)}%`
  )
  if (options.resume !== null) console.log(`[soak] 续跑：已并入 ${samples.length} 个历史样本`)

  await sleep(warmupMs)

  const startedAt = Date.now()
  for (let index = 0; index < totalSamples; index += 1) {
    let summary
    try {
      const records = await enumerateProcesses()
      summary = summariseMemory(records, { appRoot: resolveAppRoot(records) })
    } catch (error) {
      console.error('[soak] 枚举进程失败，测量中断：', error instanceof Error ? error.message : error)
      return SOAK_EXIT.UNMEASURABLE
    }

    const timestamp = new Date().toISOString()
    const elapsedMinutes = (Date.now() - startedAt) / 60_000
    const row = toCsvRow({ timestamp, elapsedMinutes, summary })
    await appendFile(out, `${row}\n`, 'utf8')
    samples.push({ totalBytes: summary.totalBytes })

    const missing =
      summary.missingFamilies.length === 0 ? '' : `  缺席：${summary.missingFamilies.join(' ')}`
    console.log(
      `[soak] ${String(index + 1).padStart(4)}/${totalSamples}  ${timestamp}  ` +
        `${(summary.totalBytes / (1024 * 1024)).toFixed(1)} MB${missing}`
    )

    if (index < totalSamples - 1) await sleep(intervalMs)
  }

  const result = evaluateSoak(samples, { hourSamples: options.hourSamples, limit: options.limit })
  console.log(`\n[soak] ${result.judgeable ? '判定' : '无法判定'}：${result.reason}`)
  if (result.judgeable) {
    console.log(
      `[soak] 首小时中位数 ${result.firstMedian.toFixed(1)} MB → 末小时中位数 ` +
        `${result.lastMedian.toFixed(1)} MB（比值 ${result.ratio.toFixed(3)}）`
    )
  }
  console.log(`[soak] CSV 已写入 ${out}`)
  return result.exitCode
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    console.error('[soak] 运行失败：', error instanceof Error ? error.message : error)
    process.exitCode = SOAK_EXIT.UNMEASURABLE
  }
)
