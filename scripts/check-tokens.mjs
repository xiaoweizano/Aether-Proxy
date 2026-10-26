#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 扫描会进入渲染包的源文件（含 index.html）；测试与夹具不是产品代码。 */
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.css', '.html'])
const IGNORED_DIRS = new Set(['node_modules', 'out', 'dist', '.git', '__fixtures__'])
const COLOR = /#[0-9a-fA-F]{3,8}/
const FUNCTIONAL_COLOR = /\b(?:rgba?|hsla?)\(/i
const FONT_SIZE = /font-size:\s*\d+px/
const TOKENS_FILE = 'tokens.css'
const TEST_FILE = /\.test\.tsx?$/

function walk(dir) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue
      files.push(...walk(path.join(dir, entry.name)))
      continue
    }
    if (!entry.isFile() || !SCAN_EXTENSIONS.has(path.extname(entry.name))) continue
    if (TEST_FILE.test(entry.name)) continue
    files.push(path.join(dir, entry.name))
  }
  return files
}

/**
 * 扫描目录下的 .ts/.tsx/.css/.html，返回违规列表。
 * tokens.css 是唯一定义裸值的地方，因此整体跳过。
 * 测试文件与 __fixtures__ 不参与扫描。
 * @param {string} dir
 * @returns {string[]}
 */
export function checkTokens(dir) {
  const violations = []
  for (const file of walk(dir).sort()) {
    if (path.basename(file) === TOKENS_FILE) continue
    const shown = path.relative(process.cwd(), file) || file
    const lines = readFileSync(file, 'utf8').split(/\r?\n/)
    lines.forEach((line, index) => {
      const at = `${shown}:${index + 1}`
      if (COLOR.test(line)) violations.push(`${at}: 裸色值 ${line.trim()}`)
      if (!line.includes('color-mix(') && FUNCTIONAL_COLOR.test(line)) {
        violations.push(`${at}: 裸色值 ${line.trim()}`)
      }
      if (FONT_SIZE.test(line)) violations.push(`${at}: 裸字号 ${line.trim()}`)
    })
  }
  return violations
}

const isCli =
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url

if (isCli) {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url))
  const target = process.argv[2] ? path.resolve(process.argv[2]) : path.join(repoRoot, 'src', 'renderer')
  const violations = checkTokens(target)
  if (violations.length > 0) {
    console.error('token 检查失败：颜色与字号必须来自 tokens.css，不得出现裸值。')
    for (const violation of violations) console.error(`  ${violation}`)
    process.exit(1)
  }
  console.log('token 检查通过。')
}
