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
    // 已有本应用的快照时不再覆盖：第二次调用拿到的"原状态"已经是 Aether 写入的地址。
    if (await this.hasSnapshot()) return
    const saved: SavedState = { ...state, owner: 'aether', pid: this.pid, at: this.now(), appliedServer }
    await writeFileAtomic(this.stateFile, JSON.stringify(saved, null, 2))
  }

  async hasSnapshot(): Promise<boolean> {
    return (await this.load()) !== null
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
    const current = await this.pp.getSystemProxy()
    // 会话期间若别的程序改了代理，不要覆盖它；只清理自己的标记。
    if (current.enabled && current.server === saved.appliedServer) {
      await this.pp.restore(toProxyState(saved))
    }
    await rm(this.stateFile, { force: true })
  }
}
