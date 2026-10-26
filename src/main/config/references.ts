const BUILTIN = new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'GLOBAL'])

export function missingReferences(config: unknown): string[] {
  const cfg = (config ?? {}) as any
  const nodeNames = new Set<string>((cfg.proxies ?? []).map((p: any) => String(p?.name)))
  const groupNames = new Set<string>((cfg['proxy-groups'] ?? []).map((g: any) => String(g?.name)))
  const providers = new Set<string>(Object.keys(cfg['proxy-providers'] ?? {}))

  const missing: string[] = []
  for (const group of cfg['proxy-groups'] ?? []) {
    for (const ref of group?.proxies ?? []) {
      const name = String(ref)
      if (!nodeNames.has(name) && !groupNames.has(name) && !BUILTIN.has(name)) {
        missing.push(`${group.name}:${name}`)
      }
    }
    for (const provider of group?.use ?? []) {
      if (!providers.has(String(provider))) missing.push(`${group.name}:provider:${provider}`)
    }
  }
  return missing
}
