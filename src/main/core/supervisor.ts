import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import type { CoreInfo, CoreStatus } from '../../shared/types'

export interface CoreSupervisorOptions {
  binary: string
  homeDir: string
  configPath: string
  controllerPort: number
  secret: string
  argsPrefix?: string[]
  env?: Record<string, string>
  spawn?: typeof nodeSpawn
  fetchFn?: typeof fetch
}

export class CoreSupervisor {
  private child: ChildProcess | null = null
  private state: CoreStatus = 'stopped'
  private failures = 0
  private readonly spawnFn: typeof nodeSpawn
  private readonly fetchFn: typeof fetch

  constructor(private readonly opts: CoreSupervisorOptions) {
    this.spawnFn = opts.spawn ?? nodeSpawn
    this.fetchFn = opts.fetchFn ?? fetch
  }

  get status(): CoreStatus { return this.state }

  async start(): Promise<CoreInfo> {
    this.state = 'starting'
    const args = [
      ...(this.opts.argsPrefix ?? []),
      '-d', this.opts.homeDir,
      '-f', this.opts.configPath
    ]
    const child = this.spawnFn(this.opts.binary, args, {
      env: { ...process.env, ...this.opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.child = child
    let spawnError: Error | null = null
    child.once('error', (err) => {
      spawnError = err
      this.state = 'error'
    })
    child.once('exit', () => {
      if (this.state !== 'stopped') this.state = 'error'
      this.child = null
    })

    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      if (spawnError) {
        await this.stop()
        throw spawnError
      }
      if (await this.checkHealth()) {
        this.failures = 0
        let version = 'unknown'
        try {
          version = await this.version()
        } catch {
          version = 'unknown'
        }
        this.state = 'running'
        return {
          pid: child.pid ?? -1,
          version,
          controllerPort: this.opts.controllerPort,
          startedAt: Date.now()
        }
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    await this.stop()
    throw new Error('内核握手超时')
  }

  async checkHealth(): Promise<boolean> {
    try {
      const res = await this.fetchFn(`http://127.0.0.1:${this.opts.controllerPort}/version`, {
        headers: { authorization: `Bearer ${this.opts.secret}` },
        signal: AbortSignal.timeout(1500)
      })
      if (!res.ok) {
        this.markFailure()
        return false
      }
      this.failures = 0
      return true
    } catch {
      this.markFailure()
      return false
    }
  }

  private markFailure(): void {
    this.failures += 1
    if (this.failures >= 3 && this.state === 'running') this.state = 'error'
  }

  private async version(): Promise<string> {
    const res = await this.fetchFn(`http://127.0.0.1:${this.opts.controllerPort}/version`, {
      headers: { authorization: `Bearer ${this.opts.secret}` },
      signal: AbortSignal.timeout(1500)
    })
    const body = (await res.json()) as { version?: string }
    return body.version ?? 'unknown'
  }

  async stop(): Promise<void> {
    const child = this.child
    this.state = 'stopped'
    this.child = null
    if (!child || child.exitCode !== null) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 3000)
      child.once('exit', () => { clearTimeout(timer); resolve() })
      child.kill('SIGTERM')
    })
  }
}
