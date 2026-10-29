import type { SimpleResult, WindowAction } from '../../shared/ipc'

/**
 * 主窗口的生命周期模型。
 *
 * 任务规格的核心是「常驻代理」：关窗只是销毁窗口，代理、内核、采集器都继续跑；
 * 从托盘再打开时重建窗口并恢复上次的位置。这里把这段逻辑从 `index.ts` 里抽出来，
 * 做成不依赖 Electron 的纯模型，才有办法在 Vitest 里覆盖（测试环境没有 Electron）。
 *
 * 真正碰 `BrowserWindow` 的只有 `create` 与 `ManagedWindow` 接口——
 * 由 `index.ts` 注入，是唯一未被单测覆盖的一段。
 */

export interface WindowRect {
  x: number
  y: number
  width: number
  height: number
}

/** 标题栏高度：与 DESIGN.md 的 40px 标题栏、`--titlebar-height` 一致。 */
export const TITLE_BAR_HEIGHT = 40
/** 窗口最小尺寸：重开窗口同样生效，不能因为恢复了一条旧记录就比最小尺寸更小。 */
export const MIN_WINDOW_SIZE = { width: 1024, height: 640 } as const
/** 首次启动（或记录不可用）时的默认尺寸。 */
export const DEFAULT_WINDOW_SIZE = { width: 1280, height: 800 } as const
/** 窗口至少要有这么多像素落在某块屏幕上，否则用户既看不见也够不着。 */export const MIN_VISIBLE_EDGE = 64
/**
 * 标题栏至少要露出这么高。窗口主体（大卡片区）再可见也没用：没有标题栏就拖不动，
 * 而 40px 的标题栏只剩十几像素时仍然抓得住。
 */
export const MIN_TITLE_BAR_VISIBLE = 16

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * 形状校验。只回答「这是不是一个窗口矩形」，不判断它落在哪块屏幕上——
 * 后者需要显示器信息，由 `resolveWindowBounds` 负责。
 * settings.json 是用户可编辑的本地文件，读进来的东西一律当作不可信输入。
 */
export function isWindowRect(value: unknown): value is WindowRect {
  if (typeof value !== 'object' || value === null) return false
  const { x, y, width, height } = value as Record<string, unknown>
  return (
    isFiniteNumber(x) &&
    isFiniteNumber(y) &&
    isFiniteNumber(width) &&
    isFiniteNumber(height) &&
    width > 0 &&
    height > 0
  )
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.min(Math.max(value, min), max)
}

/** 两个区间 [a1,a2) 与 [b1,b2) 的重叠长度；不相交为 0。 */
function overlap(a1: number, a2: number, b1: number, b2: number): number {
  return Math.max(0, Math.min(a2, b2) - Math.max(a1, b1))
}

interface DisplayLike {
  workArea: WindowRect
}

/**
 * 选一块能承载这个窗口的屏幕，并把尺寸夹到合法范围内。
 *
 * 两条判据必须同时成立：
 * 1. 窗口本体与工作区有足够大的交集（至少 64px×64px）——证明它确实在这块屏上；
 * 2. 窗口顶部 40px 的标题栏在那块屏上露出的部分足够抓取。
 *
 * 第 2 条是「显示器被拔掉」之外的另一类事故：窗口被存到了屏幕正上方，
 * 主体可见、标题栏整条在屏幕外，用户拖不动也关不掉。只在第 1 条上判断会漏掉它。
 */
function bestDisplay(rect: WindowRect, displays: readonly DisplayLike[]): DisplayLike | null {
  const titleRect: WindowRect = {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: Math.min(rect.height, TITLE_BAR_HEIGHT)
  }
  let best: DisplayLike | null = null
  let bestArea = 0
  for (const display of displays) {
    const area = display.workArea
    const bodyWidth = overlap(rect.x, rect.x + rect.width, area.x, area.x + area.width)
    const bodyHeight = overlap(rect.y, rect.y + rect.height, area.y, area.y + area.height)
    if (bodyWidth < MIN_VISIBLE_EDGE || bodyHeight < MIN_VISIBLE_EDGE) continue
    const titleWidth = overlap(titleRect.x, titleRect.x + titleRect.width, area.x, area.x + area.width)
    const titleHeight = overlap(
      titleRect.y,
      titleRect.y + titleRect.height,
      area.y,
      area.y + area.height
    )
    if (titleWidth < MIN_VISIBLE_EDGE || titleHeight < MIN_TITLE_BAR_VISIBLE) continue
    const visible = bodyWidth * bodyHeight
    if (visible > bestArea) {
      best = display
      bestArea = visible
    }
  }
  return best
}

