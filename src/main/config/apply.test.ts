import { describe, it, expect, vi } from 'vitest'
import { applyConfig, type ApplyDeps } from './apply'

function deps(overrides: Partial<ApplyDeps> = {}) {
  const calls: string[] = []
  const d: ApplyDeps = {
    writeNext: vi.fn(async () => { calls.push('writeNext'); return 'runtime.yaml.next' }),
    validate: vi.fn(async (nextPath: string) => {
      calls.push(`validate:${nextPath}`)
      return { ok: true, output: 'successful' }
    }),
    promote: vi.fn(async () => { calls.push('promote') }),
    rollback: vi.fn(async () => { calls.push('rollback') }),
    reload: vi.fn(async () => { calls.push('reload'); return { ok: true, status: 204 } }),
    ...overrides
  }
  return { calls, deps: d }
}

describe('applyConfig', () => {
  it('按 写下一版 → 校验 → 晋升 → 重载 的顺序执行', async () => {
    const { calls, deps: d } = deps()
    expect(await applyConfig({ a: 1 }, d)).toEqual({ ok: true })
    expect(calls).toEqual(['writeNext', 'validate:runtime.yaml.next', 'promote', 'reload'])
  })

  it('校验失败时不动 runtime、不重载', async () => {
    const h = deps()
    h.deps.validate = vi.fn(async () => { h.calls.push('validate'); return { ok: false, output: 'parse error' } })
    expect(await applyConfig({ a: 1 }, h.deps)).toEqual({ ok: false, reason: 'invalid' })
    expect(h.calls).toEqual(['writeNext', 'validate'])
    expect(h.deps.promote).not.toHaveBeenCalled()
    expect(h.deps.rollback).not.toHaveBeenCalled()
    expect(h.deps.reload).not.toHaveBeenCalled()
  })

  it('重载失败时回滚上一版', async () => {
    const h = deps()
    h.deps.reload = vi.fn(async () => { h.calls.push('reload'); return { ok: false, status: 502 } })
    expect(await applyConfig({ a: 1 }, h.deps)).toEqual({ ok: false, reason: 'reload' })
    expect(h.calls).toEqual(['writeNext', 'validate:runtime.yaml.next', 'promote', 'reload', 'rollback'])
    expect(h.deps.rollback).toHaveBeenCalledOnce()
  })
})
