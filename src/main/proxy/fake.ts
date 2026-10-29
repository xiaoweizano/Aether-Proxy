import type { ProxyState } from '../../shared/types'
import type { PlatformProxy } from './platform'

export class FakePlatformProxy implements PlatformProxy {
  constructor(private state: ProxyState) {}

  async getSystemProxy(): Promise<ProxyState> {
    return structuredClone(this.state)
  }

  async setSystemProxy(opts: { server: string; bypass: string[] }): Promise<void> {
    this.state = { enabled: true, server: opts.server, bypass: [...opts.bypass] }
  }

  async clearSystemProxy(): Promise<void> {
    this.state = { enabled: false }
  }

  async restore(state: ProxyState): Promise<void> {
    this.state = structuredClone(state)
  }
}
