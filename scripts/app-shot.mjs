import { access, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

/**
 * 应用截图冒烟：用隔离的临时 profile 启动构建产物，主进程在窗口加载后截图、
 * 判定非空白并退出。必须先跑 `electron-vite build`（`npm run shot` 已经串好）。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electronBinary = path.join(
  repoRoot,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron'
)
const entry = path.join(repoRoot, 'out', 'main', 'index.js')
const output = path.join(repoRoot, 'docs', 'design', 'mockups', 'app-smoke.png')
const TIMEOUT_MS = 60_000

for (const required of [electronBinary, entry]) {
  try {
    await access(required)
  } catch {
    console.error(`截图冒烟缺少构建产物：${required}\n先运行 npm run build（或直接用 npm run shot）。`)
    process.exit(1)
  }
}

// 每次都用新的临时目录：不读真实配置，也就不可能改到真实系统代理。
const userData = await mkdtemp(path.join(tmpdir(), 'aether-shot-'))
console.log(`[shot] 临时 profile ${userData}`)

const child = spawn(electronBinary, [entry, '--shot'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    AETHER_SHOT_USER_DATA: userData,
    AETHER_SHOT_OUTPUT: output
  }
})

let settled = false
const timer = setTimeout(() => {
  if (settled) return
  settled = true
  console.error(`[shot] ${TIMEOUT_MS / 1000}s 内应用没有退出，强制结束`)
  child.kill('SIGKILL')
  process.exit(1)
}, TIMEOUT_MS)

child.once('error', (err) => {
  if (settled) return
  settled = true
  clearTimeout(timer)
  console.error('[shot] 无法启动 Electron：', err)
  process.exit(1)
})

child.once('exit', (code, signal) => {
  if (settled) return
  settled = true
  clearTimeout(timer)
  void (async () => {
    if (code !== 0) {
      console.error(`[shot] 应用退出码 ${code ?? `signal ${signal}`}，截图冒烟失败`)
      process.exitCode = code ?? 1
      return
    }
    try {
      const info = await stat(output)
      if (info.size === 0) throw new Error('截图文件为空')
      console.log(
        `[shot] 通过：${path.relative(repoRoot, output)}（${info.size} bytes）`
      )
    } catch (err) {
      console.error('[shot] 截图产物校验失败：', err)
      process.exitCode = 1
      return
    }
    // 清理临时 profile 与截图结果无关：Windows 上残留的 Electron helper 会让
    // rm 抛 EPERM/EBUSY，这里只警告，不能因此把一次成功的截图判成失败。
    try {
      await rm(userData, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200
      })
    } catch (cleanupError) {
      console.warn(`[shot] 临时 profile 未能清理，可手动删除：${userData}`, cleanupError)
    }
  })()
})
