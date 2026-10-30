import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SUBSCRIPTION_USER_AGENT, importFromFile, importFromUrl } from './import'
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

  it('请求带 Clash 可识别的 User-Agent：订阅站按 UA 分流，缺了就会拿到网页', async () => {
    const { dir } = await createProfile(root, 'p1')
    const calls: { url: string; init?: RequestInit }[] = []
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return new Response(good, { status: 200 })
    }) as any

    await importFromUrl(dir, 'https://example.com/sub', fetchFn)

    const headers = (calls[0]?.init?.headers ?? {}) as Record<string, string>
    expect(headers['user-agent']).toBe(SUBSCRIPTION_USER_AGENT)
    expect(headers['user-agent']).toMatch(/clash/i)
    expect(headers['accept']).toContain('yaml')
  })

  it('HTTP 204 空体：说地址可能过期，而不是「配置不合法」', async () => {
    const { dir } = await createProfile(root, 'p1')
    const fetchFn = (async () => new Response(null, { status: 204 })) as any

    await expect(importFromUrl(dir, 'https://example.com/sub', fetchFn)).rejects.toThrow(
      /HTTP 204/
    )
    await expect(importFromUrl(dir, 'https://example.com/sub', fetchFn)).rejects.not.toThrow(
      /不是合法的 Clash 配置/
    )
  })

  it('200 + HTML（机场返回网页）：指出是网页而不是配置', async () => {
    const { dir } = await createProfile(root, 'p1')
    const html = '<!DOCTYPE html><html><head><title>订阅已过期</title></head><body>x</body></html>'
    const fetchFn = (async () =>
      new Response(html, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=UTF-8' }
      })) as any

    await expect(importFromUrl(dir, 'https://example.com/sub', fetchFn)).rejects.toThrow(/网页/)
    // 不写入任何东西：失败不能污染已有配置。
    await expect(readFile(path.join(dir, 'upstream.yaml'), 'utf8')).rejects.toThrow()
  })

  it('content-type 缺失但内容是 HTML：按内容判断，同样指出是网页', async () => {
    const { dir } = await createProfile(root, 'p1')
    const fetchFn = (async () => new Response('<html><body>oops</body></html>', { status: 200 })) as any

    await expect(importFromUrl(dir, 'https://example.com/sub', fetchFn)).rejects.toThrow(/网页/)
  })

  it('200 但空体：说服务器没给内容', async () => {
    const { dir } = await createProfile(root, 'p1')
    // 只有空白字符也算空体：trim 之后没有内容。
    const fetchFn = (async () => new Response('   ', { status: 200 })) as any

    await expect(importFromUrl(dir, 'https://example.com/sub', fetchFn)).rejects.toThrow(/空内容/)
  })

  it('YAML 不合法时仍保留原文案，但补上状态码与字节数', async () => {
    const { dir } = await createProfile(root, 'p1')
    const fetchFn = (async () => new Response('just a string', { status: 200 })) as any

    await expect(importFromUrl(dir, 'https://example.com/sub', fetchFn)).rejects.toThrow(
      /不是合法的 Clash 配置.*响应 200.*字节/
    )
  })

  it('错误信息不含响应正文：订阅体里可能有凭据', async () => {
    const { dir } = await createProfile(root, 'p1')
    const secret = 'sub-token-abcdef123456'
    const html = `<!DOCTYPE html><html><body>${secret}</body></html>`
    const fetchFn = (async () =>
      new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })) as any

    const message = await importFromUrl(dir, 'https://example.com/sub', fetchFn).then(
      () => '',
      (err: Error) => err.message
    )
    expect(message).not.toContain(secret)
    expect(message.length).toBeGreaterThan(0)
  })
})
