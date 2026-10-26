import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FakePlatformProxy } from './fake'
import { ProxyOwnership } from './ownership'
import { SystemProxyController } from './controller'

let dir: string
let pp: FakePlatformProxy
let ownership: ProxyOwnership
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'aether-ctl-'))
  pp = new FakePlatformProxy({ enabled: true, server: 'corp:8080', bypass: ['*.corp.local'] })
  ownership = new ProxyOwnership(pp, path.join(dir, 'proxy-state.json'))
})

describe('SystemProxyController', () => {
  it('enable 先落快照再设置代理，disable 后恢复原值', async () => {
    const ctl = new SystemProxyController(pp, ownership)
    await ctl.enable('127.0.0.1:5566')
    expect((await pp.getSystemProxy()).server).toBe('127.0.0.1:5566')
    await ctl.disable()
    expect((await pp.getSystemProxy()).server).toBe('corp:8080')
  })

  it('重复 enable 不会把 Aether 的地址写成新快照', async () => {
    const ctl = new SystemProxyController(pp, ownership)
    await ctl.enable('127.0.0.1:5566')
    await ctl.enable('127.0.0.1:5566')
    await ctl.disable()
    expect((await pp.getSystemProxy()).server).toBe('corp:8080')
  })

  it('bypass 使用固定的回环与局域网列表', async () => {
    const ctl = new SystemProxyController(pp, ownership)
    await ctl.enable('127.0.0.1:5566')
    expect((await pp.getSystemProxy()).bypass).toEqual(['localhost', '127.0.0.0/8', '::1', '<local>'])
  })
})
