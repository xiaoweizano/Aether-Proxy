import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import type { OpenDialogOptions } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { bootstrap, type AppContext } from './bootstrap'
import { registerIpcHandlers, registerUnavailableHandlers } from './ipc'
import type { TrafficSnapshot } from './stats'
import { IPC } from '../shared/ipc'

/**
 * `--shot` 是开发期的截图冒烟：使用脚本给的临时 profile、截图后退出。
 * 所有分支都显式判断这个常量，正常启动完全不受影响。
 */
const shotMode = process.argv.includes('--shot')
const shotUserData = process.env['AETHER_SHOT_USER_DATA']

if (shotMode) {
  if (shotUserData === undefined || shotUserData === '') {
    // 没有隔离目录就宁可失败，也不能把冒烟写进真实 userData。
    console.error('[aether] --shot 缺少 AETHER_SHOT_USER_DATA')
    process.exit(1)
  }
  // 必须在 ready 之前：之后 Electron 已按真实 userData 建好缓存与 singleton 状态。
  // 变量只在 --shot 下存在，生产路径永远不会执行到这里。
  app.setPath('userData', shotUserData)
}

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

const SHOT_SETTLE_MS = 500

function shotOutputFile(): string {
  return (
    process.env['AETHER_SHOT_OUTPUT'] ??
    path.resolve(__dirname, '../../docs/design/mockups/app-smoke.png')
  )
}

/**
 * 截图并做空白判定：`capturePage()` 在窗口没画出来时会给出空图或纯色图，
 * 两者都必须算失败，否则脚本会把「白屏」当成通过。
 * `toBitmap()` 是 BGRA，每 4 字节一个像素；逐像素比较而不是逐字节，
 * 否则同一个像素内部的 B/G/R 差异会被误当成「非空白」。
 */
async function captureShot(win: BrowserWindow): Promise<void> {
  const image = await win.webContents.capturePage()
  if (image.isEmpty()) throw new Error('截图内容为空')
  const bitmap = image.toBitmap()
  const pixelCount = Math.floor(bitmap.length / 4)
  if (pixelCount === 0) throw new Error('截图没有像素数据')
  const first = bitmap.readUInt32LE(0)
  let different = 0
  for (let offset = 4; offset + 3 < bitmap.length; offset += 4) {
    if (bitmap.readUInt32LE(offset) !== first) different += 1
  }
  if (different === 0) throw new Error('截图是纯色，判定为空白')

  const target = shotOutputFile()
  await mkdir(path.dirname(target), { recursive: true })
  const png = image.toPNG()
  await writeFile(target, png)
  const { width, height } = image.getSize()
  const ratio = ((different / pixelCount) * 100).toFixed(2)
  console.log(
    `[aether] 截图 ${target} ${width}x${height} ${png.length} bytes 非空像素 ${ratio}%`
  )
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

  if (shotMode) {
    // 加载完成后留一点时间让 React 首次渲染并完成布局，再截图。
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        void captureShot(win)
          .then(() => { app.quit() })
          .catch((err: unknown) => {
            console.error('[aether] 截图冒烟失败', err)
            app.exit(1)
          })
      }, SHOT_SETTLE_MS)
    })
    win.webContents.once('did-fail-load', (_event, code, description) => {
      console.error(`[aether] 截图冒烟加载失败 ${code} ${description}`)
      app.exit(1)
    })
  }

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

/**
 * 渲染层是沙箱，`<input type=file>` 拿不到可用路径；导入必须经主进程原生对话框。
 * 取消、没有选中文件都归一为 `null`，由 IPC 层转成 cancelled。
 */
async function pickImportFile(): Promise<string | null> {
  const options: OpenDialogOptions = {
    properties: ['openFile'],
    filters: [{ name: 'Clash YAML', extensions: ['yaml', 'yml'] }]
  }
  const result =
    mainWindow === null || mainWindow.isDestroyed()
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(mainWindow, options)
  if (result.canceled) return null
  return result.filePaths[0] ?? null
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
      settingsFile: path.join(userDataDir, 'settings.json'),
      pickImportFile
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
