import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from './config/atomic'

/**
 * 保存窗口位置与尺寸。字段名与 `BrowserWindow` 的构造函数参数一致，读出来可以直接展开。
 * 数值可能是用户手改的，`shell/window.ts` 会逐字段校验，这里只负责往返。
 */
export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 开机自启的默认值：**启用**。
 *
 * 系统代理是持久设置：用户开着代理关机，重启后若 Aether 没有自启，注册表仍指向
 * 一个没人监听的端口，所有遵守系统代理的应用都会断网。自启在这里是安全网，
 * 不是便利功能（产品设计 D31 / 规格 app-lifecycle「开机自启」）。
 */
export const DEFAULT_AUTOSTART = true

export interface Settings {
  proxyEnabled: boolean
  /**
   * 开机自启的持久化意向。**缺省表示从未显式设置过**，调用方按 `DEFAULT_AUTOSTART`
   * 理解；这样旧版本写下的 `{ proxyEnabled: false }` 读出来是「默认启用」而不是
   * 「用户关掉了」。`writeAutostart` 一旦写过，这个键就固定下来。
   */
  autostart?: boolean
  /** 主窗口上次的位置与尺寸；没有记录时缺省。 */
  windowBounds?: WindowBounds
}

const DEFAULTS: Settings = { proxyEnabled: false }

/** 只认四个数字字段都在的对象；形状不对当没存过，交给窗口层回落到居中默认。 */
function parseWindowBounds(value: unknown): WindowBounds | null {
  if (typeof value !== 'object' || value === null) return null
  const { x, y, width, height } = value as Record<string, unknown>
  for (const field of [x, y, width, height]) {
    if (typeof field !== 'number' || !Number.isFinite(field)) return null
  }
  return { x: x as number, y: y as number, width: width as number, height: height as number }
}

export async function readSettings(file: string): Promise<Settings> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<Settings>
    const settings: Settings = { proxyEnabled: parsed.proxyEnabled === true }
    // 只有明确的布尔值才算「用户设置过」；缺键、`null`、字符串一律按默认启用，
    // 由调用方用 `resolveAutostart` 统一解释。写回时也只认布尔值，避免把畸形值固化。
    if (typeof parsed.autostart === 'boolean') settings.autostart = parsed.autostart
    const windowBounds = parseWindowBounds(parsed.windowBounds)
    if (windowBounds !== null) settings.windowBounds = windowBounds
    return settings
  } catch {
    return { ...DEFAULTS }
  }
}

/** 持久化意向 → 生效值。缺键（从未设置过）按 `DEFAULT_AUTOSTART`。 */
export function resolveAutostart(settings: Pick<Settings, 'autostart'>): boolean {
  return settings.autostart ?? DEFAULT_AUTOSTART
}

/**
 * 整份写入。注意 `Settings` 现在是**可选字段**的合并语义：调用方只传
 * `{ proxyEnabled }` 时，已有的 `windowBounds` 会被一起丢掉。
 *
 * 因此这里的写入采用「先读后合并」：磁盘上已存在且本次没有显式给出的字段原样保留。
 * 代理开关与窗口位置由两条互不相干的路径写入（IPC / 托盘 vs 窗口事件），
 * 谁晚写谁就把对方抹掉，是这类「整份 JSON 覆盖」最常见的丢数据方式。
 */
export async function writeSettings(file: string, settings: Settings): Promise<void> {
  const previous = await readSettings(file)
  const merged: Settings = {
    proxyEnabled: settings.proxyEnabled,
    ...(previous.autostart !== undefined ? { autostart: previous.autostart } : {}),
    ...(settings.autostart !== undefined ? { autostart: settings.autostart } : {}),
    ...(previous.windowBounds !== undefined ? { windowBounds: previous.windowBounds } : {}),
    ...(settings.windowBounds !== undefined ? { windowBounds: settings.windowBounds } : {})
  }
  await writeFileAtomic(file, JSON.stringify(merged, null, 2))
}

/**
 * 只更新窗口位置，不动 `proxyEnabled`。
 *
 * 窗口几何与代理开关是两条独立的写入路径，各自只需要自己的字段；给窗口写位置时
 * 硬要凑一个 `proxyEnabled` 进来，就得先读一次再猜——猜错了等于把用户的代理偏好改掉。
 */
export async function writeWindowBounds(file: string, windowBounds: WindowBounds): Promise<void> {
  const previous = await readSettings(file)
  await writeFileAtomic(
    file,
    JSON.stringify({ ...previous, windowBounds } satisfies Settings, null, 2)
  )
}

/**
 * 只更新开机自启，不动 `proxyEnabled` / `windowBounds`。
 *
 * 与 `writeWindowBounds` 同一个理由：自启开关是第三条独立写入路径（设置页），
 * 给出一条只写自己字段的窄接口，就不必先猜 `proxyEnabled` 再整份覆盖。
 */
export async function writeAutostart(file: string, autostart: boolean): Promise<void> {
  const previous = await readSettings(file)
  await writeFileAtomic(file, JSON.stringify({ ...previous, autostart } satisfies Settings, null, 2))
}

