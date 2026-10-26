import { describe, it, expect, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { bootstrap } from './bootstrap'

const VALID_CONFIG = `proxies: []
proxy-groups:
  - { name: Proxy, type: select, proxies: [DIRECT] }
rules:
  - MATCH,DIRECT
`

async function makeUserDir(withConfig: boolean, configText = VALID_CONFIG): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'aether-boot-'))
  if (withConfig) {
    const p = path.join(dir, 'profiles', 'default')
    await mkdir(p, { recursive: true })
    await writeFile(path.join(p, 'upstream.yaml'), configText)
  }
  return dir
}

function deps(dir: string, extra: Record<string, unknown> = {}) {
  const spawnFn = vi.fn()
  const fetchFn = vi.fn()
  return {
    spawnFn,
    fetchFn,
    opts: {
      userDataDir: dir,
      isPackaged: false,
      resourcesPath: dir,
      repoRoot: process.cwd(),
      spawnFn: spawnFn as never,
      fetchFn: fetchFn as never,
      ...extra
    }
  }
}

describe('bootstrap', () => {
  it('无配置时返回 no-config 且不启动内核', async () => {
    const dir = await makeUserDir(false)
    const { opts, spawnFn } = deps(dir)
    const ctx = await bootstrap(opts)
    expect(ctx.startupStatus).toBe('no-config')
    expect(ctx.profileDir).toBeNull()
    expect(ctx.restore).toBe('none')
    expect(ctx.supervisor.status).toBe('stopped')
    expect(spawnFn).not.toHaveBeenCalled()
    await ctx.stopAll()
  })

  it('另一个存活实例持有代理时返回 in-use，不启动内核也不碰代理', async () => {
    const dir = await makeUserDir(true)
    // pid 指向仍然存活的父进程，模拟另一个 Aether 实例。
    await writeFile(
      path.join(dir, 'proxy-state.json'),
      JSON.stringify({
        enabled: true,
        server: 'corp:8080',
        bypass: ['*.corp.local'],
        owner: 'aether',
        pid: process.ppid,
        at: Date.now(),
        applied: { server: '127.0.0.1:7890', bypass: ['localhost'] },
        appliedAt: Date.now()
      })
    )
    const { opts, spawnFn } = deps(dir)
    const ctx = await bootstrap(opts)
    expect(ctx.startupStatus).toBe('in-use')
    expect(ctx.restore).toBe('in-use')
    expect(ctx.supervisor.status).toBe('stopped')
    expect(spawnFn).not.toHaveBeenCalled()
    await ctx.stopAll()
  })

  it('配置引用缺失时返回 config-error 且不启动内核', async () => {
    const dir = await makeUserDir(
      true,
      `proxies: []
proxy-groups:
  - { name: Proxy, type: select, proxies: [Missing] }
rules:
  - MATCH,DIRECT
`
    )
    const { opts, spawnFn } = deps(dir)
    const ctx = await bootstrap(opts)
    expect(ctx.startupStatus).toBe('config-error')
    expect(ctx.supervisor.status).toBe('stopped')
    expect(spawnFn).not.toHaveBeenCalled()
    await ctx.stopAll()
  })

  it('YAML 无法解析时返回 config-error 且不启动内核', async () => {
    const dir = await makeUserDir(true, 'proxies: [\n  - { name: ')
    const { opts, spawnFn } = deps(dir)
    const ctx = await bootstrap(opts)
    expect(ctx.startupStatus).toBe('config-error')
    expect(ctx.supervisor.status).toBe('stopped')
    expect(spawnFn).not.toHaveBeenCalled()
    await ctx.stopAll()
  })
})
