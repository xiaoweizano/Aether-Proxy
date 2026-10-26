#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 只扫描会进入渲染包的源文件；index.html 不参与。 */
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.css'])
const IGNORED_DIRS = new Set(['node_modules', 'out', 'dist', '.git'])
const COLOR = /#[0-9a-fA-F]{3,8}/
const FONT_SIZE = /font-size:\s*\d+px/
const TOKENS_FILE = 'tokens.css'

function walk(dir) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue
      files.push(...walk(path.join(dir, entry.name)))
      continue
    }
    if (entry.isFile() && SCAN_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(path.join(dir, entry.name))
    }
  }
  return files
}

/**
 * 扫描目录下的 .ts/.tsx/.css，返回违规列表。
 * tokens.css 是唯一定义裸值的地方，因此整体跳过。
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
