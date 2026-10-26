export interface StartupDeps {
  ownership: {
    restoreOnStartupIfStale(): Promise<'none' | 'restored' | 'conflict'>
  }
  loadConfig(): Promise<{ ok: boolean; error?: string }>
  core: { start(): Promise<unknown> }
  proxy: { enable(server: string): Promise<void> }
  server: string
  lastProxyEnabled: boolean
}

export interface StartupResult {
  status: 'ready' | 'config-error' | 'core-error'
  restore: 'none' | 'restored' | 'conflict'
}

export async function startup(deps: StartupDeps): Promise<StartupResult> {
  const restore = await deps.ownership.restoreOnStartupIfStale()

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
  await deps.proxy.disable()
  await deps.ownership.restoreOnExit()
  await deps.core.stop()
}
