import {
  DEFAULT_AUTOSTART,
  readSettings,
  resolveAutostart,
  writeAutostart
} from '../settings'
import { autostartCopy } from './copy'

/**
 * 开机自启的模型层。
 *
 * 与 `tray.ts` / `window.ts` 同一形状：**纯模型 + 薄适配器**。真正碰 Electron 的只有
 * `AutostartHost`（`app.setLoginItemSettings` / `app.getLoginItemSettings`），由
 * `src/main/index.ts` 注入；Vitest 里没有 Electron，注入假体即可覆盖全部判定。
 *
 * 三条硬规则，全部在这个文件里落地：
 * 1. **默认启用**：`settings.json` 里没有 `autostart` 键的旧文件读出来是「启用」，
 *    不是「用户关掉了」。
 * 2. **以系统实际状态为准**：打包态读 `getLoginItemSettings().openAtLogin`，与持久化
 *    意向不一致时界面显示的是系统值，并明确告诉用户两者不一致。
 * 3. **诚实优先**：`setLoginItemSettings` 抛错、或写入后回读没有反映改动，都算失败，
 *    开关必须回到真实状态并给出错误；绝不显示一个 Windows 上没有启动项的「已开启」。
 *
 * 开发态（`!isPackaged`）**不碰注册表**：往 `npm run dev` 的 Electron 路径写启动项会在
 * 用户机器上留下垃圾（账本 Ruling）。设置照常读写，界面如实标注「仅打包版生效」。
 */

/** Electron 适配器的最小接口；测试里用假体，生产实现见 `src/main/index.ts`。 */
export interface AutostartHost {
  /** 打包态才写系统启动项；开发态只持久化意向。 */
  readonly isPackaged: boolean
  /** `app.setLoginItemSettings({ openAtLogin, path })`。允许抛错。 */
  setLoginItem(openAtLogin: boolean): void
  /** `app.getLoginItemSettings().openAtLogin`。允许抛错。 */
  getLoginItem(): boolean
}

/** 跨进程的状态视图；`src/shared/ipc.ts` 里有同形状的对外类型。 */
export interface AutostartState {
  /**
   * 开关当前所在的位置。打包态 = 系统实际值；开发态 = 持久化意向。
   * 这是开关唯一允许显示的真相来源，不来自上一次点击。
   */
  enabled: boolean
  /** 持久化意向（键缺失时为默认启用）。 */
  persisted: boolean
  /** 本次构建能否真正注册系统启动项；false 时界面必须写「仅打包版生效」。 */
  appliesToSystem: boolean
  /** 系统实际值与持久化意向不一致：以系统为准。 */
  systemDiffers: boolean
  /**
   * 需要用户知道的一句话（读取失败、切换失败）。成功读取时缺省。
   * 失败路径也用它，界面上只有一条错误通道，不会出现两处互相矛盾的说法。
   */
  error?: string
}

export interface AutostartResult {
  ok: boolean
  /** 动作之后重新读到的状态；失败时开关按它回位。 */
  state: AutostartState
}

/** 持久化意向。`readSettings` 自己吞掉读文件错误并回默认值，这里不会再抛。 */
async function persistedIntent(file: string): Promise<boolean> {
  return resolveAutostart(await readSettings(file))
}

/**
 * 读当前状态。
 *
 * 打包态一律回读系统值；`getLoginItemSettings` 抛错时**不能**假装系统值等于持久化值
 * （那正是「显示已开启、Windows 上没有启动项」的说谎场景），而是回到持久化意向
 * 并在 `error` 里说明「显示的是上次保存的设置」。
 */
export async function readAutostart(host: AutostartHost, settingsFile: string): Promise<AutostartState> {
  const persisted = await persistedIntent(settingsFile)
  if (!host.isPackaged) {
    return { enabled: persisted, persisted, appliesToSystem: false, systemDiffers: false }
  }
  try {
    const system = host.getLoginItem()
    return {
      enabled: system,
      persisted,
      appliesToSystem: true,
      systemDiffers: system !== persisted
    }
  } catch {
    return {
      enabled: persisted,
      persisted,
      appliesToSystem: true,
      systemDiffers: false,
      error: autostartCopy.readFailed
    }
  }
}

/** 失败结果：状态重新读、错误附在状态上，开关据此回位。 */
async function fail(host: AutostartHost, settingsFile: string, message: string): Promise<AutostartResult> {
  const state = await readAutostart(host, settingsFile)
  return { ok: false, state: { ...state, error: message } }
}

/**
 * 切换自启。
 *
 * 打包态的判定顺序不是可选的：
 * 1. 写系统启动项（可能抛错）；
 * 2. **回读** `getLoginItemSettings().openAtLogin`——`setLoginItemSettings` 不抛错
 *    也可能没生效（组策略、杀软、权限）；
 * 3. 只有回读值等于目标值才落盘持久化意向。
 *
 * 任何一步不成立都返回 `ok: false`，`state.enabled` 是重新读到的真实状态。
 */
export async function setAutostart(
  host: AutostartHost,
  settingsFile: string,
  enabled: boolean
): Promise<AutostartResult> {
  if (!host.isPackaged) {
    // 开发态：只写设置文件，绝不注册启动项。
    try {
      await writeAutostart(settingsFile, enabled)
    } catch {
      return fail(host, settingsFile, autostartCopy.saveFailed)
    }
    return { ok: true, state: await readAutostart(host, settingsFile) }
  }

  try {
    host.setLoginItem(enabled)
  } catch {
    return fail(host, settingsFile, autostartCopy.systemFailed)
  }

  let actual: boolean
  try {
    actual = host.getLoginItem()
  } catch {
    return fail(host, settingsFile, autostartCopy.verifyFailed)
  }
  if (actual !== enabled) {
    return fail(host, settingsFile, autostartCopy.notApplied)
  }

  try {
    await writeAutostart(settingsFile, enabled)
  } catch {
    // 系统已经改了、设置没保存：如实说，界面会显示两者不一致。
    return fail(host, settingsFile, autostartCopy.saveFailed)
  }
  return { ok: true, state: await readAutostart(host, settingsFile) }
}

export type StartupAutostartOutcome = 'registered' | 'skipped' | 'failed'

/**
 * 启动时的一次性注册。**只在设置文件里从未写过 `autostart` 时执行**（首次安装）。
 *
 * 为什么不是无条件按持久化值同步：用户可能从任务管理器里删掉了启动项，规格要求
 * 「以系统实际为准并提示」。若每次启动都按意向重注册，这条提示永远不会出现，
 * 用户也永远删不掉启动项。因此只有「从未表达过偏好」的首次运行才按默认启用注册；
 * 显式关过（键为 false）或显式开过（键为 true）都一律留给用户自己决定。
 *
 * 开发态直接跳过：不碰注册表。
 */
export async function ensureAutostartAtStartup(
  host: AutostartHost,
  settingsFile: string
): Promise<StartupAutostartOutcome> {
  if (!host.isPackaged) return 'skipped'
  let written: boolean | undefined
  try {
    written = (await readSettings(settingsFile)).autostart
  } catch {
    return 'failed'
  }
  if (written !== undefined) return 'skipped'
  if (DEFAULT_AUTOSTART !== true) return 'skipped'
  try {
    host.setLoginItem(true)
    if (!host.getLoginItem()) return 'failed'
    await writeAutostart(settingsFile, true)
    return 'registered'
  } catch {
    return 'failed'
  }
}
