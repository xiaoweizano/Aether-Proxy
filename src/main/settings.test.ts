import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  DEFAULT_AUTOSTART,
  readSettings,
  resolveAutostart,
  writeAutostart,
  writeSettings,
  writeWindowBounds
} from './settings'

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

describe('autostart', () => {
  it('缺键时按默认启用（旧文件不视为用户关闭）', async () => {
    await writeFile(file, JSON.stringify({ proxyEnabled: false }), 'utf8')
    expect(resolveAutostart(await readSettings(file))).toBe(DEFAULT_AUTOSTART)
    expect(DEFAULT_AUTOSTART).toBe(true)
  })

  it('缺键 + 文件不存在时也是默认启用', async () => {
    expect(resolveAutostart(await readSettings(file))).toBe(true)
  })

  it('显式关闭后往返读回 false', async () => {
    await writeAutostart(file, false)
    expect(await readSettings(file)).toEqual({ proxyEnabled: false, autostart: false })
    expect(resolveAutostart(await readSettings(file))).toBe(false)
  })

  it('再次开启后往返读回 true，且保留其它字段', async () => {
    await writeAutostart(file, false)
    await writeSettings(file, { proxyEnabled: true })
    await writeAutostart(file, true)

    expect(await readSettings(file)).toEqual({ proxyEnabled: true, autostart: true })
  })

  it('写窗口位置与代理开关都不会把自启意图改掉', async () => {
    await writeAutostart(file, false)
    await writeWindowBounds(file, { x: 0, y: 0, width: 1280, height: 800 })
    await writeSettings(file, { proxyEnabled: true })

    expect((await readSettings(file)).autostart).toBe(false)
  })

  it('非布尔值不被当作设置过，读出来仍是默认启用', async () => {
    for (const value of ['false', 1, null, {}]) {
      await writeFile(file, JSON.stringify({ proxyEnabled: false, autostart: value }), 'utf8')
      expect(await readSettings(file)).toEqual({ proxyEnabled: false })
    }
  })
})

describe('windowBounds', () => {
  const bounds = { x: 120, y: 80, width: 1280, height: 800 }

  it('写入后原样读回', async () => {
    await writeWindowBounds(file, bounds)
    expect(await readSettings(file)).toEqual({ proxyEnabled: false, windowBounds: bounds })
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      proxyEnabled: false,
      windowBounds: bounds
    })
  })

  it('写窗口位置不会把代理开关改掉', async () => {
    await writeSettings(file, { proxyEnabled: true })
    await writeWindowBounds(file, bounds)

    expect(await readSettings(file)).toEqual({ proxyEnabled: true, windowBounds: bounds })
  })

  it('改代理开关不会把窗口位置丢掉', async () => {
    await writeWindowBounds(file, bounds)
    await writeSettings(file, { proxyEnabled: true })

    expect(await readSettings(file)).toEqual({ proxyEnabled: true, windowBounds: bounds })
  })

  it('没有窗口记录时不凭空编一个', async () => {
    await writeSettings(file, { proxyEnabled: true })
    expect(await readSettings(file)).not.toHaveProperty('windowBounds')
  })

  it.each([
    ['缺字段', { x: 0, y: 0, width: 1280 }],
    ['非数字', { x: 0, y: 0, width: '1280', height: 800 }],
    ['null', null],
    ['数组', [0, 0, 1280, 800]],
    ['NaN 无法序列化，用超大值代替测试的非法形状', { x: 0, y: 0, width: {}, height: 800 }]
  ])('畸形记录（%s）被丢弃，读出来当作没有', async (_label, value) => {
    await writeFile(
      file,
      JSON.stringify({ proxyEnabled: true, windowBounds: value }),
      'utf8'
    )
    expect(await readSettings(file)).toEqual({ proxyEnabled: true })
  })
})
