export interface StartupDeps {
  ownership: {
    restoreOnStartupIfStale(): Promise<'none' | 'restored' | 'conflict' | 'in-use'>
  }
  loadConfig(): Promise<{ ok: boolean; error?: string }>
  core: { start(): Promise<unknown> }
  proxy: { enable(server: string): Promise<void> }
  server: string
  lastProxyEnabled: boolean
}

export interface StartupResult {
  status: 'ready' | 'config-error' | 'core-error' | 'in-use'
  restore: 'none' | 'restored' | 'conflict' | 'in-use'
}

export async function startup(deps: StartupDeps): Promise<StartupResult> {
  const restore = await deps.ownership.restoreOnStartupIfStale()
  // 另一个 Aether 进程仍持有系统代理：不接管内核，也不碰代理。
  if (restore === 'in-use') return { status: 'in-use', restore }

  const cfg = await deps.loadConfig()
  if (!cfg.ok) return { status: 'config-error', restore }

  try {
    await deps.core.start()
  } catch {
    return { status: 'core-error', restore }
  }

  if (deps.lastProxyEnabled) await deps.proxy.enable(deps.server)
  return { status: 'ready', restore }
}

export interface ShutdownDeps {
  ownership: { restoreOnExit(): Promise<void> }
  proxy: { disable(): Promise<void> }
  core: { stop(): Promise<void> }
}

export async function shutdown(deps: ShutdownDeps): Promise<void> {
  const errors: unknown[] = []
  try { await deps.proxy.disable() } catch (err) { errors.push(err) }
  try { await deps.ownership.restoreOnExit() } catch (err) { errors.push(err) }
  try { await deps.core.stop() } catch (err) { errors.push(err) }
  if (errors.length > 0) throw errors[0]
}
