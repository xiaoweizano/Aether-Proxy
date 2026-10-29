export interface ShutdownSource {
  on(event: string, cb: () => void): void
}

/**
 * 把 shutdown、before-quit、session-end 聚合到同一个幂等清理。
 * 返回值可被调用方 await：事件触发与显式调用共享同一个 Promise，
 * 同步抛错会被归一成日志，不会让任何一方收到拒绝。
 */
export function registerShutdownHooks(
  source: ShutdownSource,
  shutdown: () => Promise<void>
): () => Promise<void> {
  let running: Promise<void> | null = null

  const run = (): Promise<void> => {
    running ??= (async () => {
      try {
        await shutdown()
      } catch (err) {
        console.error('[aether] shutdown failed', err)
      }
    })()
    return running
  }

  for (const event of ['shutdown', 'before-quit', 'session-end']) {
    source.on(event, () => { void run() })
  }
  return run
}
