export async function reloadConfig(
  controllerPort: number,
  secret: string,
  configPath: string,
  fetchFn: typeof fetch = fetch
): Promise<{ ok: boolean; status: number }> {
  try {
    const res = await fetchFn(`http://127.0.0.1:${controllerPort}/configs?force=true`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${secret}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ path: configPath }),
      signal: AbortSignal.timeout(10_000)
    })
    return { ok: res.ok, status: res.status }
  } catch {
    return { ok: false, status: 0 }
  }
}
