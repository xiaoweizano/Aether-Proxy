import { vi } from 'vitest'
import type { AetherApi, AppStatusView } from '../shared/ipc'

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
