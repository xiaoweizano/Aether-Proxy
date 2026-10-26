import { nextRestart, type RestartPolicy } from './backoff'

export interface RestarterOptions {
  start(): Promise<unknown>
  now?: () => number
  schedule?: (fn: () => void, ms: number) => void
  policy?: RestartPolicy
  onGiveUp?: () => void
}

export class CoreRestarter {
  private readonly now: () => number
  private readonly schedule: (fn: () => void, ms: number) => void
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
    this.schedule(() => { void this.opts.start() }, decision.delayMs)
    return { scheduled: true, delayMs: decision.delayMs }
  }
}
