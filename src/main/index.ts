import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, screen, shell, Tray } from 'electron'
import type { OpenDialogOptions } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { bootstrap, type AppContext } from './bootstrap'
import { registerIpcHandlers, registerUnavailableHandlers } from './ipc'
import {
  createTray,
  createTrayActions,
  readTraySnapshot,
  toMenuTemplate,
  type TrayController,
  type TrayHost
} from './shell/tray'
import type { TrafficSnapshot } from './stats'
import { IPC } from '../shared/ipc'
import type { ConnectionsSnapshot, DialFailureCounts } from '../shared/ipc'

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
/** 首次 bootstrap 尚未返回时用它取消：context 还不存在，stopAll 无从调用。 */
const startAbort = new AbortController()
/** bootstrap 是否已经有结果（成功或失败）；退出清理要等这个，而不是死等 context。 */
let startSettled = false
let mainWindow: BrowserWindow | null = null
let quitting = false
/** 清理真正结束、允许放行的那一次 quit；此前所有 quit 都必须被挡住。 */
let cleanupDone = false
let trayController: TrayController | null = null
/** 托盘菜单的刷新定时器；只管状态类字段，速率从不参与菜单。 */
let trayTimer: NodeJS.Timeout | null = null

/**
 * 采样回调只认「当前窗口」：窗口销毁即丢弃，重建窗口后由 createWindow 重新注册。
 * 只下发结构化快照，secret 与 controller 地址不出主进程。
 */
function pushStats(sample: TrafficSnapshot): void {
  if (mainWindow === null || mainWindow.isDestroyed()) return
  mainWindow.webContents.send(IPC.statsPush, sample)
}

/**
 * 与 pushStats 同一形状：只推当前窗口，窗口销毁就丢弃。
 * 注意采集器本身不随窗口停止（连接缓冲要跨窗口重建存活），区别只在这里。
 */
function pushConnections(snapshot: ConnectionsSnapshot): void {
  if (mainWindow === null || mainWindow.isDestroyed()) return
  mainWindow.webContents.send(IPC.connectionsPush, snapshot)
}

/**
 * 计数推送只在有新拨号失败时到达；失败滚出窗口时没有回调、没有推送。
 * 渲染层必须同时轮询 `logsCountsGet`（`src/renderer/hooks/useLogCounts.ts`，3 秒一次）
 * 处理到期归零，否则仪表盘会一直显示过期的非零计数。
 */
function pushLogCounts(counts: DialFailureCounts): void {
  if (mainWindow === null || mainWindow.isDestroyed()) return
  mainWindow.webContents.send(IPC.logsCountsPush, counts)
}

/**
 * 托盘的「打开主窗口」。
 *
 * Task 3 只做聚焦：窗口还在，就把它从最小化/后台拉回来。Task 4 会把窗口改成
 * 「关闭即 destroy」，届时这里要变成「已销毁则重建」——重建必须走 createWindow，
 * 并带上当时的 startupStatus（渲染层用它决定首屏状态）。**不要**在这里提前写重建，
 * 否则 Task 4 改窗口语义时会两套生命周期同时存在。
 */
function showMainWindow(): void {
  if (mainWindow === null || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.focus()
}

/** 托盘图标的落点：打包态在 process.resourcesPath，开发态在仓库 resources/。 */
function trayIconDir(): string {
  const base = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '../..')
  return path.join(base, 'resources')
}

/**
 * 托盘图标。Windows 通知区域按「逻辑 16px × DPI 缩放」取图：
 * - 先从最高密度的源图（32px）加载，再按目标像素缩到 16×scale，边缘不会被二次采样糊掉；
 * - 源图缺失时退回 `tray.png`（16px）；两张都没有则留空图，由 Tray 自己显示占位图标，
 *   而不是让主进程在启动时抛错。
 *
 * 两个源图都是本仓库生成的单色标记（蓝底圆角方块 + 镂空「A」），见 resources/README。
 */
