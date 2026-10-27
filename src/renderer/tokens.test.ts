import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildBaseline,
  checkTokens,
  loadBaseline,
  staleBaselineEntries
} from '../../scripts/check-tokens.mjs'
import type { TokenBaseline } from '../../scripts/check-tokens.mjs'

const rendererDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(rendererDir, '..', '..')
const baselineFile = path.join(repoRoot, 'scripts', 'token-baseline.json')

/** 临时目录测试的基线：键相对于临时目录本身，缺省为空。 */
function baselineOf(files: Record<string, Record<string, number>>): TokenBaseline {
  return { version: 1, files }
}

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'aether-tokens-'))
  try {
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('checkTokens', () => {
  it('真实渲染层目录没有绕过基线的裸色值、裸字号、裸 px 或裸圆角', () => {
    const baseline = loadBaseline(baselineFile)
    expect(checkTokens(rendererDir, { baseline, root: repoRoot })).toEqual([])
  })

  it('临时目录里的裸色值会被记为一条违规', () => {
    withTempDir((dir) => {
      // 拆开拼接，避免本测试文件自身被 token 检查命中。
      writeFileSync(path.join(dir, 'bad.css'), ['color: ', '#', 'fff', ';'].join(''))
      const violations = checkTokens(dir)
      expect(violations).toHaveLength(1)
      expect(violations[0]).toContain('bad.css')
    })
  })

  it('.html 里的 rgb()/rgba()/hsl()/hsla() 同样会被标记', () => {
    withTempDir((dir) => {
      writeFileSync(
        path.join(dir, 'bad.html'),
        [
          `<div style="color: ${'r' + 'gb('}0, 0, 0)"></div>`,
          `<div style="color: ${'h' + 'sl('}0 0% 0%)"></div>`
        ].join('\n')
      )
      const violations = checkTokens(dir)
      expect(violations).toHaveLength(2)
      expect(violations.every((line) => line.includes('bad.html'))).toBe(true)
    })
  })

  it('color-mix() 是允许的表达，不产生违规', () => {
    withTempDir((dir) => {
      writeFileSync(
        path.join(dir, 'ok.css'),
        ['background: color-mix(in srgb, ', 'var(--accent) 12%, transparent);'].join('')
      )
      expect(checkTokens(dir)).toEqual([])
    })
  })

  it('用 color-mix( 注释不能豁免同一行的裸色值', () => {
    withTempDir((dir) => {
      writeFileSync(
        path.join(dir, 'comment.css'),
        [
          `background: ${'r' + 'gb('}0, 0, 0); /* color-mix( */`,
          ['color: ', '#', 'fff', ';'].join('')
        ].join('\n')
      )
      const violations = checkTokens(dir)
      expect(violations).toHaveLength(2)
      expect(violations.every((line) => line.includes('comment.css'))).toBe(true)
    })
  })

  it('跳过 *.test.ts(x) 与 __fixtures__', () => {
    withTempDir((dir) => {
      const fixtureDir = path.join(dir, '__fixtures__')
      mkdirSync(fixtureDir)
      writeFileSync(path.join(fixtureDir, 'bad.css'), ['color: ', '#', 'fff', ';'].join(''))
      writeFileSync(path.join(dir, 'sample.test.tsx'), ['const c = ', "'", '#', 'fff', "'"].join(''))
      expect(checkTokens(dir)).toEqual([])
    })
  })
})

describe('checkTokens 裸 px 与裸圆角', () => {
  it('临时文件里新出现的裸 px 失败，并报出文件、行号与值', () => {
    withTempDir((dir) => {
      writeFileSync(path.join(dir, 'bad.css'), ['a {}', '.b { width: 18px; }'].join('\n'))
      const violations = checkTokens(dir)
      expect(violations).toHaveLength(1)
      expect(violations[0]).toContain('bad.css:2')
      expect(violations[0]).toContain('18px')
      expect(violations[0]).toContain('裸长度')
    })
  })

  it('新的 border-radius: 5px 失败', () => {
    withTempDir((dir) => {
      writeFileSync(path.join(dir, 'bad.css'), '.b { border-radius: 5px; }')
      const violations = checkTokens(dir)
      expect(violations).toHaveLength(1)
      expect(violations[0]).toContain('5px')
    })
  })

  it('border-radius: 0 通过', () => {
    withTempDir((dir) => {
      writeFileSync(path.join(dir, 'ok.css'), '.b { border-radius: 0; }')
      expect(checkTokens(dir)).toEqual([])
    })
  })

  it('1px 发丝线与 0px 通过', () => {
    withTempDir((dir) => {
      writeFileSync(
        path.join(dir, 'ok.css'),
        ['.b { border: 1px solid var(--border); outline-offset: 0px; }', '.c { margin: -1px; }'].join(
          '\n'
        )
      )
      expect(checkTokens(dir)).toEqual([])
    })
  })

  it('50% 圆角不是长度，var() 圆角通过', () => {
    withTempDir((dir) => {
      writeFileSync(
        path.join(dir, 'ok.css'),
        ['.b { border-radius: 50%; }', '.c { border-radius: var(--radius-card); }'].join('\n')
      )
      expect(checkTokens(dir)).toEqual([])
    })
  })

  it('无单位裸圆角 border-radius: 5 会被判为裸圆角', () => {
    withTempDir((dir) => {
      writeFileSync(path.join(dir, 'bad.css'), '.b { border-radius: 5; }')
      const violations = checkTokens(dir)
      expect(violations).toHaveLength(1)
      expect(violations[0]).toContain('裸圆角 5')
    })
  })

  it('rem 等非 px 长度也会被拦下', () => {
    withTempDir((dir) => {
      writeFileSync(path.join(dir, 'bad.css'), '.b { border-radius: 0.5rem; }')
      const violations = checkTokens(dir)
      expect(violations).toHaveLength(1)
      expect(violations[0]).toContain('0.5rem')
    })
  })

  it('基线允许的旧值通过', () => {
    withTempDir((dir) => {
      writeFileSync(path.join(dir, 'old.css'), '.b { width: 18px; }')
      const baseline = baselineOf({ 'old.css': { '18px': 1 } })
      expect(checkTokens(dir, { baseline, root: dir })).toEqual([])
    })
  })

  it('同一文件多出一处同值裸 px 就失败', () => {
    withTempDir((dir) => {
      writeFileSync(path.join(dir, 'old.css'), ['.a { width: 18px; }', '.b { width: 18px; }'].join('\n'))
      const baseline = baselineOf({ 'old.css': { '18px': 1 } })
      const violations = checkTokens(dir, { baseline, root: dir })
      expect(violations).toHaveLength(2)
      expect(violations.every((line) => line.includes('18px'))).toBe(true)
      expect(violations[0]).toContain('基线允许 1 处')
    })
  })

  it('tokens.css 自身豁免', () => {
    withTempDir((dir) => {
      writeFileSync(path.join(dir, 'tokens.css'), ':root { --gap: 18px; --radius: 6px; }')
      expect(checkTokens(dir)).toEqual([])
    })
  })

  it('跳过测试文件、out/、.superpowers/ 与 test', () => {
    withTempDir((dir) => {
      const outDir = path.join(dir, 'out')
      const hidden = path.join(dir, '.superpowers')
      mkdirSync(outDir)
      mkdirSync(hidden)
      writeFileSync(path.join(outDir, 'bundle.css'), '.b { width: 18px; }')
      writeFileSync(path.join(hidden, 'note.css'), '.b { width: 18px; }')
      writeFileSync(path.join(dir, 'view.test.tsx'), '<div style={{ width: "18px" }} />')
      expect(checkTokens(dir)).toEqual([])
    })
  })

  it('注释里的 px 不算违规', () => {
    withTempDir((dir) => {
      writeFileSync(
        path.join(dir, 'note.css'),
        ['/* 外壳 40px 标题栏 */', '.a { color: var(--text); } /* 内边距 18px */'].join('\n')
      )
      writeFileSync(
        path.join(dir, 'note.tsx'),
        ['// 行高 28px', 'const x = 1', '/* 列宽 120px */'].join('\n')
      )
      expect(checkTokens(dir)).toEqual([])
    })
  })

  it('script 里的 px 字符串仍算裸值，注释不能用来藏真实代码', () => {
    withTempDir((dir) => {
      writeFileSync(
        path.join(dir, 'bad.tsx'),
        ['// width: 18px', 'const style = { width: "18px" }'].join('\n')
      )
      const violations = checkTokens(dir)
      expect(violations).toHaveLength(1)
      expect(violations[0]).toContain('bad.tsx:2')
    })
  })

  it('裸字号仍然失败，且不会被裸 px 规则重复计数', () => {
    withTempDir((dir) => {
      writeFileSync(path.join(dir, 'bad.css'), '.b { font-size: 13px; }')
      const violations = checkTokens(dir)
      expect(violations).toHaveLength(1)
      expect(violations[0]).toContain('裸字号')
    })
  })
})

describe('token 基线', () => {
  it('buildBaseline 按文件与值统计，hairline 不计入', () => {
    withTempDir((dir) => {
      writeFileSync(
        path.join(dir, 'a.css'),
        ['.a { width: 18px; border-top: 1px solid var(--border); }', '.b { border-radius: 50%; }'].join(
          '\n'
        )
      )
      const baseline = buildBaseline(dir, { root: dir })
      expect(baseline.files).toEqual({ 'a.css': { '18px': 1 } })
    })
  })

  it('staleBaselineEntries 指出可以收紧的基线', () => {
    withTempDir((dir) => {
      writeFileSync(path.join(dir, 'a.css'), '.a { width: 18px; }')
      const baseline = baselineOf({ 'a.css': { '18px': 2, '34px': 1 } })
      const stale = staleBaselineEntries(dir, baseline, { root: dir })
      expect(stale).toHaveLength(2)
      expect(stale.join('\n')).toContain('18px')
      expect(stale.join('\n')).toContain('34px')
    })
  })
})
