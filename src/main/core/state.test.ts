import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { clearCoreState, readCoreState, writeCoreState } from './state'

let dir: string
let file: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'aether-state-'))
  file = path.join(dir, 'core.json')
})

describe('core state', () => {
  it('写入后可读回', async () => {
    await writeCoreState(file, { pid: 1234, port: 5678, secret: 'abc' })
    expect(await readCoreState(file)).toEqual({ pid: 1234, port: 5678, secret: 'abc' })
    const entries = await readdir(dir)
    expect(entries).toEqual(['core.json'])
  })

  it('文件不存在时返回 null', async () => {
    expect(await readCoreState(file)).toBeNull()
  })

  it('内容损坏或结构不对时返回 null', async () => {
    await writeFile(file, 'not json', 'utf8')
    expect(await readCoreState(file)).toBeNull()
    await writeFile(file, JSON.stringify({ pid: '1', port: 2, secret: 'x' }), 'utf8')
    expect(await readCoreState(file)).toBeNull()
  })

  it('clear 删除状态文件', async () => {
    await writeCoreState(file, { pid: 1, port: 2, secret: 's' })
    await clearCoreState(file)
    expect(await readCoreState(file)).toBeNull()
    await expect(readFile(file, 'utf8')).rejects.toThrow()
  })
})