function trayImage(): Electron.NativeImage {
  const dir = trayIconDir()
  const high = nativeImage.createFromPath(path.join(dir, 'tray@2x.png'))
  const low = nativeImage.createFromPath(path.join(dir, 'tray.png'))
  const source = !high.isEmpty() ? high : low
  if (source.isEmpty()) return source
  const scale = screen.getPrimaryDisplay().scaleFactor
  const size = Math.max(16, Math.round(16 * scale))
  return source.resize({ width: size, height: size, quality: 'best' })
}

/**
 * Electron 侧的托盘适配器：唯一未被单测覆盖的部分。
 *
 * 每次 apply 都整份换菜单（菜单不可变）。托盘对象只创建一次：`setContextMenu`
 * 换掉的是菜单，不是 Tray；旧菜单连同内嵌的点击处理器一起被 GC，不会留下监听器。
 */
function createTrayHost(): TrayHost {
  const tray = new Tray(trayImage())
  const activateHandlers: (() => void)[] = []
  tray.on('click', () => {
    for (const handler of activateHandlers) handler()
  })

  return {
    apply(items, tooltip) {
      const template = toMenuTemplate(items, (err) => {
        console.error('[aether] 托盘动作失败', err)
      })
      tray.setContextMenu(Menu.buildFromTemplate(template))
      tray.setToolTip(tooltip)
    },
    onActivate(handler) {
      activateHandlers.push(handler)
    },
    dispose() {
      activateHandlers.length = 0
      tray.destroy()
    }
  }
}

/**
 * 托盘的刷新节奏。菜单只在状态变化时重建（由 `createTray` 的签名比较保证），
 * 这里只决定「多久问一次快照」。1.5 秒：比内核状态的变化粒度慢，又远比用户能
 * 察觉的延迟快；速率每秒推送，但根本不进快照，所以不会引起重建。
 */
const TRAY_REFRESH_MS = 1500

function startTray(ctx: AppContext, settingsFile: string): void {
  // 截图冒烟只需要一个窗口；托盘图标会在临时 profile 里留下痕迹，也会让
  // 冒烟进程的退出多一个持有者。--shot 下不建托盘。
  if (shotMode) return
  const controller = createTray({
    host: createTrayHost(),
    actions: createTrayActions({
      ctx,
      settingsFile,
      openWindow: showMainWindow,
      // 必须走 app.quit()：before-quit 里会做有序退出（还原系统代理、终止内核）。
      // 直接 process.exit 会跳过 stopAll，留下孤儿内核和改不回来的代理设置。
      quit: () => app.quit()
    }),
    readSnapshot: () => readTraySnapshot(ctx),
    onError: (err) => {
      console.warn('[aether] 托盘菜单刷新失败', err instanceof Error ? err.message : err)
    }
  })
  trayController = controller
  void controller.refresh()
  trayTimer = setInterval(() => {
    void controller.refresh()
  }, TRAY_REFRESH_MS)
  // 定时器不应单独拖住事件循环：退出时 stopAll 会负责清理。
  trayTimer.unref()
}

function stopTray(): void {
  if (trayTimer !== null) {
    clearInterval(trayTimer)
    trayTimer = null
  }
  trayController?.dispose()
  trayController = null
}

const SHOT_SETTLE_MS = 500
/** 至少 1% 的像素不同于背景，避免「一个杂点」也算渲染成功。 */
const SHOT_MIN_RATIO = 0.01
/**
 * 状态卡主按钮必须真的画出来。DESIGN.md 的 One Solid Blue Rule 规定实心主操作用
 * 填充蓝 `--accent-strong`，但线蓝 `--accent` 也可能出现在图标与激活态，两者都认，
 * 免得设计系统一改颜色冒烟就误报（容差 24 覆盖不到两种蓝之间的差值，所以列两项）。
 */
const SHOT_ACCENTS = [
  { r: 0x2f, g: 0x6f, b: 0xe0 }, // --accent-strong
  { r: 0x4a, g: 0x8c, b: 0xff } // --accent
] as const
const SHOT_ACCENT_TOLERANCE = 24
const SHOT_MIN_ACCENT_PIXELS = 10

