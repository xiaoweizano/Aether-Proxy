import { app, BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'
import { bootstrap, type AppContext } from './bootstrap'
import { registerIpcHandlers, registerUnavailableHandlers } from './ipc'
import type { TrafficSnapshot } from './stats'
import { IPC } from '../shared/ipc'

let context: AppContext | null = null
let mainWindow: BrowserWindow | null = null
let quitting = false

/**
 * 采样回调只认「当前窗口」：窗口销毁即丢弃，重建窗口后由 createWindow 重新注册。
 * 只下发结构化快照，secret 与 controller 地址不出主进程。
 */
function pushStats(sample: TrafficSnapshot): void {
  if (mainWindow === null || mainWindow.isDestroyed()) return
  mainWindow.webContents.send(IPC.statsPush, sample)
}

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
  mainWindow = win
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())

  // 采集器可能在内核起来时就已 start（bootstrap 侧），这里再 start 只替换回调。
  context?.stats?.start(pushStats)

  win.once('closed', () => {
    if (mainWindow === win) mainWindow = null
    // 没有窗口就没有消费者，继续每 2 秒重连只会拖住事件循环。
    // 退出路径由 stopAll 兜底，这里覆盖「窗口没了但进程还在」。
    context?.stats?.stop()
  })

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
      repoRoot: path.resolve(__dirname, '../..'),
      // 内核在窗口之后才起来时（导入配置后重启），采集器由 bootstrap 创建，
      // 这个回调保证它一建立就有消费者。
      onStatsSample: pushStats
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
