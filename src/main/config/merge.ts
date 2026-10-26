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

  return base
}