function shotOutputFile(): string {
  return (
    process.env['AETHER_SHOT_OUTPUT'] ??
    path.resolve(__dirname, '../../docs/design/mockups/app-smoke.png')
  )
}

/**
 * 截图并做空白判定：`capturePage()` 在窗口没画出来时会给出空图、纯色图，
 * 或只画出一两个杂点的近似空白图，三者都必须算失败，否则脚本会把「白屏」
 * 当成通过。`toBitmap()` 是 BGRA，每 4 字节一个像素；逐像素比较而不是逐字节，
 * 否则同一个像素内部的 B/G/R 差异会被误当成「非空白」。
 * 另外在中心区域找主按钮的强调色，确认状态卡真的渲染出来了；只用粗粒度的
 * 中央条带，不绑定具体坐标，布局微调不会误报。
 */
async function captureShot(win: BrowserWindow): Promise<void> {
  const image = await win.webContents.capturePage()
  if (image.isEmpty()) throw new Error('截图内容为空')
  const bitmap = image.toBitmap()
  const size = image.getSize()
  const pixelCount = Math.floor(bitmap.length / 4)
  if (pixelCount === 0 || size.width === 0 || size.height === 0) {
    throw new Error('截图没有像素数据')
  }
  // 防御性裁剪：位图长度与窗口尺寸不一致时不要把越界当成失败。
  const width = Math.min(size.width, Math.floor(pixelCount / size.height))
  if (width === 0) throw new Error('截图没有像素数据')
  const height = Math.min(size.height, Math.floor(pixelCount / width))

  const first = bitmap.readUInt32LE(0)
  let different = 0
  for (let offset = 4; offset + 3 < bitmap.length; offset += 4) {
    if (bitmap.readUInt32LE(offset) !== first) different += 1
  }
  if (different === 0) throw new Error('截图是纯色，判定为空白')

  const ratio = different / pixelCount
  if (ratio <= SHOT_MIN_RATIO) {
    throw new Error(`截图有效像素只有 ${(ratio * 100).toFixed(2)}%，判定为空白`)
  }

  const left = Math.floor(width * 0.3)
  const right = Math.floor(width * 0.7)
  const top = Math.floor(height * 0.25)
  const bottom = Math.floor(height * 0.75)
  let accent = 0
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const offset = (y * width + x) * 4
      const b = bitmap.readUInt8(offset)
      const g = bitmap.readUInt8(offset + 1)
      const r = bitmap.readUInt8(offset + 2)
      if (
        SHOT_ACCENTS.some(
          (accent) =>
            Math.abs(b - accent.b) <= SHOT_ACCENT_TOLERANCE &&
            Math.abs(g - accent.g) <= SHOT_ACCENT_TOLERANCE &&
            Math.abs(r - accent.r) <= SHOT_ACCENT_TOLERANCE
        )
      ) {
        accent += 1
      }
    }
  }
  if (accent < SHOT_MIN_ACCENT_PIXELS) {
    throw new Error('截图中心区域没有主按钮强调色，界面可能未渲染')
  }

  const target = shotOutputFile()
  await mkdir(path.dirname(target), { recursive: true })
  const png = image.toPNG()
  await writeFile(target, png)
  console.log(
    `[aether] 截图 ${target} ${width}x${height} ${png.length} bytes 非空像素 ${(ratio * 100).toFixed(2)}% 强调色 ${accent} px`
  )
}

/**
 * 截图冒烟的失败路径也必须走退出清理：直接 `app.exit(1)` 会跳过 before-quit 里的
 * stopAll，内核不会被终止、系统代理也不会还原——这是项目的硬要求。
 * 不要把这里「简化」回 `app.exit(1)`。
 */
