import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FakePlatformProxy } from './fake'
import { ProxyOwnership } from './ownership'

let dir: string
let pp: FakePlatformProxy
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'aether-proxy-'))
  pp = new FakePlatformProxy({
    enabled: true,
    server: 'corp:8080',
    bypass: ['*.corp.local'],
    autoConfigUrl: 'http://pac.local/proxy.pac',
    autoDetect: false
  })
})

describe('ProxyOwnership', () => {
  it('快照包含 PAC 字段并落盘', async () => {
    const own = new ProxyOwnership(pp, path.join(dir, 'proxy-state.json'))
    await own.snapshotBeforeApply(await pp.getSystemProxy(), '127.0.0.1:5566')
    const saved = JSON.parse(await readFile(path.join(dir, 'proxy-state.json'), 'utf8'))
    expect(saved.autoConfigUrl).toBe('http://pac.local/proxy.pac')
    expect(saved.owner).toBe('aether')
  })

  it('正常退出按快照完整还原', async () => {
    const own = new ProxyOwnership(pp, path.join(dir, 'proxy-state.json'))
    const before = await pp.getSystemProxy()
    await own.snapshotBeforeApply(before, '127.0.0.1:5566')
    await pp.setSystemProxy({ server: '127.0.0.1:5566', bypass: ['localhost', '127.0.0.0/8'] })
    await own.restoreOnExit()
    expect(await pp.getSystemProxy()).toEqual(before)
  })

  it('启动时发现残留且状态未被改动 → restored', async () => {
    const stateFile = path.join(dir, 'proxy-state.json')
    const first = new ProxyOwnership(pp, stateFile)
    await first.snapshotBeforeApply(await pp.getSystemProxy(), '127.0.0.1:5566')
    await pp.setSystemProxy({ server: '127.0.0.1:5566', bypass: [] })

    const second = new ProxyOwnership(pp, stateFile)
    expect(await second.restoreOnStartupIfStale()).toBe('restored')
    expect((await pp.getSystemProxy()).server).toBe('corp:8080')
  })

  it('状态被他人修改 → conflict，且不覆盖', async () => {
    const stateFile = path.join(dir, 'proxy-state.json')
    const first = new ProxyOwnership(pp, stateFile)
    await first.snapshotBeforeApply(await pp.getSystemProxy(), '127.0.0.1:5566')
    await pp.setSystemProxy({ server: '127.0.0.1:5566', bypass: [] })
    await pp.setSystemProxy({ server: 'other:9999', bypass: [] })

    const second = new ProxyOwnership(pp, stateFile)
    expect(await second.restoreOnStartupIfStale()).toBe('conflict')
    expect((await pp.getSystemProxy()).server).toBe('other:9999')
  })

  it('快照不属于 Aether 时忽略并返回 none', async () => {
    const stateFile = path.join(dir, 'proxy-state.json')
    await writeFile(stateFile, JSON.stringify({ owner: 'someone-else', enabled: true }), 'utf8')
    const own = new ProxyOwnership(pp, stateFile)
    expect(await own.restoreOnStartupIfStale()).toBe('none')
  })
})
