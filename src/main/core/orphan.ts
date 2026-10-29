export interface OrphanInput {
  port: number
  oldSecret: string
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
    // 超时同样落到 none：调用方不能把 none 当成"端口空闲"，应另选端口。
    return 'none'
  }
  return res.ok ? 'ours' : 'foreign'
}
