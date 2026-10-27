#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 扫描会进入渲染包的源文件（含 index.html）；测试与夹具不是产品代码。 */
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.css', '.html'])
const IGNORED_DIRS = new Set([
  'node_modules',
  'out',
  'dist',
  'coverage',
  '.git',
  '.superpowers',
  '__fixtures__'
])
const COLOR = /#[0-9a-fA-F]{3,8}/
const FUNCTIONAL_COLOR = /\b(?:rgba?|hsla?)\(/i
const COLOR_MIX_OPEN = 'color-mix('
const FONT_SIZE = /font-size\s*:\s*\d+px/i
/** 裸 px 规则的扫描前先把 font-size 声明抠掉，避免与裸字号规则重复计数。 */
const FONT_SIZE_DECL = /font-size\s*:\s*[^;}]*/gi
/**
 * 裸 px：匹配 `18px`、`1.2px`、`-1px`。
 * 前面不能紧跟标识符字符或小数点，否则 `foo18px` 会被误判、`1.5px` 会被拆成两段。
 */
const PX = /(?<![\w.])(-?(?:\d+(?:\.\d+)?|\.\d+))px\b/gi
const RADIUS_DECL = /border-radius\s*:\s*([^;}]*)/gi
/** 圆角里的 var() 参考 tokens，本身不是裸值；先整段挖掉再按 token 检查。 */
const VAR_SEGMENT = /\bvar\([^)]*\)/gi
/** 数字 + 可选单位；`50%` 命中但百分比不是长度，后面单独放行。 */
const RADIUS_LENGTH = /^(-?(?:\d+(?:\.\d+)?|\.\d+))([a-z%]*)$/i
const LINE_COMMENT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.cts', '.cjs'])
const TOKENS_FILE = 'tokens.css'
const TEST_FILE = /\.test\.tsx?$/

/**
 * 去掉 color-mix(...) 片段（含嵌套括号的内容），只留下需要检查的其余文本。
 * 不能按整行豁免，否则 `rgb(...); /* color-mix( *␀/` 这类注释即可绕过。
 * @param {string} line
 * @returns {string}
 */
function stripColorMix(line) {
  const lower = line.toLowerCase()
  let result = ''
  let index = 0
  while (index < line.length) {
    const start = lower.indexOf(COLOR_MIX_OPEN, index)
    if (start === -1) {
      result += line.slice(index)
      break
    }
    result += line.slice(index, start)
    let depth = 0
    let cursor = start + COLOR_MIX_OPEN.length - 1
    for (; cursor < line.length; cursor += 1) {
      if (line[cursor] === '(') depth += 1
      else if (line[cursor] === ')') {
        depth -= 1
        if (depth === 0) {
          cursor += 1
          break
        }
      }
    }
    index = cursor
  }
  return result
}

/**
 * 把注释替换成等长空白，保留换行以维持行号。
 * 只对长度检查生效：色值/字号仍按原行判断，保持既有行为。
 * @param {string} text
 * @param {boolean} allowLineComments 只有 JS 系文件才有 `//` 注释；CSS 里 `//` 可能是 URL。
 * @returns {string}
 */
function stripComments(text, allowLineComments) {
  let result = ''
  let inBlock = false
  let inLine = false
  let quote = ''
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    const next = text[index + 1]
    if (inLine) {
      if (char === '\n') {
        inLine = false
        result += char
      } else result += ' '
      continue
    }
    if (inBlock) {
      if (char === '*' && next === '/') {
        result += '  '
        index += 1
        inBlock = false
      } else result += char === '\n' ? '\n' : ' '
      continue
    }
    if (quote) {
      result += char
      if (char === '\\' && next !== undefined) {
        result += next
        index += 1
      } else if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      result += char
      continue
    }
    if (char === '/' && next === '*') {
      inBlock = true
      result += '  '
      index += 1
      continue
    }
    if (allowLineComments && char === '/' && next === '/') {
      inLine = true
      result += '  '
      index += 1
      continue
    }
    result += char
  }
  return result
}

/**
 * 0 与 ±1px 是全局合法的：0 不是长度，1px 是可见的最细发丝线（边框、描边、sr-only 裁剪偏移）。
 * 其余 px 必须来自 tokens.css，或落在基线里。
 * @param {string} value 形如 `1px`、`-1px`
 * @returns {boolean}
 */
function isHairline(value) {
  const number = Number(value.replace(/px$/i, ''))
  return number === 0 || number === 1 || number === -1
}

/**
 * 找出 `border-radius` 里的裸长度。px 交给裸 px 规则（避免同一条声明报两次）；
 * 百分比不是长度；`var(...)` 参考 tokens，直接放行。
 * @param {string} codeLine 已去掉注释的行
 * @returns {string[]}
 */
