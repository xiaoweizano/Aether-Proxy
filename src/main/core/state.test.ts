import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { clearCoreState, inspectCoreState, readCoreState, writeCoreState } from './state'

let dir: string
let file: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'aether-state-'))
  file = path.join(dir, 'core.json')
})

describe('core state', () => {
  it('写入后可读回，并记录当前 Aether 进程为 ownerPid', async () => {
    await writeCoreState(file, { pid: 1234, port: 5678, secret: 'abc' })
    expect(await readCoreState(file)).toEqual({
      pid: 1234,
      port: 5678,
      secret: 'abc',
      ownerPid: process.pid
    })
    const entries = await readdir(dir)
    expect(entries).toEqual(['core.json'])
  })

  it('旧文件没有 ownerPid 也能读取，不能判为损坏', async () => {
    await writeFile(
      file,
      JSON.stringify({ pid: 1234, port: 5678, secret: 'abc' }),
      'utf8'
    )
    expect(await readCoreState(file)).toEqual({ pid: 1234, port: 5678, secret: 'abc' })
    expect(await inspectCoreState(file)).toEqual({
      kind: 'ok',
      state: { pid: 1234, port: 5678, secret: 'abc' }
    })
  })

  it('文件不存在时返回 null，并标记为 missing', async () => {
    expect(await readCoreState(file)).toBeNull()
    expect(await inspectCoreState(file)).toEqual({ kind: 'missing' })
  })

  it('内容损坏或结构不对时标记为 corrupt', async () => {
    await writeFile(file, 'not json', 'utf8')
    expect(await readCoreState(file)).toBeNull()
    expect(await inspectCoreState(file)).toEqual({ kind: 'corrupt' })

    await writeFile(file, JSON.stringify({ pid: '1', port: 2, secret: 'x' }), 'utf8')
    expect(await readCoreState(file)).toBeNull()
    expect(await inspectCoreState(file)).toEqual({ kind: 'corrupt' })

    await writeFile(
      file,
      JSON.stringify({ pid: 1, port: 2, secret: 'x', ownerPid: 'not-a-pid' }),
      'utf8'
    )
    expect(await readCoreState(file)).toBeNull()
    expect(await inspectCoreState(file)).toEqual({ kind: 'corrupt' })
  })

  it('读取失败但不是 ENOENT 时标记为 unreadable，而不是 corrupt', async () => {
    // 目录在 Windows / POSIX 上都会让 readFile 以非 ENOENT 失败。
    const asDir = path.join(dir, 'core-state.json')
    await mkdir(asDir)
    const result = await inspectCoreState(asDir)
    expect(result.kind).toBe('unreadable')
    expect(await readCoreState(asDir)).toBeNull()
  })

  it('clear 删除状态文件', async () => {
    await writeCoreState(file, { pid: 1, port: 2, secret: 's' })
    await clearCoreState(file)
    expect(await readCoreState(file)).toBeNull()
    await expect(readFile(file, 'utf8')).rejects.toThrow()
  })
})
