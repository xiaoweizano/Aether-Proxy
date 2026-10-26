import { describe, it, expect } from 'vitest'
import { CoreLink } from './link'

const BASE = 'http://127.0.0.1:9090'
const SECRET = 's3cr3t-value'

interface Call {
  url: string
  init: RequestInit | undefined
}

function response(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response
}

function recorder(impl: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = []
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = { url: typeof input === 'string' ? input : String(input), init }
    calls.push(call)
    return impl(call)
  }) as unknown as typeof fetch
  return { fn, calls }
}

function header(call: Call, name: string): string | undefined {
  const h = call.init?.headers
  if (h === undefined) return undefined
  if (h instanceof Headers) return h.get(name) ?? undefined
  if (Array.isArray(h)) return h.find(([key]) => key.toLowerCase() === name)?.[1]
  const record = h as Record<string, string>
  return record[name] ?? record[name.toLowerCase()]
}

function bodyOf(call: Call): unknown {
  const body = call.init?.body
  return typeof body === 'string' ? JSON.parse(body) : body
}

function link(fn: typeof fetch): CoreLink {
  return new CoreLink(BASE, SECRET, fn)
}

describe('CoreLink', () => {
  it('version 命中 /version 并带 Bearer', async () => {
    const { fn, calls } = recorder(() => response({ version: 'v1.19.32' }))
    const result = await link(fn).version()
    expect(result).toEqual({ version: 'v1.19.32' })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(`${BASE}/version`)
    expect(header(calls[0]!, 'authorization')).toBe(`Bearer ${SECRET}`)
  })

  it('proxies 命中 /proxies 并原样返回策略组', async () => {
    const payload = {
      proxies: {
        GLOBAL: { name: 'GLOBAL', type: 'select', now: 'Proxy', all: ['Proxy', 'DIRECT'] },
        Proxy: { name: 'Proxy', type: 'select', now: 'HK', all: ['HK'], history: [] }
      }
    }
    const { fn, calls } = recorder(() => response(payload))
    const result = await link(fn).proxies()
    expect(result.proxies.GLOBAL?.now).toBe('Proxy')
    expect(calls[0]?.url).toBe(`${BASE}/proxies`)
    expect(header(calls[0]!, 'authorization')).toBe(`Bearer ${SECRET}`)
  })

  it('setMode 用 PATCH /configs 发送 mode', async () => {
    const { fn, calls } = recorder(() => response(null))
    const result = await link(fn).setMode('global')
    expect(result).toEqual({ ok: true, status: 200 })
    expect(calls[0]?.url).toBe(`${BASE}/configs`)
    expect(calls[0]?.init?.method).toBe('PATCH')
    expect(header(calls[0]!, 'authorization')).toBe(`Bearer ${SECRET}`)
    expect(header(calls[0]!, 'content-type')).toBe('application/json')
    expect(bodyOf(calls[0]!)).toEqual({ mode: 'global' })
  })

  it('setMode 非 2xx 返回 ok:false 与状态码', async () => {
    const { fn } = recorder(() => response({ message: 'bad' }, false, 400))
    await expect(link(fn).setMode('direct')).resolves.toEqual({ ok: false, status: 400 })
  })

  it('setMode 传输失败返回 status 0', async () => {
    const { fn } = recorder(() => {
      throw new Error('ECONNREFUSED')
    })
    await expect(link(fn).setMode('rule')).resolves.toEqual({ ok: false, status: 0 })
  })

  it('memory 命中 /memory', async () => {
    const { fn, calls } = recorder(() => response({ inuse: 1024, oslimit: 0 }))
    expect(await link(fn).memory()).toEqual({ inuse: 1024 })
    expect(calls[0]?.url).toBe(`${BASE}/memory`)
  })

  it('connections 命中 /connections', async () => {
    const { fn, calls } = recorder(() =>
      response({ connections: [{ id: 'a' }], downloadTotal: 10, uploadTotal: 20 })
    )
    expect(await link(fn).connections()).toEqual({
      connections: [{ id: 'a' }],
      downloadTotal: 10,
      uploadTotal: 20
    })
    expect(calls[0]?.url).toBe(`${BASE}/connections`)
    expect(header(calls[0]!, 'authorization')).toBe(`Bearer ${SECRET}`)
  })

  it('getter 非 2xx 抛错且错误带状态码', async () => {
    const { fn } = recorder(() => response({}, false, 401))
    await expect(link(fn).version()).rejects.toThrow(/401/)
  })

  it('传输错误不会把 secret 带进错误消息', async () => {
    const { fn } = recorder(() => {
      throw new Error(`request with Bearer ${SECRET} failed`)
    })
    let err: unknown
    try {
      await link(fn).version()
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(Error)
    const message = (err as Error).message
    expect(message).not.toContain(SECRET)
    expect(message).toMatch(/不可达/)
  })

  it('baseUrl 末尾斜杠不会产生双斜杠', async () => {
    const { fn, calls } = recorder(() => response({ version: 'v1' }))
    await new CoreLink(`${BASE}/`, SECRET, fn).version()
    expect(calls[0]?.url).toBe(`${BASE}/version`)
  })
})
