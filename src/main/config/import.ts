import { readFile } from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'
import { writeFileAtomic } from './atomic'

/**
 * 请求订阅时使用的 User-Agent。
 *
 * 订阅站普遍**按 UA 分流**：非 Clash 客户端拿到的是机场的网页（200/403 + HTML），
 * 只有认得出 Clash 系 UA 才返回 YAML。Node 内置 fetch 的默认 UA 是 `undici`，
 * 正好落在「返回网页」那一侧——拿到的 HTML 会被当成 YAML 标量解析，最后报成
 * 「不是合法的 Clash 配置」，把服务器的问题说成用户配置坏了（issue #2）。
 *
 * 用 `clash.meta` 而不是自造标识：机场的白名单里通常只有这几种，新名字不在名单里。
 */
export const SUBSCRIPTION_USER_AGENT = 'clash.meta'

/** 订阅通常返回 YAML，但也接受纯文本；明确告诉服务器客户端能处理什么。 */
const SUBSCRIPTION_ACCEPT = 'application/yaml, text/yaml, text/plain, */*'

/** 响应体的前若干字节用来判断是不是网页；不需要读完整个 body 就能定性。 */
const HTML_SNIFF_BYTES = 512

function isHtmlBody(contentType: string, text: string): boolean {
  if (/text\/html|application\/xhtml/i.test(contentType)) return true
  // content-type 缺失或不准时按内容判断：HTML 文档总以 `<!doctype` / `<html` 开头。
  const head = text.slice(0, HTML_SNIFF_BYTES).trimStart().toLowerCase()
  return head.startsWith('<!doctype') || head.startsWith('<html')
}

/**
 * 从响应头里取 `content-type`。测试用 `Response` 构造的响应也有 headers，
 * 但注入的假 fetch 可能只给最小形状，所以缺省当空串。
 */
function contentTypeOf(res: Response): string {
  const headers = (res as { headers?: { get?: (name: string) => string | null } }).headers
  if (headers?.get === undefined) return ''
  return headers.get('content-type') ?? ''
}

/** 字节数的人类可读描述；空体单独说，因为 204 与「内容为空」是同一个问题。 */
function describeSize(text: string): string {
  if (text === '') return '空响应'
  const bytes = Buffer.byteLength(text, 'utf8')
  return `${bytes} 字节`
}

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

type FetchLike = typeof fetch

/**
 * 一次性拉取订阅并落盘。
 *
 * 失败信息按**服务器实际给了什么**分开说，不一律归到「配置不合法」：
 * 用户在别处能用同一个地址，说明订阅本身大概率没问题，问题在这条请求上。
 * 但**绝不打印响应正文**——订阅体里可能带凭据，只输出状态码、content-type 与字节数。
 */
export async function importFromUrl(
  profileDir: string,
  url: string,
  fetchFn: FetchLike = fetch
): Promise<void> {
  const res = await fetchFn(url, {
    signal: AbortSignal.timeout(15_000),
    headers: {
      'user-agent': SUBSCRIPTION_USER_AGENT,
      accept: SUBSCRIPTION_ACCEPT
    }
  })

  if (res.status === 204) {
    throw new Error(
      '订阅服务器没有返回内容（HTTP 204）：地址可能已过期，或需要在 Clash 客户端里重新获取'
    )
  }
  if (!res.ok) throw new Error(`订阅地址返回 ${res.status}`)

  const text = await res.text()

  if (text.trim() === '') {
    throw new Error('订阅服务器返回了空内容：地址可能已过期，或需要在 Clash 客户端里重新获取')
  }
  if (isHtmlBody(contentTypeOf(res), text)) {
    throw new Error(
      `订阅地址返回的是网页而不是配置（${describeSize(text)}）：该站点可能要求 Clash 客户端标识，或订阅链接已失效`
    )
  }

  try {
    assertClashConfig(text)
  } catch (err) {
    const reason = err instanceof Error ? err.message : '内容无法识别'
    throw new Error(`${reason}（响应 ${res.status}，${describeSize(text)}）`)
  }
  await writeFileAtomic(path.join(profileDir, 'upstream.yaml'), text)
}