function findBareRadii(codeLine) {
  const found = []
  for (const match of codeLine.matchAll(RADIUS_DECL)) {
    const value = match[1].replace(VAR_SEGMENT, ' ')
    for (const token of value.split(/[\s/]+/)) {
      if (!token) continue
      const length = token.match(RADIUS_LENGTH)
      if (!length) continue
      const [, number, unit = ''] = length
      if (unit === '%') continue
      if (unit.toLowerCase() === 'px') continue
      if (Number(number) === 0) continue
      found.push(token)
    }
  }
  return found
}

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
 * @typedef {{ line: number, kind: 'color' | 'font-size' | 'length' | 'radius', value: string }} Occurrence
 */

/**
 * 读取一个文件并收集全部违规点。行号从 1 开始。
 * @param {string} file
 * @returns {Occurrence[]}
 */
function collectOccurrences(file) {
  const text = readFileSync(file, 'utf8')
  const rawLines = text.split(/\r?\n/)
  const codeLines = stripComments(
    text,
    LINE_COMMENT_EXTENSIONS.has(path.extname(file))
  ).split(/\r?\n/)
  const occurrences = []
  rawLines.forEach((rawLine, index) => {
    const line = index + 1
    const color = rawLine.match(COLOR)
    if (color) occurrences.push({ line, kind: 'color', value: color[0] })
    const functional = stripColorMix(rawLine).match(FUNCTIONAL_COLOR)
    if (functional) occurrences.push({ line, kind: 'color', value: functional[0] })
    const fontSize = rawLine.match(FONT_SIZE)
    if (fontSize) occurrences.push({ line, kind: 'font-size', value: fontSize[0].trim() })
    const codeLine = (codeLines[index] ?? '').replace(FONT_SIZE_DECL, ' ')
    for (const match of codeLine.matchAll(PX)) {
      const value = `${match[1]}px`
      if (isHairline(value)) continue
      occurrences.push({ line, kind: 'length', value })
    }
    for (const value of findBareRadii(codeLine)) {
      occurrences.push({ line, kind: 'radius', value })
    }
  })
  return occurrences
}

/**
 * @param {string} root
 * @param {string} file
 * @returns {string}
 */
function baselineKey(root, file) {
  return path.relative(root, file).split(path.sep).join('/')
}

/**
 * @param {Occurrence[]} occurrences
 * @returns {Map<string, number>}
 */
function countLengthValues(occurrences) {
  const counts = new Map()
  for (const occurrence of occurrences) {
    if (occurrence.kind !== 'length' && occurrence.kind !== 'radius') continue
    counts.set(occurrence.value, (counts.get(occurrence.value) ?? 0) + 1)
  }
  return counts
}

/**
 * @param {string} file
 * @param {string} shown
 * @param {Record<string, number>} allowed 该文件在基线里允许出现的值 → 次数
 * @returns {string[]}
 */
function checkFile(file, shown, allowed) {
  const occurrences = collectOccurrences(file)
  const counts = countLengthValues(occurrences)
  const violations = []
  for (const occurrence of occurrences) {
    const at = `${shown}:${occurrence.line}`
    if (occurrence.kind === 'color') {
      violations.push(`${at}: 裸色值 ${occurrence.value}`)
      continue
    }
    if (occurrence.kind === 'font-size') {
      violations.push(`${at}: 裸字号 ${occurrence.value}`)
      continue
    }
    const label = occurrence.kind === 'length' ? '裸长度' : '裸圆角'
    const allowedCount = allowed[occurrence.value] ?? 0
    const actualCount = counts.get(occurrence.value) ?? 0
    if (actualCount <= allowedCount) continue
    const suffix =
      allowedCount > 0
        ? `（基线允许 ${allowedCount} 处，本文件现有 ${actualCount} 处）`
        : '（基线未包含）'
    violations.push(`${at}: ${label} ${occurrence.value}${suffix}`)
  }
  return violations
}

/**
 * 扫描目录下的 .ts/.tsx/.css/.html，返回违规列表。
 * tokens.css 是唯一定义裸值的地方，因此整体跳过。
 * 测试文件与 __fixtures__ 不参与扫描。
 * @param {string} dir
 * @param {{ baseline?: import('./check-tokens.d.mts').TokenBaseline, root?: string }} [options]
 *   baseline 允许历史裸值按“文件 + 值 + 次数”继续存在；root 是基线路径的相对基准。
 * @returns {string[]}
 */
