import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { bootstrap, type BootstrapOptions } from './bootstrap'
import { FakePlatformProxy } from './proxy/fake'
import { ProxyOwnership } from './proxy/ownership'

const VALID_CONFIG = `proxies: []
proxy-groups:
  - { name: Proxy, type: select, proxies: [DIRECT] }
rules:
  - MATCH,DIRECT
`

const CORE_PID = 424242

async function makeUserDir(withConfig: boolean, configText = VALID_CONFIG): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'aether-boot-'))
  if (withConfig) {
    const p = path.join(dir, 'profiles', 'default')
    await mkdir(p, { recursive: true })
    await writeFile(path.join(p, 'upstream.yaml'), configText)
  }
  return dir
}

/** 让 CoreSupervisor 的握手走到 running，而不用真的 spawn mihomo。 */
function fakeChild(): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess
  Object.assign(child, {
    pid: CORE_PID,
    exitCode: null,
    kill: vi.fn(() => {
      ;(child as unknown as { exitCode: number | null }).exitCode = 0
      child.emit('exit', 0, null)
      return true
    })
  })
  return child
}

function okFetch(): typeof fetch {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ version: 'test' })
  })) as unknown as typeof fetch
}

interface Harness {
  dir: string
  pp: FakePlatformProxy
  spawnFn: ReturnType<typeof vi.fn>
  opts: BootstrapOptions
}

async function harness(options: {
  config?: string | null
  proxyEnabled?: boolean
  pp?: FakePlatformProxy
} = {}): Promise<Harness> {
  const config = options.config === undefined ? VALID_CONFIG : options.config
  const dir = await makeUserDir(config !== null, config ?? VALID_CONFIG)
  if (options.proxyEnabled !== undefined) {
    await writeFile(
      path.join(dir, 'settings.json'),
      JSON.stringify({ proxyEnabled: options.proxyEnabled })
    )
  }
  const pp = options.pp ?? new FakePlatformProxy({ enabled: false })
  const spawnFn = vi.fn(() => fakeChild())
  return {
    dir,
    pp,
    spawnFn,
    opts: {
      userDataDir: dir,
      isPackaged: false,
      resourcesPath: dir,
      repoRoot: process.cwd(),
      spawnFn: spawnFn as unknown as BootstrapOptions['spawnFn'],
      fetchFn: okFetch(),
      platformProxy: pp
    }
  }
}

describe('bootstrap', () => {
  it('无配置时返回 no-config 且不启动内核', async () => {
    const h = await harness({ config: null })
    const ctx = await bootstrap(h.opts)
    expect(ctx.startupStatus).toBe('no-config')
    expect(ctx.profileDir).toBeNull()
    expect(ctx.restore).toBe('none')
    expect(ctx.supervisor.status).toBe('stopped')
    expect(h.spawnFn).not.toHaveBeenCalled()
    await ctx.stopAll()
  })

  it('另一个存活实例持有代理时返回 in-use，不启动内核也不碰代理', async () => {
    const h = await harness({ proxyEnabled: true })
    await writeFile(
      path.join(h.dir, 'proxy-state.json'),
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
    const ctx = await bootstrap(h.opts)
    expect(ctx.startupStatus).toBe('in-use')
    expect(ctx.restore).toBe('in-use')
    expect(ctx.supervisor.status).toBe('stopped')
    expect(h.spawnFn).not.toHaveBeenCalled()
    expect((await h.pp.getSystemProxy()).enabled).toBe(false)
    await ctx.stopAll()
  })

  it('配置引用缺失时返回 config-error 且不启动内核', async () => {
    const h = await harness({
      config: `proxies: []
proxy-groups:
  - { name: Proxy, type: select, proxies: [Missing] }
rules:
  - MATCH,DIRECT
`
    })
    const ctx = await bootstrap(h.opts)
    expect(ctx.startupStatus).toBe('config-error')
    expect(ctx.supervisor.status).toBe('stopped')
    expect(h.spawnFn).not.toHaveBeenCalled()
    await ctx.stopAll()
  })

  it('YAML 无法解析时返回 config-error 且不启动内核', async () => {
    const h = await harness({ config: 'proxies: [\n  - { name: ' })
    const ctx = await bootstrap(h.opts)
    expect(ctx.startupStatus).toBe('config-error')
    expect(ctx.supervisor.status).toBe('stopped')
    expect(h.spawnFn).not.toHaveBeenCalled()
    await ctx.stopAll()
  })

  it('上次代理为开时启动内核后接管系统代理', async () => {
    const h = await harness({ proxyEnabled: true })
    const ctx = await bootstrap(h.opts)
    expect(ctx.startupStatus).toBe('ready')
    expect(ctx.restore).toBe('none')
    expect(h.spawnFn).toHaveBeenCalledTimes(1)
    const proxy = await h.pp.getSystemProxy()
    expect(proxy.enabled).toBe(true)
    expect(proxy.server).toMatch(/^127\.0\.0\.1:\d+$/)

    const coreState = JSON.parse(await readFile(path.join(h.dir, 'core-state.json'), 'utf8'))
    expect(coreState.pid).toBe(CORE_PID)

    await ctx.stopAll()
    expect((await h.pp.getSystemProxy()).enabled).toBe(false)
    await expect(readFile(path.join(h.dir, 'core-state.json'), 'utf8')).rejects.toThrow()
  })

  it('上次代理为关时启动内核但不改系统代理', async () => {
    const h = await harness({ proxyEnabled: false })
    const ctx = await bootstrap(h.opts)
    expect(ctx.startupStatus).toBe('ready')
    expect(h.spawnFn).toHaveBeenCalledTimes(1)
    expect((await h.pp.getSystemProxy()).enabled).toBe(false)
    await ctx.stopAll()
  })

  it('检测到代理被他人改动（conflict）时不接管系统代理', async () => {
    const pp = new FakePlatformProxy({ enabled: true, server: 'corp:8080', bypass: ['*.corp.local'] })
    const h = await harness({ proxyEnabled: true, pp })
    const stateFile = path.join(h.dir, 'proxy-state.json')

    const first = new ProxyOwnership(pp, stateFile)
    await first.snapshotBeforeApply(await pp.getSystemProxy())
    await pp.setSystemProxy({ server: '127.0.0.1:7890', bypass: [] })
    await first.markApplied('127.0.0.1:7890', [])
    await pp.setSystemProxy({ server: 'other:9999', bypass: [] })

    const ctx = await bootstrap(h.opts)
    expect(ctx.restore).toBe('conflict')
    expect(ctx.startupStatus).toBe('ready')
    expect(h.spawnFn).toHaveBeenCalledTimes(1)
    expect((await pp.getSystemProxy()).server).toBe('other:9999')

    await ctx.stopAll()
    expect((await pp.getSystemProxy()).server).toBe('other:9999')
  })
})