async function failShot(message: string, error?: unknown): Promise<void> {
  if (error === undefined) console.error(message)
  else console.error(message, error)
  try {
    await context?.stopAll()
  } catch (cleanupError) {
    console.error('[aether] 截图冒烟失败后的退出清理出错', cleanupError)
  } finally {
    app.exit(1)
  }
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
  // 连接与日志采集器即使窗口销毁也继续跑（见下面的 closed 处理），重建窗口时
  // 同样只替换回调，缓冲因此不会丢。
  context?.stats?.start(pushStats)
  context?.connections?.start(pushConnections)
  context?.logs?.start(pushLogCounts)

  win.once('closed', () => {
    if (mainWindow === win) mainWindow = null
    // 没有窗口就没有消费者，继续每 2 秒重连只会拖住事件循环。
    // 退出路径由 stopAll 兜底，这里覆盖「窗口没了但进程还在」。
    context?.stats?.stop()
    // connections / logs 刻意不在这里停：已结束连接要保留 60 秒，
    // 窗口重建后 connectionsGet 必须拿到完整首屏（账本 Ruling）。
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']

  if (shotMode) {
    // 加载完成后留一点时间让 React 首次渲染并完成布局，再截图。
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        void captureShot(win)
          .then(() => { app.quit() })
          .catch((err: unknown) => failShot('[aether] 截图冒烟失败', err))
      }, SHOT_SETTLE_MS)
    })
    win.webContents.once('did-fail-load', (_event, code, description) => {
      void failShot(`[aether] 截图冒烟加载失败 ${code} ${description}`)
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
      onStatsSample: pushStats,
      onConnectionsSnapshot: pushConnections,
      onLogCounts: pushLogCounts,
      // 首次启动期间退出时，context 还不存在；靠它叫停在途的校验与 spawn。
      signal: startAbort.signal
    })
    // 启动途中已经被取消：不要再建窗口，直接把清理走完退出。
    if (startAbort.signal.aborted) {
      app.quit()
      return
    }
    registerIpcHandlers(ipcMain, context, {
      settingsFile: path.join(userDataDir, 'settings.json'),
      pickImportFile,
      // 目标目录由 IPC 层用 ctx.configDir 给出，渲染层无法指定路径。
      openPath: (target) => shell.openPath(target)
    })
    // 托盘必须在窗口之前建：窗口没起来时它就是唯一能打开主窗口的入口。
    // 图标/原生托盘失败不得阻断启动：窗口仍要出现，用户至少能看状态。
    try {
      startTray(context, path.join(userDataDir, 'settings.json'))
    } catch (trayError) {
      console.error('[aether] 托盘初始化失败', trayError)
      stopTray()
    }
    createWindow(context.startupStatus)
  } catch (err) {
    // 装配层意外失败时仍要开窗，让用户能看到状态而不是应用无声退出。
    console.error('[aether] bootstrap 失败', err)
    // 通道也要注册：否则渲染层的 getStatus 直接 reject，状态页无法显示。
    registerUnavailableHandlers(ipcMain)
    createWindow('core-error')
  } finally {
    // 取消信号与清理都靠这个标志判断「启动流程已经不会再 spawn 内核了」。
    startSettled = true
  }
}

app.whenReady().then(() => { void start() })

app.on('before-quit', (event) => {
  // 清理已结束：放行最终这一次 quit（由下面的 finally 主动触发）。
  if (cleanupDone) return
  // context 还没建好也必须挡：首次 bootstrap 可能已经在跑 `mihomo -t` 或 spawn 内核，
  // 直接放行就会留下孤儿内核。先取消启动，再等 context 建好后正常清理。
  event.preventDefault()
  if (quitting) return
  quitting = true
  // 托盘先拆：图标不该在清理期间继续接受点击（「退出」会再次触发 quit，
  // 「系统代理」会在 stopAll 还原之后又被点开）。
  stopTray()
  startAbort.abort()
  const cleanup = async (): Promise<void> => {
    // 在途 bootstrap 会看到取消信号并在下一个 await 边界放弃；等它返回再清理，
    // 这样即使它已经 spawn 过内核，也能通过 stopAll 收掉。
    while (context === null && !startSettled) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    await context?.stopAll().catch((err) => { console.error('[aether] 退出清理失败', err) })
  }
  void cleanup().finally(() => {
    cleanupDone = true
    app.quit()
  })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
