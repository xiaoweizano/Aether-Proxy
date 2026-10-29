import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readSettings, writeSettings, writeWindowBounds } from './settings'

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
