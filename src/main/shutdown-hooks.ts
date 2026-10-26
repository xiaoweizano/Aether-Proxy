export interface ShutdownSource {
  on(event: string, cb: () => void): void
}

export function registerShutdownHooks(source: ShutdownSource, shutdown: () => Promise<void>): void {
  let running: Promise<void> | null = null
  const run = (): Promise<void> => {
    running ??= shutdown().catch(() => {})
    return running
  }
  source.on('shutdown', () => { void run() })
  source.on('before-quit', () => { void run() })
}
