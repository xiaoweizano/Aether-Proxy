import { contextBridge } from 'electron'

contextBridge.exposeInMainWorld('aether', {})
