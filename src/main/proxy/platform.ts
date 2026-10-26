import type { ProxyState } from '../../shared/types'

export interface PlatformProxy {
  getSystemProxy(): Promise<ProxyState>
  setSystemProxy(opts: { server: string; bypass: string[] }): Promise<void>
  clearSystemProxy(): Promise<void>
  restore(state: ProxyState): Promise<void>
}
