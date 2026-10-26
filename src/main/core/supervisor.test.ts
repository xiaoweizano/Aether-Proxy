import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { allocatePort } from './ports'
import { newSecret } from './secret'
import { CoreSupervisor } from './supervisor'

const running: CoreSupervisor[] = []
afterEach(async () => { await Promise.all(running.splice(0).map((s) => s.stop())) })

async function makeSupervisor() {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'aether-core-'))
  const controllerPort = await allocatePort()
  const secret = newSecret()
  const sup = new CoreSupervisor({
    binary: process.execPath,
    homeDir,
    configPath: path.join(homeDir, 'runtime.yaml'),
    controllerPort,
    secret,
    env: { FAKE_PORT: String(controllerPort), FAKE_SECRET: secret },
    argsPrefix: ['test/fixtures/fake-mihomo.mjs']
  })
  running.push(sup)
  return sup
}

describe('CoreSupervisor', () => {
  it('启动后握手成功并返回信息', async () => {
    const sup = await makeSupervisor()
    const info = await sup.start()
    expect(info.controllerPort).toBeGreaterThan(0)
    expect(info.version).toContain('v1.19.32')
    expect(sup.status).toBe('running')
  })

  it('stop 之后进程不存在', async () => {
    const sup = await makeSupervisor()
    const info = await sup.start()
    await sup.stop()
    expect(sup.status).toBe('stopped')
    expect(() => process.kill(info.pid, 0)).toThrow()
  })

  it('二进制不存在时 start 拒绝而不是崩溃', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'aether-core-'))
    const sup = new CoreSupervisor({
      binary: 'aether-no-such-binary-xyz',
      homeDir,
      configPath: path.join(homeDir, 'runtime.yaml'),
      controllerPort: 1,
      secret: 's'
    })
    await expect(sup.start()).rejects.toThrow()
    expect(sup.status).toBe('stopped')
  })
})