/**
 * 把持久化的 `windowBounds` 归一成可以直接交给 `BrowserWindow` 的矩形。
 * 返回 `null` 表示这条记录不可用，调用方必须回落到居中默认尺寸——**绝不能**
 * 照原样恢复，否则用户会得到一个在屏幕外的窗口，而且没有任何入口能把它拉回来。
 *
 * 尺寸在这里一并夹紧：小于最小尺寸的旧记录被抬到最小尺寸，超出工作区的被压回工作区。
 */
export function resolveWindowBounds(
  value: unknown,
  displays: readonly DisplayLike[]
): WindowRect | null {
  if (!isWindowRect(value)) return null
  if (displays.length === 0) return null
  const display = bestDisplay(value, displays)
  if (display === null) return null
  const area = display.workArea
  return {
    x: Math.round(value.x),
    y: Math.round(value.y),
    width: Math.round(clamp(value.width, MIN_WINDOW_SIZE.width, area.width)),
    height: Math.round(clamp(value.height, MIN_WINDOW_SIZE.height, area.height))
  }
}

/** 首次启动（或记录不可用）时的居中默认矩形；工作区比默认尺寸小时按工作区收缩。 */
export function defaultWindowRect(displays: readonly DisplayLike[]): WindowRect {
  const area = displays[0]?.workArea
  if (area === undefined) {
    return { x: 0, y: 0, width: DEFAULT_WINDOW_SIZE.width, height: DEFAULT_WINDOW_SIZE.height }
  }
  const width = Math.min(DEFAULT_WINDOW_SIZE.width, area.width)
  const height = Math.min(DEFAULT_WINDOW_SIZE.height, area.height)
  return {
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
    width,
    height
  }
}

/**
 * 关窗时是否要把它改成「销毁」。真正的退出（`before-quit` 已置位 `quitting`）必须
 * 放行正常关闭，否则 Electron 会在关闭窗口这一步被永远挡住，进程退不出去。
 */
export function destroyOnClose(quitting: boolean): boolean {
  return !quitting
}

/**
 * `windowControls` 通道允许的动作。白名单而不是把字符串透传给主进程：
 * 通道只接受这三种值，别的一律 `{ ok: false }`。
 * 动作名与 `src/shared/ipc.ts` 的 `WindowAction` 是同一份定义，这边只做运行期校验。
 */
export const WINDOW_ACTIONS = ['minimize', 'maximize', 'close'] as const

export function isWindowAction(value: unknown): value is WindowAction {
  return typeof value === 'string' && (WINDOW_ACTIONS as readonly string[]).includes(value)
}

/** 窗口控制的最小接口；`WindowManager` 与测试替身都实现它。 */
export interface WindowControls {
  minimize(): void
  toggleMaximize(): void
  close(): void
}

/**
 * 执行一个窗控动作。
 *
 * 只读取第一个参数：渲染层多塞进来的任何东西（路径、坐标、任意对象）都不会被使用，
 * 也不存在「顺手把参数转给某个系统调用」的路径。未知动作返回 `{ ok: false }`，
 * 主进程不会因此抛错，渲染层也拿不到任何内部信息。
 */
export function runWindowAction(controls: WindowControls, action: unknown): SimpleResult {
  if (!isWindowAction(action)) return { ok: false }
  if (action === 'minimize') controls.minimize()
  else if (action === 'maximize') controls.toggleMaximize()
  else controls.close()
  return { ok: true }
}

/**
 * `BrowserWindow` 里窗口管理器用到的部分。只声明用得到的成员，测试替身因此可以很小。
 */
export interface ManagedWindow {
  isDestroyed(): boolean
  isMinimized(): boolean
  isVisible(): boolean
  isMaximized(): boolean
  restore(): void
  show(): void
  focus(): void
  destroy(): void
  close(): void
  minimize(): void
  maximize(): void
  unmaximize(): void
  getBounds(): WindowRect
  /** 最大化状态下返回「还原后」的矩形；持久化窗口位置必须用它，不能用 getBounds。 */
  getNormalBounds(): WindowRect
}

export interface WindowManagerDeps<W extends ManagedWindow> {
  /** 真正创建窗口；`bounds` 已经过校验，可以直接交给 `BrowserWindow`。 */
  create(bounds: WindowRect): W
  /** 读 `settings.json` 里的 `windowBounds`；值是不可信输入，失败也要能开窗。 */
  loadBounds(): Promise<unknown>
  saveBounds(bounds: WindowRect): Promise<void>
  displays(): readonly DisplayLike[]
  onError?(error: unknown): void
}

