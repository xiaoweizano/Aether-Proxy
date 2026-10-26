import { app, BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'
import { bootstrap, type AppContext } from './bootstrap'
import { registerIpcHandlers, registerUnavailableHandlers } from './ipc'

let context: AppContext | null = null
let quitting = false

function createWindow(startupStatus: AppContext['startupStatus']): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#0A0B0D',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    const url = new URL(devUrl)
    url.searchParams.set('startupStatus', startupStatus)
    void win.loadURL(url.toString())
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'), {
      query: { startupStatus }
    })
  }
}

async function start(): Promise<void> {
  const userDataDir = app.getPath('userData')
  try {
    context = await bootstrap({
      userDataDir,
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      repoRoot: path.resolve(__dirname, '../..')
    })
    registerIpcHandlers(ipcMain, context, {
      settingsFile: path.join(userDataDir, 'settings.json')
    })
    createWindow(context.startupStatus)
  } catch (err) {
    // 装配层意外失败时仍要开窗，让用户能看到状态而不是应用无声退出。
    console.error('[aether] bootstrap 失败', err)
    // 通道也要注册：否则渲染层的 getStatus 直接 reject，状态页无法显示。
    registerUnavailableHandlers(ipcMain)
    createWindow('core-error')
  }
}

app.whenReady().then(() => { void start() })

app.on('before-quit', (event) => {
  if (quitting || context === null) return
  // 等清理真正完成再退出：还原系统代理、终止内核是硬要求，不能随进程一起被杀。
  event.preventDefault()
  quitting = true
  void context
    .stopAll()
    .catch((err) => { console.error('[aether] 退出清理失败', err) })
    .finally(() => { app.quit() })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
