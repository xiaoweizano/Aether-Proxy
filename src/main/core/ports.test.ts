import { describe, it, expect } from 'vitest'
import net from 'node:net'
import { allocatePort } from './ports'
import { newSecret } from './secret'

describe('allocatePort', () => {
  it('返回一个当前可绑定的端口', async () => {
    const port = await allocatePort()
    expect(port).toBeGreaterThan(0)
    await new Promise<void>((resolve, reject) => {
      const srv = net.createServer()
      srv.once('error', reject)
      srv.listen(port, '127.0.0.1', () => srv.close(() => resolve()))
    })
  })

  it('连续两次分配不返回同一个端口', async () => {
    const a = await allocatePort()
    const b = await allocatePort()
    expect(a).not.toBe(b)
  })
})

describe('newSecret', () => {
  it('返回 32 位十六进制且每次不同', () => {
    const a = newSecret()
    const b = newSecret()
    expect(a).toMatch(/^[0-9a-f]{32}$/)
    expect(a).not.toBe(b)
  })
})