export interface WindowManager<W extends ManagedWindow> extends WindowControls {
  /** 窗口在就聚焦，销毁了就按上次的位置重建；并发调用只会创建一个窗口。 */
  show(): Promise<void>
  current(): W | null
  /** 窗口销毁时调用，清掉引用；只清被销毁的那一个。 */
  forget(win: W): void
  isMaximized(): boolean
  /**
   * 把当前几何写回 `settings.json`。窗口被移动/缩放时与关窗前各调一次。
   *
   * 用户没有动过窗口时保存的是**当初申请**的矩形，而不是 Electron 回报的矩形：
   * 无边框窗口每重建一次，回报的 bounds 会比申请的宽/高多出几像素（实测 1.25 倍
   * DPI 下每次 +1~6px，来源是隐藏的调整边框）。照回报值存会让窗口每次启动都长大一点，
   * 几十次之后就没法用了。
   */
  persistCurrent(): Promise<void>
}

function roundRect(rect: WindowRect): WindowRect {
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  }
}

/**
 * 窗口只有一个，生命周期也只有一条：
 *
 * ```
 * show() ──窗口不在──> 读记录 → 校验 → create(bounds) → 记下 baseline
 *    └────窗口在────> restore/show/focus
 * close(IPC) ──> win.close() ──> index.ts 的 close 处理器 preventDefault + destroy
 * destroy ──> closed 事件 ──> forget() ──> 下一个 show() 会重建
 * ```
 *
 * 创建是异步的（读 settings.json 要等 IO），所以必须用 `creating` 挡住并发：
 * 托盘图标双击会连发两次「打开主窗口」，没有这道闸就会建出两个窗口。
 */
export function createWindowManager<W extends ManagedWindow>(
  deps: WindowManagerDeps<W>
): WindowManager<W> {
  let current: W | null = null
  let creating: Promise<void> | null = null
  /**
   * 创建窗口时「申请的矩形」与「Electron 回报的矩形」之间的差。
   *
   * 无边框窗口的 `BrowserWindow` 会在外圈保留一圈不可见的调整边框：申请 1280×800，
   * `getBounds()` 回报 1282×802（1.25 倍 DPI 下实测每次多 1~6px）。若把这个回报值
   * 原样存进 settings.json，下次再拿它当申请值，回报值就会再大一圈——窗口每开一次
   * 长几像素，几十次后就没法用了。存盘时减去这份常量差值，等同于永远存回「申请的」
   * 矩形，用户拖动/缩放后再叠加真实位移，因此不会累积。
   */
  let frameInset: WindowRect | null = null

  function alive(win: W | null): win is W {
    return win !== null && !win.isDestroyed()
  }

  function focusExisting(win: W): void {
    if (win.isMinimized()) win.restore()
    if (!win.isVisible()) win.show()
    win.focus()
  }

  async function readSavedBounds(): Promise<unknown> {
    try {
      return await deps.loadBounds()
    } catch (error) {
      // 记录损坏/读不出来都不能阻断开窗：应用没有窗口比丢失位置严重得多。
      deps.onError?.(error)
      return null
    }
  }

  async function open(): Promise<void> {
    const saved = await readSavedBounds()
    const displays = deps.displays()
    const rect = resolveWindowBounds(saved, displays) ?? defaultWindowRect(displays)
    const win = deps.create(rect)
    current = win
    if (!win.isDestroyed()) {
      const reported = win.getNormalBounds()
      frameInset = {
        x: reported.x - rect.x,
        y: reported.y - rect.y,
        width: reported.width - rect.width,
        height: reported.height - rect.height
      }
    } else {
      frameInset = null
    }
  }

  async function show(): Promise<void> {
    if (alive(current)) {
      focusExisting(current)
      return
    }
    // 创建在途：等它，而不是再建一个。等完之后统一聚焦一次。
    if (creating === null) {
      creating = open().finally(() => {
        creating = null
      })
    }
    await creating
    if (alive(current)) focusExisting(current)
  }

  function forget(win: W): void {
    if (current !== win) return
    current = null
    frameInset = null
  }

  function minimize(): void {
    if (alive(current)) current.minimize()
  }

  function toggleMaximize(): void {
    if (!alive(current)) return
    if (current.isMaximized()) current.unmaximize()
    else current.maximize()
  }

  function close(): void {
    // 只是请求关闭；真正的「关闭即销毁」在 index.ts 的 close 处理器里。
    if (alive(current)) current.close()
  }

  function isMaximized(): boolean {
    return alive(current) && current.isMaximized()
  }

  async function persistCurrent(): Promise<void> {
    const win = current
    if (!alive(win) || frameInset === null) return
    // 最大化时 getBounds 是整块屏幕，存的是还原后的矩形。
    const reported = roundRect(win.getNormalBounds())
    const rect: WindowRect = {
      x: reported.x - frameInset.x,
      y: reported.y - frameInset.y,
      width: reported.width - frameInset.width,
      height: reported.height - frameInset.height
    }
    try {
      await deps.saveBounds(rect)
    } catch (error) {
      deps.onError?.(error)
    }
  }

  return {
    show,
    current: () => (alive(current) ? current : null),
    forget,
    minimize,
    toggleMaximize,
    close,
    isMaximized,
    persistCurrent
  }
}
