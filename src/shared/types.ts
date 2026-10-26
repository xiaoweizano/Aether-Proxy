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

export interface ConnectionView {
  id: string
  start: string
  process?: string
  processPath?: string
  host: string
  network: string
  rule: string
  rulePayload: string
  chains: string[]        // 已反转：最外层策略组在前，实际出站在后
  upload: number
  download: number
  destinationIP?: string
  destinationPort?: string
  ended: boolean
  endedAt?: number
}
