import type { PlatformProxy } from './platform'
import type { ProxyOwnership } from './ownership'

export const DEFAULT_BYPASS = ['localhost', '127.0.0.0/8', '::1', '<local>']

export class SystemProxyController {
  constructor(
    private readonly pp: PlatformProxy,
    private readonly ownership: ProxyOwnership
  ) {}

  async enable(server: string): Promise<void> {
    const current = await this.pp.getSystemProxy()
    if (!(await this.ownership.hasSnapshot())) {
      await this.ownership.snapshotBeforeApply(current, server)
    }
    await this.pp.setSystemProxy({ server, bypass: DEFAULT_BYPASS })
  }

  async disable(): Promise<void> {
    await this.ownership.restoreOnExit()
  }
}
