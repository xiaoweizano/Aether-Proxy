import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { writeRuntime, readRuntime } from './runtime'

let dir: string
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'aether-')) })

describe('writeRuntime', () => {
  it('写到与 upstream 相同的目录，并可读回', async () => {
    await writeFile(path.join(dir, 'upstream.yaml'), 'proxies: []\n')
    const file = await writeRuntime(dir, { 'mixed-port': 5566, tun: { enable: false } })
    expect(path.dirname(file)).toBe(dir)
    const text = await readFile(file, 'utf8')
    expect(text).toContain('mixed-port: 5566')
    expect(await readRuntime(dir)).toMatchObject({ 'mixed-port': 5566 })
  })

  it('多次写入不留下临时文件', async () => {
    await writeRuntime(dir, { a: 1 })
    await writeRuntime(dir, { a: 2 })
    const entries = await readFile(path.join(dir, 'runtime.yaml'), 'utf8')
    expect(entries).toContain('a: 2')
  })
})
