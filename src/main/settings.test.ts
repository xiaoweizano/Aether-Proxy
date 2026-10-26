import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readSettings, writeSettings } from './settings'

let file: string

beforeEach(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'aether-settings-'))
  file = path.join(dir, 'settings.json')
})

describe('settings', () => {
  it('文件不存在时返回默认关闭', async () => {
    expect(await readSettings(file)).toEqual({ proxyEnabled: false })
  })

  it('写入后可以原样读回', async () => {
    await writeSettings(file, { proxyEnabled: true })
    expect(await readSettings(file)).toEqual({ proxyEnabled: true })
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ proxyEnabled: true })
  })

  it('JSON 损坏时返回默认关闭', async () => {
    await writeFile(file, '{ not json', 'utf8')
    expect(await readSettings(file)).toEqual({ proxyEnabled: false })
  })
})
