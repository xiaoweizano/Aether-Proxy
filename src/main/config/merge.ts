export interface Inject {
  mixedPort: number
  controllerPort: number
  secret: string
}

const ARRAY_MAP_KEYS = ['proxies', 'proxy-groups'] as const
const DICT_MAP_KEYS = ['proxy-providers', 'rule-providers'] as const
const DEEP_MERGE_KEYS = ['dns', 'sniffer', 'profile'] as const

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isObject(base) || !isObject(patch)) return structuredClone(patch)
  const out: Record<string, unknown> = structuredClone(base)
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isObject(v) && isObject(out[k]) ? deepMerge(out[k], v) : structuredClone(v)
  }
  return out
}

function mergeArrayByName(base: unknown, add: unknown): unknown {
  const list = Array.isArray(base) ? [...base] : []
  const additions = Array.isArray(add) ? add : []
  if (additions.length === 0) return list
  const byName = new Map<string, unknown>()
  for (const item of list) byName.set(String((item as any)?.name), item)
  for (const item of additions) byName.set(String((item as any)?.name), item)
  return [...byName.values()]
}

function mergeDict(base: unknown, add: unknown): unknown {
  const out = isObject(base) ? structuredClone(base) : {}
  if (isObject(add)) Object.assign(out, structuredClone(add))
  return out
}

export function mergeConfig(
  upstream: unknown,
  overrides: unknown,
  inject: Inject
): Record<string, unknown> {
  const base = isObject(upstream) ? structuredClone(upstream) : {}
  const ov = isObject(overrides) ? overrides : {}

  const baseRules = Array.isArray(base.rules) ? base.rules : []
  const prepend = Array.isArray((ov as any).rules?.prepend) ? (ov as any).rules.prepend : []
  const append = Array.isArray((ov as any).rules?.append) ? (ov as any).rules.append : []
  base.rules = [...prepend, ...baseRules, ...append]

  for (const key of ARRAY_MAP_KEYS) {
    if (key in ov) base[key] = mergeArrayByName(base[key], ov[key])
  }

  for (const key of DICT_MAP_KEYS) {
    if (key in ov) base[key] = mergeDict(base[key], ov[key])
  }

  for (const key of DEEP_MERGE_KEYS) {
    if (key in ov) base[key] = deepMerge(base[key], ov[key])
  }

  base['mixed-port'] = inject.mixedPort
  base['external-controller'] = `127.0.0.1:${inject.controllerPort}`
  base.secret = inject.secret
  base['find-process-mode'] = 'always'
  // 日志面板落地前保持安静：stdout/stderr 已被 supervisor 丢弃，
  // 高日志级别只会白耗内核 IO。
  base['log-level'] = 'warning'

  const tun = isObject(base.tun) ? base.tun : {}
  base.tun = { ...tun, enable: false }
  delete base['redir-port']
  delete base['tproxy-port']

  // 入站面收口：M1 只通过 mixed-port 服务本机，不允许局域网监听、
  // 额外的 http/socks 端口或任意 listeners 把内核暴露出去。
  delete base.port
  delete base['socks-port']
  delete base.listeners
  base['allow-lan'] = false

  // DNS 监听端口同样属于入站面；其余 dns 配置（增强模式、nameserver）保留。
  if (isObject(base.dns)) delete base.dns.listen

  return base
}
