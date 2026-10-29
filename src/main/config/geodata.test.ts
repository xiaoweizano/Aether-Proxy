import { describe, it, expect, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ensureGeodata, verifyGeodata } from './geodata'

let home: string
let vendor: string

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'aether-geodata-home-'))
  vendor = await mkdtemp(path.join(tmpdir(), 'aether-geodata-vendor-'))
  const country = 'country-db-v1'
  const geosite = 'geosite-db-v1'
  await writeFile(path.join(vendor, 'Country.mmdb'), country, 'utf8')
  await writeFile(path.join(vendor, 'geosite.dat'), geosite, 'utf8')
  await writeFile(
    path.join(vendor, 'SHA256SUMS'),
    `${sha256(country)}  Country.mmdb\n${sha256(geosite)}  geosite.dat\n`,
    'utf8'
  )
})

describe('ensureGeodata', () => {
  it('把两个文件复制进 home', async () => {
    await ensureGeodata(home, vendor)
    expect(await readFile(path.join(home, 'Country.mmdb'), 'utf8')).toBe('country-db-v1')
    expect(await readFile(path.join(home, 'geosite.dat'), 'utf8')).toBe('geosite-db-v1')
    expect(await verifyGeodata(home, vendor)).toEqual({ ok: true, missing: [] })
  })

  it('第二次调用是 no-op，不重写目标文件', async () => {
    await ensureGeodata(home, vendor)
    const old = new Date('2001-01-01T00:00:00Z')
    await utimes(path.join(home, 'Country.mmdb'), old, old)
    await utimes(path.join(home, 'geosite.dat'), old, old)

    await ensureGeodata(home, vendor)

    expect((await stat(path.join(home, 'Country.mmdb'))).mtimeMs).toBe(old.getTime())
    expect((await stat(path.join(home, 'geosite.dat'))).mtimeMs).toBe(old.getTime())
  })

  it('目标被破坏时用 vendor 版本替换', async () => {
    await writeFile(path.join(home, 'Country.mmdb'), 'garbage', 'utf8')
    await ensureGeodata(home, vendor)
    expect(await readFile(path.join(home, 'Country.mmdb'), 'utf8')).toBe('country-db-v1')
    expect(await verifyGeodata(home, vendor)).toEqual({ ok: true, missing: [] })
  })

  it('vendor 文件与 SHA256SUMS 不一致时拒绝复制', async () => {
    await writeFile(path.join(vendor, 'Country.mmdb'), 'tampered', 'utf8')
    await expect(ensureGeodata(home, vendor)).rejects.toThrow(
      'geodata 校验失败：Country.mmdb 与 SHA256SUMS 不一致'
    )
    await expect(readFile(path.join(home, 'Country.mmdb'), 'utf8')).rejects.toThrow()
  })

  it('vendor 缺少 SHA256SUMS 时给出明确错误', async () => {
    await rm(path.join(vendor, 'SHA256SUMS'))
    await expect(ensureGeodata(home, vendor)).rejects.toThrow('缺少 geodata 校验文件')
  })
})

describe('verifyGeodata', () => {
  it('缺失或哈希不符的文件会出现在 missing 中', async () => {
    await writeFile(path.join(home, 'Country.mmdb'), 'wrong', 'utf8')
    expect(await verifyGeodata(home, vendor)).toEqual({
      ok: false,
      missing: ['Country.mmdb', 'geosite.dat']
    })
  })
})
