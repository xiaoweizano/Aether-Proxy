export const IPC = {
  coreStatus: 'core:status',
  coreRestart: 'core:restart',
  proxyGet: 'proxy:get',
  proxyEnable: 'proxy:enable',
  proxyDisable: 'proxy:disable',
  modeSet: 'config:mode',
  connections: 'connections:update',
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
