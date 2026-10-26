import { describe, it, expect, vi } from 'vitest'
import { classifyOrphan } from './orphan'

function fakeFetch(status: number, body: unknown = {}) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }))
}

describe('classifyOrphan', () => {
  it('旧 secret 通过且配置哈希一致 → ours', async () => {
    const fetchFn = fakeFetch(200, { version: 'v1.19.32', configHash: 'h1' })
    const kind = await classifyOrphan({ port: 5000, oldSecret: 's', expectedConfigHash: 'h1', fetchFn: fetchFn as any })
    expect(kind).toBe('ours')
  })

  it('旧 secret 通过但哈希不同 → foreign', async () => {
    const fetchFn = fakeFetch(200, { version: 'v1.19.32', configHash: 'h2' })
    const kind = await classifyOrphan({ port: 5000, oldSecret: 's', expectedConfigHash: 'h1', fetchFn: fetchFn as any })
    expect(kind).toBe('foreign')
  })

  it('401 → foreign', async () => {
    const fetchFn = fakeFetch(401)
    const kind = await classifyOrphan({ port: 5000, oldSecret: 's', expectedConfigHash: 'h1', fetchFn: fetchFn as any })
    expect(kind).toBe('foreign')
  })

  it('连接被拒 → none', async () => {
    const fetchFn = vi.fn(async () => { throw new Error('ECONNREFUSED') })
    const kind = await classifyOrphan({ port: 5000, oldSecret: 's', expectedConfigHash: 'h1', fetchFn: fetchFn as any })
    expect(kind).toBe('none')
  })
})
