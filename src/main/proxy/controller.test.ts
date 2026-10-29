import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FakePlatformProxy } from './fake'
import { ProxyOwnership } from './ownership'
import { SystemProxyController } from './controller'

let dir: string
let pp: FakePlatformProxy
let ownership: ProxyOwnership
let stateFile: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'aether-ctl-'))
  pp = new FakePlatformProxy({ enabled: true, server: 'corp:8080', bypass: ['*.corp.local'] })
  stateFile = path.join(dir, 'proxy-state.json')
  ownership = new ProxyOwnership(pp, stateFile)
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

  it('切换端口后仍能在退出时还原原状态', async () => {
    const ctl = new SystemProxyController(pp, ownership)
    await ctl.enable('127.0.0.1:5566')
    await ctl.enable('127.0.0.1:7890')
    await ctl.disable()
    expect((await pp.getSystemProxy()).server).toBe('corp:8080')
  })

  it('bypass 使用固定的回环与局域网列表', async () => {
    const ctl = new SystemProxyController(pp, ownership)
    await ctl.enable('127.0.0.1:5566')
    expect((await pp.getSystemProxy()).bypass).toEqual(['localhost', '127.0.0.0/8', '::1', '<local>'])
  })

  it('设置系统代理成功后才写入 applied 记录', async () => {
    const ctl = new SystemProxyController(pp, ownership)
    let appliedDuringSet: unknown
    const originalSet = pp.setSystemProxy.bind(pp)
    pp.setSystemProxy = async (opts) => {
      appliedDuringSet = JSON.parse(await readFile(stateFile, 'utf8')).applied
      await originalSet(opts)
    }

    await ctl.enable('127.0.0.1:5566')

    expect(appliedDuringSet).toBeUndefined()
    const saved = JSON.parse(await readFile(stateFile, 'utf8'))
    expect(saved.server).toBe('corp:8080')
    expect(saved.applied).toEqual({ server: '127.0.0.1:5566', bypass: ['localhost', '127.0.0.0/8', '::1', '<local>'] })
  })

  it('设置系统代理失败时保留原快照且不写 applied', async () => {
    const ctl = new SystemProxyController(pp, ownership)
    pp.setSystemProxy = async () => {
      throw new Error('set failed')
    }

    await expect(ctl.enable('127.0.0.1:5566')).rejects.toThrow('set failed')

    const saved = JSON.parse(await readFile(stateFile, 'utf8'))
    expect(saved.server).toBe('corp:8080')
    expect(saved.bypass).toEqual(['*.corp.local'])
    expect(saved.applied).toBeUndefined()
    expect((await pp.getSystemProxy()).server).toBe('corp:8080')
  })
})
