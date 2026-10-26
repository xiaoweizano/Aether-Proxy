import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { importFromFile, importFromUrl } from './import'
import { createProfile } from './paths'

let root: string
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'aether-import-')) })

const good = 'proxies:\n  - { name: HK, type: ss, server: 127.0.0.1, port: 9, cipher: aes-128-gcm, password: x }\n'

describe('createProfile', () => {
  it('创建目录并返回 upstream 路径', async () => {
    const p = await createProfile(root, 'p1')
    expect(p.upstreamPath).toBe(path.join(root, 'profiles', 'p1', 'upstream.yaml'))
  })
})

describe('importFromFile', () => {
  it('把合法文件原样复制为 upstream.yaml', async () => {
    const { dir } = await createProfile(root, 'p1')
    const src = path.join(root, 'src.yaml')
    await writeFile(src, good, 'utf8')
    await importFromFile(dir, src)
    expect(await readFile(path.join(dir, 'upstream.yaml'), 'utf8')).toBe(good)
  })

  it('非法内容抛错且不覆盖已有配置', async () => {
    const { dir } = await createProfile(root, 'p1')
    const src = path.join(root, 'src.yaml')
    await writeFile(src, good, 'utf8')
    await importFromFile(dir, src)
    const bad = path.join(root, 'bad.yaml')
    await writeFile(bad, 'just a string', 'utf8')
    await expect(importFromFile(dir, bad)).rejects.toThrow('不是合法的 Clash 配置')
    expect(await readFile(path.join(dir, 'upstream.yaml'), 'utf8')).toBe(good)
  })
})

describe('importFromUrl', () => {
  it('200 且内容合法时写入', async () => {
    const { dir } = await createProfile(root, 'p1')
    const fetchFn = (async () => new Response(good, { status: 200 })) as any
    await importFromUrl(dir, 'https://example.com/sub', fetchFn)
    expect(await readFile(path.join(dir, 'upstream.yaml'), 'utf8')).toBe(good)
  })

  it('非 200 时抛错且不写入', async () => {
    const { dir } = await createProfile(root, 'p1')
    const fetchFn = (async () => new Response('nope', { status: 403 })) as any
    await expect(importFromUrl(dir, 'https://example.com/sub', fetchFn)).rejects.toThrow('返回 403')
  })
})
