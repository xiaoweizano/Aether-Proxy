#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  formatReport,
  parseProcessOutput,
  resolveAppRoot,
  summariseMemory
} from './lib/memory.mjs'

/**
 * 常驻内存闸门：`Aether.exe` 全部进程 + `mihomo.exe` 的 Working Set 之和必须低于 150 MB。
 *
 * 用法：
 *   npm run measure:memory              测当前正在运行的应用（窗口关掉、只留托盘时最有意义）
 *   npm run measure:memory -- --minutes 5   每 15 秒采一次，跑满指定时长后取最后一次
 *
 * 退出码：
 *   0  在预算内
 *   1  超出预算
 *   2  测不了（非 Windows、PowerShell 不可用、输出形状不认识）。**这不是通过**：
 *      把工具失败与「超标」分开，CI 里才不会把一次坏掉的测量当成侥幸。
 *
 * 这里刻意不做任何「估算」：拿不到进程列表就报错退出，而不是打印一个 0 MB。
 */

const execFileAsync = promisify(execFile)
const IS_WINDOWS = process.platform === 'win32'
const SAMPLE_INTERVAL_MS = 15_000

/**
 * 进程枚举。一次 PowerShell 调用同时覆盖两个系列：
 * - `Get-Process` 给 `WorkingSet64`（私有与共享页都在内，就是任务管理器的那一列）；
 * - `Get-CimInstance Win32_Process` 补 `ExecutablePath`，用于区分同名的别家内核。
 * 先按名字粗筛，路径在 JS 侧再核对，避免 PowerShell 的字符串匹配规则参与判定。
 */
const ENUMERATE_SCRIPT = `
$ErrorActionPreference = 'Stop'
# Node 按 UTF-8 读 stdout；不设这一行，中文路径会被 PowerShell 按系统代码页输出成乱码。
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$kernels = @(Get-Process -Name mihomo -ErrorAction SilentlyContinue)
$apps = @(Get-Process -Name Aether -ErrorAction SilentlyContinue)
$all = @($apps) + @($kernels)
if ($all.Count -eq 0) { Write-Output 'null'; exit 0 }
$paths = @{}
foreach ($p in Get-CimInstance Win32_Process -Filter "Name = 'Aether.exe' OR Name = 'mihomo.exe'") {
  $paths[[int]$p.ProcessId] = $p.ExecutablePath
}
$rows = foreach ($p in $all) {
  [pscustomobject]@{
    ProcessName   = $p.ProcessName
    Id            = $p.Id
    WorkingSet64  = $p.WorkingSet64
    ExecutablePath = $paths[[int]$p.Id]
  }
}
ConvertTo-Json -InputObject @($rows) -Depth 3 -Compress
`

async function enumerate() {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ENUMERATE_SCRIPT],
    { maxBuffer: 4 * 1024 * 1024, windowsHide: true }
  )
  return parseProcessOutput(stdout)
}

function parseArgs(argv) {
  const options = { once: true, minutes: 0 }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--minutes') {
      const raw = argv[index + 1]
      const minutes = Number(raw)
      if (!Number.isFinite(minutes) || minutes <= 0) {
        throw new Error(`--minutes 需要一个正数，收到 ${JSON.stringify(raw)}`)
      }
      options.once = false
      options.minutes = minutes
      index += 1
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else {
      throw new Error(`未知参数 ${JSON.stringify(arg)}；支持 --minutes <分钟> 与 --help。`)
    }
  }
  return options
}

function print(summary) {
  for (const line of formatReport(summary)) console.log(line)
}

function summarise(records) {
  return summariseMemory(records, { appRoot: resolveAppRoot(records) })
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help === true) {
    console.log('用法：npm run measure:memory [-- --minutes <分钟>]')
    console.log('统计 Aether.exe 全部进程 + mihomo.exe 的 Working Set，合计超过 150 MB 时退出 1。')
    return 0
  }
  if (!IS_WINDOWS) {
    console.error('[measure-memory] 只支持 Windows：需要 PowerShell 的 Get-Process 与 Win32_Process。')
    return 2
  }

  if (options.once) {
    const summary = summarise(await enumerate())
    print(summary)
    return summary.overBudget ? 1 : 0
  }

  const deadline = Date.now() + options.minutes * 60_000
  let last
  while (true) {
    last = summarise(await enumerate())
    print(last)
    if (Date.now() + SAMPLE_INTERVAL_MS >= deadline) break
    await new Promise((resolve) => setTimeout(resolve, SAMPLE_INTERVAL_MS))
    console.log('—')
  }
  console.log(`\n最终一次采样（${options.minutes} 分钟内每 ${SAMPLE_INTERVAL_MS / 1000} 秒一次）：`)
  print(last)
  return last.overBudget ? 1 : 0
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    // 测量本身失败必须是独立退出码：静默吞掉会让闸门永远「通过」。
    console.error('[measure-memory] 测量失败：', error instanceof Error ? error.message : error)
    process.exitCode = 2
  }
)
