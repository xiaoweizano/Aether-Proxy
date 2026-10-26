import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkTokens } from '../../scripts/check-tokens.mjs'

const rendererDir = path.dirname(fileURLToPath(import.meta.url))

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'aether-tokens-'))
  try {
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('checkTokens', () => {
  it('真实渲染层目录没有裸色值或裸字号', () => {
    expect(checkTokens(rendererDir)).toEqual([])
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
