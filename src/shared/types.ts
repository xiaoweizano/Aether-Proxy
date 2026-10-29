export type Mode = 'rule' | 'global' | 'direct'

export interface ProxyState {
  enabled: boolean
  server?: string
  bypass?: string[]
  autoConfigUrl?: string
  autoDetect?: boolean
}

export interface CoreInfo {
  pid: number
  version: string
  controllerPort: number
  startedAt: number
}

export type CoreStatus = 'stopped' | 'starting' | 'running' | 'error'

