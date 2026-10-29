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

export interface Settings {
  proxyEnabled: boolean
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
    const windowBounds = parseWindowBounds(parsed.windowBounds)
    if (windowBounds !== null) settings.windowBounds = windowBounds
    return settings
  } catch {
    return { ...DEFAULTS }
  }
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

