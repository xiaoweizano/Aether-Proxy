import type { PlatformProxy } from './platform'
import type { ProxyOwnership } from './ownership'

export const DEFAULT_BYPASS = ['localhost', '127.0.0.0/8', '::1', '<local>'] as const

export class SystemProxyController {
  constructor(
    private readonly pp: PlatformProxy,
    private readonly ownership: ProxyOwnership
  ) {}

  async enable(server: string): Promise<void> {
    const current = await this.pp.getSystemProxy()
    if (!(await this.ownership.hasSnapshot())) {
      await this.ownership.snapshotBeforeApply(current)
    }
    const bypass = [...DEFAULT_BYPASS]
    // 先真正写入系统代理，成功后才记录 applied；写入失败不会留下所有权记录。
    await this.pp.setSystemProxy({ server, bypass })
    await this.ownership.markApplied(server, bypass)
  }

  async disable(): Promise<void> {
    await this.ownership.restoreOnExit()
  }
}