export function checkTokens(dir, options = {}) {
  const root = options.root ? path.resolve(options.root) : process.cwd()
  const baseline = options.baseline ?? { version: 1, files: {} }
  const violations = []
  for (const file of walk(dir).sort()) {
    if (path.basename(file) === TOKENS_FILE) continue
    const shown = path.relative(process.cwd(), file) || file
    const allowed = baseline.files?.[baselineKey(root, file)] ?? {}
    violations.push(...checkFile(file, shown, allowed))
  }
  return violations
}

/**
 * 把当前树的裸长度/圆角固化成基线。键按文件与值计数，不含行号，
 * 因此无关编辑不会让基线失效；代价是同一文件里“删一处、加一处同值”会静默通过。
 * @param {string} dir
 * @param {{ root?: string }} [options]
 * @returns {import('./check-tokens.d.mts').TokenBaseline}
 */
export function buildBaseline(dir, options = {}) {
  const root = options.root ? path.resolve(options.root) : process.cwd()
  /** @type {Record<string, Record<string, number>>} */
  const files = {}
  for (const file of walk(dir).sort()) {
    if (path.basename(file) === TOKENS_FILE) continue
    const counts = countLengthValues(collectOccurrences(file))
    if (counts.size === 0) continue
    const sorted = {}
    for (const value of [...counts.keys()].sort()) sorted[value] = counts.get(value)
    files[baselineKey(root, file)] = sorted
  }
  return {
    version: 1,
    note: '历史裸 px / 裸圆角基线：允许清单内的旧值继续存在，新增即失败。用 npm run check:tokens -- --write-baseline 收紧。',
    files
  }
}

/**
 * @param {string} file
 * @returns {import('./check-tokens.d.mts').TokenBaseline}
 */
export function loadBaseline(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

/**
 * 列出基线里比现状更宽松的条目，提示可以收紧。
 * 只警告不失败：清理旧值不应该反过来阻塞无关的可视化任务。
 * @param {string} dir
 * @param {import('./check-tokens.d.mts').TokenBaseline} baseline
 * @param {{ root?: string }} [options]
 * @returns {string[]}
 */
export function staleBaselineEntries(dir, baseline, options = {}) {
  const root = options.root ? path.resolve(options.root) : process.cwd()
  const warnings = []
  const seen = new Set()
  for (const file of walk(dir).sort()) {
    if (path.basename(file) === TOKENS_FILE) continue
    const key = baselineKey(root, file)
    seen.add(key)
    const current = countLengthValues(collectOccurrences(file))
    for (const [value, allowedCount] of Object.entries(baseline.files?.[key] ?? {})) {
      const actualCount = current.get(value) ?? 0
      if (actualCount < allowedCount) {
        warnings.push(`${key}: ${value} 基线允许 ${allowedCount} 处，现有 ${actualCount} 处`)
      }
    }
  }
  for (const key of Object.keys(baseline.files ?? {})) {
    if (!seen.has(key)) warnings.push(`${key}: 文件已不存在或不再被扫描`)
  }
  return warnings
}

const isCli =
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url

if (isCli) {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url))
  const args = process.argv.slice(2)
  const writeBaseline = args.includes('--write-baseline')
  const targetArg = args.find((arg) => !arg.startsWith('--'))
  const target = targetArg ? path.resolve(targetArg) : path.join(repoRoot, 'src', 'renderer')
  const baselineFile = path.join(repoRoot, 'scripts', 'token-baseline.json')

  if (writeBaseline) {
    const baseline = buildBaseline(target, { root: repoRoot })
    const fileCount = Object.keys(baseline.files).length
    let occurrenceCount = 0
    for (const counts of Object.values(baseline.files)) {
      for (const count of Object.values(counts)) occurrenceCount += count
    }
    writeFileSync(baselineFile, `${JSON.stringify(baseline, null, 2)}\n`)
    console.log(
      `token 基线已写入 ${path.relative(process.cwd(), baselineFile)}：${occurrenceCount} 处裸长度/圆角，覆盖 ${fileCount} 个文件。`
    )
    process.exit(0)
  }

  const baseline = existsSync(baselineFile)
    ? loadBaseline(baselineFile)
    : { version: 1, files: {} }
  const violations = checkTokens(target, { baseline, root: repoRoot })
  if (violations.length > 0) {
    console.error(
      'token 检查失败：颜色、字号、长度与圆角必须来自 tokens.css，不得出现裸值。历史裸值只能通过 scripts/token-baseline.json 放行。'
    )
    for (const violation of violations) console.error(`  ${violation}`)
    process.exit(1)
  }
  for (const warning of staleBaselineEntries(target, baseline, { root: repoRoot })) {
    console.warn(`基线可收紧：${warning}（npm run check:tokens -- --write-baseline）`)
  }
  console.log('token 检查通过。')
}
