import { describe, it, expect, vi } from 'vitest'
import { startup, shutdown } from './lifecycle'

function deps(overrides: Partial<Parameters<typeof startup>[0]> = {}) {
  const calls: string[] = []
  return {
    calls,
    ownership: {
      restoreOnStartupIfStale: vi.fn(async () => { calls.push('restore'); return 'none' as const }),
      restoreOnExit: vi.fn(async () => { calls.push('restore-exit') })
    },
    loadConfig: vi.fn(async () => { calls.push('config'); return { ok: true } }),
    core: { start: vi.fn(async () => { calls.push('core'); return {} }) },
    proxy: {
      enable: vi.fn(async () => { calls.push('proxy-on') }),
      disable: vi.fn(async () => { calls.push('proxy-off') })
    },
    server: '127.0.0.1:5566',
    lastProxyEnabled: true,
    ...overrides
  }
}

describe('startup', () => {
  it('按 残留还原 → 读配置 → 启动内核 → 恢复代理 的顺序执行', async () => {
    const d = deps()
    const result = await startup(d as any)
    expect(d.calls).toEqual(['restore', 'config', 'core', 'proxy-on'])
    expect(result.status).toBe('ready')
  })

  it('配置错误时不启动内核、不应用代理', async () => {
    const d = deps({ loadConfig: vi.fn(async () => { d.calls.push('config'); return { ok: false, error: 'bad yaml' } }) as any })
    const result = await startup(d as any)
    expect(d.calls).toEqual(['restore', 'config'])
    expect(result.status).toBe('config-error')
  })

  it('内核启动失败时不应用代理', async () => {
    const d = deps()
    ;(d.core.start as any).mockImplementationOnce(async () => { d.calls.push('core'); throw new Error('boom') })
    const result = await startup(d as any)
    expect(d.calls).toEqual(['restore', 'config', 'core'])
    expect(result.status).toBe('core-error')
  })

  it('上次代理为关时不自动开启', async () => {
    const d = deps({ lastProxyEnabled: false })
    await startup(d as any)
    expect(d.calls).toEqual(['restore', 'config', 'core'])
  })
})

describe('shutdown', () => {
  it('先还原代理，再终止内核', async () => {
    const calls: string[] = []
    const d = {
      ownership: { restoreOnExit: vi.fn(async () => { calls.push('restore-exit') }) },
      proxy: { disable: vi.fn(async () => { calls.push('proxy-off') }) },
      core: { stop: vi.fn(async () => { calls.push('core-stop') }) }
    }
    await shutdown(d as any)
    expect(calls).toEqual(['proxy-off', 'restore-exit', 'core-stop'])
  })
})
