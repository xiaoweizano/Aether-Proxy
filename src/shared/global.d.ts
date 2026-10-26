import type { AetherApi } from './ipc'

declare global {
  interface Window {
    /** 唯一的内核访问入口，由 preload 经 contextBridge 注入。 */
    aether: AetherApi
  }
}

export {}
