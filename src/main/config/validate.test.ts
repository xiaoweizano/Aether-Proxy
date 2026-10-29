import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { validateConfig } from './validate'

let dir: string
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'aether-validate-')) })

const fake = process.execPath
const fakeArgs = [path.resolve('test/fixtures/fake-mihomo.mjs')]

describe('validateConfig', () => {
  it('合法配置返回 ok', async () => {
    const cfg = path.join(dir, 'runtime.yaml')
    await writeFile(cfg, 'proxies: []\n', 'utf8')
    const res = await validateConfig(fake, dir, cfg, fakeArgs)
    expect(res.ok).toBe(true)
    expect(res.output).toContain('successful')
  })

  it('非法配置返回 ok=false 并带回内核输出', async () => {
    const cfg = path.join(dir, 'runtime.yaml')
    await writeFile(cfg, '__INVALID__\n', 'utf8')
    const res = await validateConfig(fake, dir, cfg, fakeArgs)
    expect(res.ok).toBe(false)
    expect(res.output).toContain('parse error')
  })
})
