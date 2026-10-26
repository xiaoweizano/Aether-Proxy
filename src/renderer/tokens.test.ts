import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkTokens } from '../../scripts/check-tokens.mjs'

const rendererDir = path.dirname(fileURLToPath(import.meta.url))

describe('checkTokens', () => {
  it('真实渲染层目录没有裸色值或裸字号', () => {
    expect(checkTokens(rendererDir)).toEqual([])
  })

  it('临时目录里的裸色值会被记为一条违规', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aether-tokens-'))
    try {
      // 拆开拼接，避免本测试文件自身被 token 检查命中。
      writeFileSync(path.join(dir, 'bad.css'), ['color: ', '#', 'fff', ';'].join(''))
      const violations = checkTokens(dir)
      expect(violations).toHaveLength(1)
      expect(violations[0]).toContain('bad.css')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
