import { readFile, rm } from 'node:fs/promises'
import type { ProxyState } from '../../shared/types'
import type { PlatformProxy } from './platform'
import { writeFileAtomic } from '../config/atomic'

interface SavedState extends ProxyState {
  owner: 'aether'
  pid: number
  at: number
  appliedServer: string
}

function toProxyState(saved: SavedState): ProxyState {
  return {
    enabled: saved.enabled,
    server: saved.server,
    bypass: saved.bypass,
    autoConfigUrl: saved.autoConfigUrl,
    autoDetect: saved.autoDetect
  }
}

export class ProxyOwnership {
  constructor(
    private readonly pp: PlatformProxy,
    private readonly stateFile: string,
    private readonly now: () => number = Date.now,
    private readonly pid: number = process.pid
  ) {}

  async snapshotBeforeApply(state: ProxyState, appliedServer: string): Promise<void> {
    const saved: SavedState = { ...state, owner: 'aether', pid: this.pid, at: this.now(), appliedServer }
    await writeFileAtomic(this.stateFile, JSON.stringify(saved, null, 2))
  }

  private async load(): Promise<SavedState | null> {
    try {
      const parsed = JSON.parse(await readFile(this.stateFile, 'utf8')) as SavedState
      return parsed.owner === 'aether' ? parsed : null
    } catch {
      return null
    }
  }

  async restoreOnStartupIfStale(): Promise<'none' | 'restored' | 'conflict'> {
    const saved = await this.load()
    if (!saved) return 'none'
    const current = await this.pp.getSystemProxy()
    const untouched = current.enabled === true && current.server === saved.appliedServer
    if (!untouched) {
      await rm(this.stateFile, { force: true })
      return 'conflict'
    }
    await this.pp.restore(toProxyState(saved))
    await rm(this.stateFile, { force: true })
    return 'restored'
  }

  async restoreOnExit(): Promise<void> {
    const saved = await this.load()
    if (!saved) return
    await this.pp.restore(toProxyState(saved))
    await rm(this.stateFile, { force: true })
  }
}
