import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { FakePlatformProxy } from './fake'
import { ProxyOwnership } from './ownership'

let dir: string
let pp: FakePlatformProxy
let children: ChildProcess[]

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'aether-proxy-'))
  children = []
  pp = new FakePlatformProxy({
    enabled: true,
    server: 'corp:8080',
    bypass: ['*.corp.local'],
    autoConfigUrl: 'http://pac.local/proxy.pac',
    autoDetect: false
  })
})

afterEach(() => {
  for (const child of children) child.kill()
})

async function spawnLiveProcess(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  children.push(child)
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve())
    child.once('error', reject)
  })
  if (child.pid === undefined) throw new Error('未能取得子进程 pid')
  return child.pid
}

describe('ProxyOwnership', () => {
  it('快照包含 PAC 字段并落盘，且不包含 applied', async () => {
    const own = new ProxyOwnership(pp, path.join(dir, 'proxy-state.json'))
    await own.snapshotBeforeApply(await pp.getSystemProxy())
    const saved = JSON.parse(await readFile(path.join(dir, 'proxy-state.json'), 'utf8'))
    expect(saved.autoConfigUrl).toBe('http://pac.local/proxy.pac')
    expect(saved.owner).toBe('aether')
    expect(saved.applied).toBeUndefined()
  })

  it('正常退出按快照完整还原', async () => {
    const own = new ProxyOwnership(pp, path.join(dir, 'proxy-state.json'))
    const before = await pp.getSystemProxy()
    await own.snapshotBeforeApply(before)
    await pp.setSystemProxy({ server: '127.0.0.1:5566', bypass: ['localhost', '127.0.0.0/8'] })
    await own.markApplied('127.0.0.1:5566', ['localhost', '127.0.0.0/8'])
    await own.restoreOnExit()
    expect(await pp.getSystemProxy()).toEqual(before)
  })

  it('启动时发现残留且状态未被改动 → restored', async () => {
    const stateFile = path.join(dir, 'proxy-state.json')
    const first = new ProxyOwnership(pp, stateFile)
    await first.snapshotBeforeApply(await pp.getSystemProxy())
    await pp.setSystemProxy({ server: '127.0.0.1:5566', bypass: [] })
    await first.markApplied('127.0.0.1:5566', [])

    const second = new ProxyOwnership(pp, stateFile)
    expect(await second.restoreOnStartupIfStale()).toBe('restored')
    expect((await pp.getSystemProxy()).server).toBe('corp:8080')
  })

  it('状态被他人修改 → conflict，且不覆盖', async () => {
    const stateFile = path.join(dir, 'proxy-state.json')
    const first = new ProxyOwnership(pp, stateFile)
    await first.snapshotBeforeApply(await pp.getSystemProxy())
    await pp.setSystemProxy({ server: '127.0.0.1:5566', bypass: [] })
    await first.markApplied('127.0.0.1:5566', [])
    await pp.setSystemProxy({ server: 'other:9999', bypass: [] })

    const second = new ProxyOwnership(pp, stateFile)
    expect(await second.restoreOnStartupIfStale()).toBe('conflict')
    expect((await pp.getSystemProxy()).server).toBe('other:9999')
  })

  it('会话期间 PAC 被改动 → conflict，且不覆盖', async () => {
    const stateFile = path.join(dir, 'proxy-state.json')
    const first = new ProxyOwnership(pp, stateFile)
    await first.snapshotBeforeApply(await pp.getSystemProxy())
    await pp.setSystemProxy({ server: '127.0.0.1:5566', bypass: [] })
    await first.markApplied('127.0.0.1:5566', [])
    await pp.restore({ ...(await pp.getSystemProxy()), autoConfigUrl: 'http://pac.local/new.pac' })

    const second = new ProxyOwnership(pp, stateFile)
    expect(await second.restoreOnStartupIfStale()).toBe('conflict')
    const current = await pp.getSystemProxy()
    expect(current.autoConfigUrl).toBe('http://pac.local/new.pac')
    expect(current.server).toBe('127.0.0.1:5566')
  })

  it('会话期间 ProxyOverride 被改动 → conflict，且不覆盖', async () => {
    const stateFile = path.join(dir, 'proxy-state.json')
    const first = new ProxyOwnership(pp, stateFile)
    await first.snapshotBeforeApply(await pp.getSystemProxy())
    await pp.setSystemProxy({ server: '127.0.0.1:5566', bypass: ['localhost'] })
    await first.markApplied('127.0.0.1:5566', ['localhost'])
    await pp.restore({ ...(await pp.getSystemProxy()), bypass: ['other.local'] })

    const second = new ProxyOwnership(pp, stateFile)
    expect(await second.restoreOnStartupIfStale()).toBe('conflict')
    expect((await pp.getSystemProxy()).bypass).toEqual(['other.local'])
  })

  it('会话期间自动检测被打开 → conflict', async () => {
    const stateFile = path.join(dir, 'proxy-state.json')
    const first = new ProxyOwnership(pp, stateFile)
    await first.snapshotBeforeApply(await pp.getSystemProxy())
    await pp.setSystemProxy({ server: '127.0.0.1:5566', bypass: [] })
    await first.markApplied('127.0.0.1:5566', [])
    await pp.restore({ ...(await pp.getSystemProxy()), autoDetect: true })

    const second = new ProxyOwnership(pp, stateFile)
    expect(await second.restoreOnStartupIfStale()).toBe('conflict')
  })

  it('快照 pid 仍存活且不是本进程 → in-use，不还原也不删除', async () => {
    const stateFile = path.join(dir, 'proxy-state.json')
    const foreignPid = await spawnLiveProcess()
    await pp.setSystemProxy({ server: '127.0.0.1:5566', bypass: [] })
    await writeFile(
      stateFile,
      JSON.stringify({
        owner: 'aether',
        pid: foreignPid,
        at: Date.now(),
        enabled: true,
        server: 'corp:8080',
        bypass: ['*.corp.local'],
        autoConfigUrl: 'http://pac.local/proxy.pac',
        autoDetect: false,
        applied: { server: '127.0.0.1:5566', bypass: [] },
        appliedAt: Date.now()
      }),
      'utf8'
    )

    const own = new ProxyOwnership(pp, stateFile)
    expect(await own.restoreOnStartupIfStale()).toBe('in-use')
    expect((await pp.getSystemProxy()).server).toBe('127.0.0.1:5566')
    expect(JSON.parse(await readFile(stateFile, 'utf8')).pid).toBe(foreignPid)
  })

  it('快照不属于 Aether 时忽略并返回 none', async () => {
    const stateFile = path.join(dir, 'proxy-state.json')
    await writeFile(stateFile, JSON.stringify({ owner: 'someone-else', enabled: true }), 'utf8')
    const own = new ProxyOwnership(pp, stateFile)
    expect(await own.restoreOnStartupIfStale()).toBe('none')
  })

  it('已有快照时重复调用不会覆盖原状态', async () => {
    const own = new ProxyOwnership(pp, path.join(dir, 'proxy-state.json'))
    await own.snapshotBeforeApply(await pp.getSystemProxy())
    await pp.setSystemProxy({ server: '127.0.0.1:5566', bypass: [] })
    await own.markApplied('127.0.0.1:5566', [])
    await own.snapshotBeforeApply(await pp.getSystemProxy())
    await own.restoreOnExit()
    expect((await pp.getSystemProxy()).server).toBe('corp:8080')
  })

  it('退出时若代理已被他人修改则不覆盖', async () => {
    const own = new ProxyOwnership(pp, path.join(dir, 'proxy-state.json'))
    await own.snapshotBeforeApply(await pp.getSystemProxy())
    await pp.setSystemProxy({ server: '127.0.0.1:5566', bypass: [] })
    await own.markApplied('127.0.0.1:5566', [])
    await pp.setSystemProxy({ server: 'other:9999', bypass: [] })
    await own.restoreOnExit()
    expect((await pp.getSystemProxy()).server).toBe('other:9999')
  })
})
