import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type {
  AetherApi,
  AppStatusView,
  ModeSetResult,
  PickImportResult,
  ProxyGroupView,
  SimpleResult,
  StatsSample
} from '../shared/ipc'
import type { Mode } from '../shared/types'

const api: AetherApi = {
  getStatus: () => ipcRenderer.invoke(IPC.statusGet) as Promise<AppStatusView>,
  getProxies: () => ipcRenderer.invoke(IPC.proxiesGet) as Promise<ProxyGroupView[]>,
  setMode: (mode: Mode) => ipcRenderer.invoke(IPC.modeSet, mode) as Promise<ModeSetResult>,
  enableProxy: () => ipcRenderer.invoke(IPC.proxyEnable) as Promise<SimpleResult>,
  disableProxy: () => ipcRenderer.invoke(IPC.proxyDisable) as Promise<SimpleResult>,
  restartCore: () => ipcRenderer.invoke(IPC.coreRestart) as Promise<SimpleResult>,
  importConfig: () =>
    ipcRenderer.invoke(IPC.configPickImport) as Promise<PickImportResult>,
  onStats: (cb) => {
    const listener = (_event: unknown, sample: StatsSample): void => cb(sample)
    ipcRenderer.on(IPC.statsPush, listener)
    return () => {
      ipcRenderer.removeListener(IPC.statsPush, listener)
    }
  }
}

contextBridge.exposeInMainWorld('aether', api)
