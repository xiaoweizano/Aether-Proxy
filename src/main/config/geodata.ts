import { createHash, randomBytes } from 'node:crypto'
import { copyFile, mkdir, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'

export const GEODATA_FILES = ['Country.mmdb', 'geosite.dat'] as const

async function sha256File(file: string): Promise<string | null> {
  try {
    const data = await readFile(file)
    return createHash('sha256').update(data).digest('hex')
  } catch {
    return null
  }
}

async function copyAtomic(source: string, target: string): Promise<void> {
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await copyFile(source, tmp)
    await rename(tmp, target)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}

/**
 * 把 vendor 中的 geodata 同步到 mihomo 的 homeDir。
 * 只有目标缺失或内容哈希不一致时才原子替换；GEOIP/GEOSITE 规则依赖这两个文件，
 * 缺失时 `mihomo -t` 会尝试联网下载并撞上 15 秒校验超时。
 */
export async function ensureGeodata(homeDir: string, vendorDir: string): Promise<void> {
  await mkdir(homeDir, { recursive: true })
  for (const name of GEODATA_FILES) {
    const source = path.join(vendorDir, name)
    const target = path.join(homeDir, name)
    const expected = await sha256File(source)
    if (expected === null) throw new Error(`缺少 geodata 资源：${source}`)
    if ((await sha256File(target)) === expected) continue
    await copyAtomic(source, target)
  }
}

/** 校验 homeDir 中的 geodata 是否与 vendor 完全一致。missing 同时包含缺失与哈希不符的文件。 */
export async function verifyGeodata(
  homeDir: string,
  vendorDir: string
): Promise<{ ok: boolean; missing: string[] }> {
  const missing: string[] = []
  for (const name of GEODATA_FILES) {
    const expected = await sha256File(path.join(vendorDir, name))
    const actual = await sha256File(path.join(homeDir, name))
    if (expected === null || actual !== expected) missing.push(name)
  }
  return { ok: missing.length === 0, missing }
}
