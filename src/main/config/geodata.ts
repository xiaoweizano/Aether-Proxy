import { createHash, randomBytes } from 'node:crypto'
import { copyFile, mkdir, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'

export const GEODATA_FILES = ['Country.mmdb', 'geosite.dat'] as const

const CHECKSUMS_FILE = 'SHA256SUMS'

async function sha256File(file: string): Promise<string | null> {
  try {
    const data = await readFile(file)
    return createHash('sha256').update(data).digest('hex')
  } catch {
    return null
  }
}

async function readChecksums(vendorDir: string): Promise<Map<string, string>> {
  const file = path.join(vendorDir, CHECKSUMS_FILE)
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    throw new Error(`缺少 geodata 校验文件：${file}`)
  }
  const checksums = new Map<string, string>()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line)
    if (!match) throw new Error(`geodata 校验文件格式错误：${line}`)
    checksums.set(match[2]!.trim(), match[1]!.toLowerCase())
  }
  return checksums
}

function expectedHash(checksums: Map<string, string>, name: string): string {
  const expected = checksums.get(name)
  if (!expected) throw new Error(`SHA256SUMS 缺少 ${name}`)
  return expected
}

async function verifyVendorFile(source: string, name: string, expected: string): Promise<void> {
  const actual = await sha256File(source)
  if (actual === null) throw new Error(`缺少 geodata 资源：${source}`)
  if (actual !== expected) {
    throw new Error(
      `geodata 校验失败：${name} 与 SHA256SUMS 不一致（期望 ${expected}，实际 ${actual}）`
    )
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
 * 先按 SHA256SUMS 校验 vendor 文件，校验通过后只有目标缺失或哈希不一致时才原子替换。
 * GEOIP/GEOSITE 规则依赖这两个文件，缺失时 `mihomo -t` 会尝试联网下载并撞上 15 秒校验超时。
 */
export async function ensureGeodata(homeDir: string, vendorDir: string): Promise<void> {
  const checksums = await readChecksums(vendorDir)
  await mkdir(homeDir, { recursive: true })
  for (const name of GEODATA_FILES) {
    const source = path.join(vendorDir, name)
    const target = path.join(homeDir, name)
    const expected = expectedHash(checksums, name)
    await verifyVendorFile(source, name, expected)
    if ((await sha256File(target)) === expected) continue
    await copyAtomic(source, target)
  }
}

/**
 * 校验 homeDir 中的 geodata 是否与 vendor（以及 SHA256SUMS）完全一致。
 * vendor 自身损坏时直接抛错，避免把损坏文件当成合法来源。
 */
export async function verifyGeodata(
  homeDir: string,
  vendorDir: string
): Promise<{ ok: boolean; missing: string[] }> {
  const checksums = await readChecksums(vendorDir)
  const missing: string[] = []
  for (const name of GEODATA_FILES) {
    const expected = expectedHash(checksums, name)
    await verifyVendorFile(path.join(vendorDir, name), name, expected)
    if ((await sha256File(path.join(homeDir, name))) !== expected) missing.push(name)
  }
  return { ok: missing.length === 0, missing }
}
