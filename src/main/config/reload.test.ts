import { describe, it, expect } from 'vitest'
import { reloadConfig } from './reload'

describe('reloadConfig', () => {
  it('PUT /configs 返回 204 时 ok', async () => {
    const fetchFn = (async (_url: string, init: RequestInit) => {
      expect((init.method ?? '').toUpperCase()).toBe('PUT')
      expect(String(init.body)).toContain('runtime.yaml')
      return new Response(null, { status: 204 })
    }) as any
    const res = await reloadConfig(5567, 's', '/tmp/profiles/p1/runtime.yaml', fetchFn)
    expect(res).toEqual({ ok: true, status: 204 })
  })

  it('返回 400 时 ok=false，由调用方回滚', async () => {
    const fetchFn = (async () => new Response('bad', { status: 400 })) as any
    const res = await reloadConfig(5567, 's', '/tmp/runtime.yaml', fetchFn)
    expect(res).toEqual({ ok: false, status: 400 })
  })

  it('传输失败返回 ok=false/status=0，不抛异常', async () => {
    const fetchFn = (async () => { throw new Error('ECONNREFUSED') }) as any
    const res = await reloadConfig(5567, 's', '/tmp/runtime.yaml', fetchFn)
    expect(res).toEqual({ ok: false, status: 0 })
  })
})
