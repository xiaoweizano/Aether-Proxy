import { describe, it, expect, vi } from 'vitest'
import { classifyOrphan } from './orphan'

function fakeFetch(status: number, body: unknown = {}) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }))
}

describe('classifyOrphan', () => {
  it('旧 secret 通过 → ours', async () => {
    const fetchFn = fakeFetch(200, { version: 'v1.19.32' })
    const kind = await classifyOrphan({ port: 5000, oldSecret: 's', fetchFn: fetchFn as any })
    expect(kind).toBe('ours')
  })

  it('401 → foreign', async () => {
    const fetchFn = fakeFetch(401)
    const kind = await classifyOrphan({ port: 5000, oldSecret: 's', fetchFn: fetchFn as any })
    expect(kind).toBe('foreign')
  })

  it('404 → foreign', async () => {
    const fetchFn = fakeFetch(404)
    const kind = await classifyOrphan({ port: 5000, oldSecret: 's', fetchFn: fetchFn as any })
    expect(kind).toBe('foreign')
  })

  it('连接被拒 → none', async () => {
    const fetchFn = vi.fn(async () => { throw new Error('ECONNREFUSED') })
    const kind = await classifyOrphan({ port: 5000, oldSecret: 's', fetchFn: fetchFn as any })
    expect(kind).toBe('none')
  })
})
