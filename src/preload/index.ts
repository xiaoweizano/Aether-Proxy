import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type {
  AetherApi,
  AppStatusView,
  ConnectionsSnapshot,
  DialFailureCounts,
  ModeSetResult,
  NodeSwitchInput,
  NodeSwitchResult,
  PickImportResult,
  ProxyGroupView,
  SimpleResult,
  StatsSample
} from '../shared/ipc'
import type { Mode } from '../shared/types'

/** 只转发白名单字段，渲染层塞进来的其它键不会进入主进程。 */
function nodeSwitchInput(input: NodeSwitchInput): NodeSwitchInput {
  return { group: input.group, node: input.node }
}

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
  },
  getConnections: () =>
    ipcRenderer.invoke(IPC.connectionsGet) as Promise<ConnectionsSnapshot>,
  onConnections: (cb) => {
    const listener = (_event: unknown, snapshot: ConnectionsSnapshot): void => cb(snapshot)
    ipcRenderer.on(IPC.connectionsPush, listener)
    return () => {
      ipcRenderer.removeListener(IPC.connectionsPush, listener)
    }
  },
  getLogCounts: () =>
    ipcRenderer.invoke(IPC.logsCountsGet) as Promise<DialFailureCounts | null>,
  onLogCounts: (cb) => {
    const listener = (_event: unknown, counts: DialFailureCounts): void => cb(counts)
    ipcRenderer.on(IPC.logsCountsPush, listener)
    return () => {
      ipcRenderer.removeListener(IPC.logsCountsPush, listener)
    }
  },
  switchNode: (input: NodeSwitchInput) =>
    ipcRenderer.invoke(IPC.nodeSwitch, nodeSwitchInput(input)) as Promise<NodeSwitchResult>,
  // 不传任何参数：主进程只打开自己的配置目录，渲染层没有指定路径的能力。
  openConfigDir: () => ipcRenderer.invoke(IPC.configOpenDir) as Promise<SimpleResult>
}

contextBridge.exposeInMainWorld('aether', api)
