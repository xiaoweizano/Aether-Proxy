import { readFile, rm } from 'node:fs/promises'
import type { ProxyState } from '../../shared/types'
import type { PlatformProxy } from './platform'
import { writeFileAtomic } from '../config/atomic'

export interface AppliedProxy {
  server: string
  bypass: string[]
}

interface SavedState extends ProxyState {
  owner: 'aether'
  pid: number
  at: number
  /** 我们在原快照之上真正写入系统的值；原快照字段始终保持不可变。 */
  applied?: AppliedProxy
  appliedAt?: number
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

function sameBypass(a: string[] | undefined, b: string[] | undefined): boolean {
  const left = new Set(a ?? [])
  const right = new Set(b ?? [])
  if (left.size !== right.size) return false
  for (const item of left) if (!right.has(item)) return false
  return true
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM 说明进程存在但无权探测，仍按存活处理。
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export class ProxyOwnership {
  constructor(
    private readonly pp: PlatformProxy,
    private readonly stateFile: string,
    private readonly now: () => number = Date.now,
    private readonly pid: number = process.pid
  ) {}

  /** 只记录"应用前"的原状态，已有快照时绝不覆盖。 */
  async snapshotBeforeApply(state: ProxyState): Promise<void> {
    if (await this.hasSnapshot()) return
    const saved: SavedState = { ...state, owner: 'aether', pid: this.pid, at: this.now() }
    await writeFileAtomic(this.stateFile, JSON.stringify(saved, null, 2))
  }

  /** 系统代理写入成功后才记录实际写入值，失败时不能留下半套所有权信息。 */
  async markApplied(server: string, bypass: string[]): Promise<void> {
    const saved = await this.load()
    if (!saved) throw new Error('缺少系统代理快照，无法记录已应用状态')
    const updated: SavedState = {
      ...saved,
      applied: { server, bypass: [...bypass] },
      appliedAt: this.now()
    }
    await writeFileAtomic(this.stateFile, JSON.stringify(updated, null, 2))
  }

  async hasSnapshot(): Promise<boolean> {
    return (await this.load()) !== null
  }

  async getApplied(): Promise<AppliedProxy | null> {
    const applied = (await this.load())?.applied
    return applied ? { server: applied.server, bypass: [...applied.bypass] } : null
  }

  private async load(): Promise<SavedState | null> {
    try {
      const parsed = JSON.parse(await readFile(this.stateFile, 'utf8')) as SavedState
      return parsed.owner === 'aether' ? parsed : null
    } catch {
      return null
    }
  }

  /**
   * 启动时清理上一次运行残留。只有当前系统代理仍完整等于我们写入的值时才还原；
   * 另一个仍存活的 Aether 进程持有快照时返回 in-use，既不还原也不删除。
   */
  async restoreOnStartupIfStale(): Promise<'none' | 'restored' | 'conflict' | 'in-use'> {
    const saved = await this.load()
    if (!saved) return 'none'
    if (saved.pid !== this.pid && isProcessAlive(saved.pid)) return 'in-use'

    const current = await this.pp.getSystemProxy()
    if (!this.ownsCurrentState(saved, current)) {
      await rm(this.stateFile, { force: true })
      return 'conflict'
    }
    await this.pp.restore(toProxyState(saved))
    await rm(this.stateFile, { force: true })
    return 'restored'
  }

  /**
   * 正常退出：会话期间若别的程序改过代理（PAC、ProxyOverride、开关），
   * 不覆盖对方；只清理自己的标记。
   */
  async restoreOnExit(): Promise<void> {
    const saved = await this.load()
    if (!saved) return
    if (saved.pid !== this.pid && isProcessAlive(saved.pid)) return

    const current = await this.pp.getSystemProxy()
    if (this.ownsCurrentState(saved, current)) {
      await this.pp.restore(toProxyState(saved))
    }
    await rm(this.stateFile, { force: true })
  }

  private ownsCurrentState(saved: SavedState, current: ProxyState): boolean {
    const applied = saved.applied
    if (!applied) return false
    return (
      current.enabled === true &&
      current.server === applied.server &&
      current.autoConfigUrl === undefined &&
      current.autoDetect !== true &&
      sameBypass(current.bypass, applied.bypass)
    )
  }
}
