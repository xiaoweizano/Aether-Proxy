import { readFile } from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'
import { writeFileAtomic } from './atomic'

function assertClashConfig(text: string): void {
  let parsed: unknown
  try {
    parsed = YAML.parse(text)
  } catch {
    throw new Error('不是合法的 Clash 配置：YAML 解析失败')
  }
  const cfg = parsed as Record<string, unknown>
  const hasProxies = Array.isArray(cfg?.proxies)
  const hasGroups = Array.isArray(cfg?.['proxy-groups'])
  if (!hasProxies && !hasGroups) throw new Error('不是合法的 Clash 配置：缺少 proxies 或 proxy-groups')
}

export async function importFromFile(profileDir: string, sourcePath: string): Promise<void> {
  const text = await readFile(sourcePath, 'utf8')
  assertClashConfig(text)
  await writeFileAtomic(path.join(profileDir, 'upstream.yaml'), text)
}

export async function importFromUrl(
  profileDir: string,
  url: string,
  fetchFn: typeof fetch = fetch
): Promise<void> {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`订阅地址返回 ${res.status}`)
  const text = await res.text()
  assertClashConfig(text)
  await writeFileAtomic(path.join(profileDir, 'upstream.yaml'), text)
}
