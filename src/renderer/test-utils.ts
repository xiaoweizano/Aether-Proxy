import { vi } from 'vitest'
import type { AetherApi, AppStatusView, ConnectionView } from '../shared/ipc'

export const readyStatus: AppStatusView = {
  status: 'ready',
  restore: 'none',
  mode: 'rule',
  proxyEnabled: false
}

/** 构造一份完整的 window.aether mock；用例只覆盖自己关心的字段。 */
export function makeAether(overrides: Partial<AetherApi> = {}): AetherApi {
  return {
    getStatus: vi.fn(async () => readyStatus),
    getProxies: vi.fn(async () => []),
    setMode: vi.fn(async () => ({ ok: true, status: 204 })),
    enableProxy: vi.fn(async () => ({ ok: true })),
    disableProxy: vi.fn(async () => ({ ok: true })),
    restartCore: vi.fn(async () => ({ ok: true })),
    importConfig: vi.fn(async () => ({ ok: true, needsRestart: true }) as const),
    onStats: vi.fn(() => () => {}),
    getConnections: vi.fn(async () => ({ items: [], memory: null, at: Date.now() })),
    onConnections: vi.fn(() => () => {}),
    getLogCounts: vi.fn(async () => null),
    onLogCounts: vi.fn(() => () => {}),
    switchNode: vi.fn(async () => ({ ok: true, status: 204 })),
    openConfigDir: vi.fn(async () => ({ ok: true })),
    ...overrides
  }
}

/** 一条字段齐全的连接；单个用例只覆盖自己关心的字段。 */
export function makeConnection(overrides: Partial<ConnectionView> = {}): ConnectionView {
  const startedAt = new Date(2026, 0, 2, 13, 42, 7).getTime()
  return {
    id: 'c1',
    startedAt,
    chains: ['Proxy', 'HK-01'],
    rule: 'DomainSuffix',
    rulePayload: 'github.com',
    host: 'github.com',
    process: 'chrome',
    processPath: 'C:\\Program Files\\Google\\Chrome\\chrome.exe',
    network: 'tcp',
    destinationIp: '140.82.112.3',
    destinationPort: '443',
    sourceIp: '127.0.0.1',
    sourcePort: '51515',
    upload: 2048,
    download: 4096,
    ended: false,
    endedAt: null,
    ...overrides
  }
}
