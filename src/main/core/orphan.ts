export interface OrphanInput {
  port: number
  oldSecret: string
  expectedConfigHash: string
  fetchFn?: typeof fetch
}

export async function classifyOrphan(input: OrphanInput): Promise<'ours' | 'foreign' | 'none'> {
  const fetchFn = input.fetchFn ?? fetch
  let res: Response
  try {
    res = await fetchFn(`http://127.0.0.1:${input.port}/version`, {
      headers: { authorization: `Bearer ${input.oldSecret}` },
      signal: AbortSignal.timeout(1500)
    })
  } catch {
    return 'none'
  }
  if (res.status === 401 || res.status === 404) return 'foreign'
  if (!res.ok) return 'foreign'
  const body = (await res.json().catch(() => ({}))) as { configHash?: string }
  return body.configHash === input.expectedConfigHash ? 'ours' : 'foreign'
}
