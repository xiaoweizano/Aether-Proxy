import { nextRestart, type RestartPolicy } from './backoff'

export interface RestarterOptions {
  start(): Promise<unknown>
  now?: () => number
  schedule?: (fn: () => void, ms: number) => void
  policy?: RestartPolicy
  onGiveUp?: () => void
  onStartError?: (err: unknown) => void
}

export class CoreRestarter {
  private readonly now: () => number
  private readonly schedule: (fn: () => void, ms: number) => unknown
  private pendingCancel: (() => void) | null = null
  readonly attempts: number[] = []

  constructor(private readonly opts: RestarterOptions) {
    this.now = opts.now ?? Date.now
    this.schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms))
  }

  notifyExit(): { scheduled: boolean; delayMs?: number } {
    const now = this.now()
    const decision = nextRestart(this.attempts, now, this.opts.policy)
    if (!decision) {
      this.opts.onGiveUp?.()
      return { scheduled: false }
    }
    this.attempts.push(now)
    let cancelled = false
    const handle = this.schedule(() => {
      if (cancelled) return
      this.pendingCancel = null
      void this.opts.start().catch((err) => { this.opts.onStartError?.(err) })
    }, decision.delayMs)
    this.pendingCancel = () => {
      cancelled = true
      if (
        typeof handle === 'number' ||
        (typeof handle === 'object' && handle !== null && 'hasRef' in handle)
      ) {
        clearTimeout(handle as NodeJS.Timeout)
      }
    }
    return { scheduled: true, delayMs: decision.delayMs }
  }

  /** 取消尚未触发的重启调度（例如用户主动停止内核后）。 */
  cancel(): void {
    const cancel = this.pendingCancel
    this.pendingCancel = null
    cancel?.()
  }
}
