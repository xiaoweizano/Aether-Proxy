import { mkdir } from 'node:fs/promises'
import type { Mode } from '../shared/types'
import { IPC } from '../shared/ipc'
import type {
  AppStatusView,
  AutostartSetResult,
  AutostartStateView,
  ConnectionsSnapshot,
  DialFailureCounts,
  ImportApplied,
  ImportResult,
  ModeSetResult,
  NodeSwitchInput,
  NodeSwitchResult,
  LogsSnapshot,
  PickImportResult,
  ProxyGroupView,
  SimpleResult,
  StatsSample,
  UrlImportResult,
  WindowStateView
} from '../shared/ipc'
import type { ProxiesResponse } from './core/link'
import type { AppContext } from './bootstrap'
import { importFromFile, importFromUrl } from './config/import'
import { writeSettings } from './settings'
import { readAutostart, setAutostart, type AutostartHost } from './shell/autostart'
import { isWindowAction, runWindowAction, type WindowControls } from './shell/window'

/** 只依赖 Electron IpcMain 的 handle 形状，避免测试环境加载 electron 模块。 */
export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): void
}

export interface IpcDeps {
  settingsFile: string
  /**
   * 打开原生文件选择框，返回选中的路径；`null` 表示用户取消。
   * 以函数注入而不是直接 import electron：测试环境不加载 Electron，
   * 同时也把「渲染层从不出路径」约束在单一边界上。
   */
  pickImportFile?: () => Promise<string | null>
  /**
   * 打开一个目录（生产环境是 `shell.openPath`）。与 Electron 契约一致：
   * 成功返回空串，失败返回错误说明。目标路径由主进程给出，渲染层无法指定。
   */
  openPath?: (target: string) => Promise<string>
  /**
   * 窗控窗口。生产环境是 `WindowManager`；装配失败时缺省，通道仍注册但一律 `{ok:false}`，
   * 渲染层不会因为「No handler registered」把标题栏按钮变成抛错。
   */
  windowControls?: WindowControls
  /** 当前窗口的最大化状态；装配失败时缺省，首屏补拉会回「未最大化」。 */
  windowState?: () => WindowStateView
  /**
   * 开机自启的 Electron 适配器。缺省（装配失败、测试未注入）时通道仍注册，
   * 但读取回「不可用」，设置直接 `{ok:false}`——渲染层不会收到 "No handler"。
   */
  autostart?: AutostartHost
}

const MODES: readonly Mode[] = ['rule', 'global', 'direct']

function isMode(value: unknown): value is Mode {
  return typeof value === 'string' && (MODES as readonly string[]).includes(value)
}

/** 组名与节点名的长度上限：正常订阅里没有这么长的名字，超长只可能是畸形输入。 */
const MAX_PROXY_NAME_LENGTH = 256

/**
 * 节点切换入参校验：两个字段都必须是非空字符串（只有空白也算空）。
 * 返回原值而不是 trim 后的值，避免悄悄改掉合法的节点名。
 *
 * `.` 与 `..` 必须拒绝：`encodeURIComponent` 不会转义点号，拼进 `/proxies/..` 后
 * 会被 URL 规范化折叠成 `/`，请求打到 controller 根路径而不是换节点。
 */
function parseNodeSwitch(value: unknown): NodeSwitchInput | null {
  if (typeof value !== 'object' || value === null) return null
  const { group, node } = value as { group?: unknown; node?: unknown }
  if (typeof group !== 'string' || group.trim() === '') return null
  if (typeof node !== 'string' || node.trim() === '') return null
  if (group.length > MAX_PROXY_NAME_LENGTH || node.length > MAX_PROXY_NAME_LENGTH) return null
  if (group === '.' || group === '..') return null
  return { group, node }
}

/** 采集器不存在（内核未运行）时的空快照；内存与保留窗口未知保持 null，不能用 0 冒充。 */
function emptyConnectionsSnapshot(): ConnectionsSnapshot {
  return { items: [], memory: null, retainMs: null, at: Date.now() }
}

/** 错误对象可能带堆栈或路径；只把可读短消息交给渲染层。 */
function shortMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.slice(0, 300)
}

/** 从 `127.0.0.1:<mixedPort>` 取出端口；格式不符时返回 null。 */
function mixedPortOf(proxyServer: string | null): number | null {
  if (proxyServer === null) return null
  const match = /:(\d+)$/.exec(proxyServer)
  if (!match) return null
  const port = Number(match[1])
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null
}

/**
 * 状态视图逐字段构建，绝不展开 ctx：ctx 里有 secret 的邻居
 * （controller、ownership）和本地路径，展开即泄漏。
 *
 * `core.proxyPort` 是 mixed-port，不是 controller 端口：渲染层既不需要、
 * 也不允许知道 external-controller 的地址。
 */
export function buildStatusView(ctx: AppContext): AppStatusView {
  const view: AppStatusView = {
    status: ctx.startupStatus,
    restore: ctx.restore,
    mode: ctx.mode,
    proxyEnabled: ctx.proxyEnabled
  }
  const proxyPort = mixedPortOf(ctx.proxyServer)
  if (ctx.coreInfo !== null && proxyPort !== null) {
    view.core = {
      version: ctx.coreInfo.version,
      proxyPort,
      startedAt: ctx.coreInfo.startedAt
    }
  }
  if (ctx.profile !== null) {
    view.profile = { nodeCount: ctx.profile.nodeCount, groupCount: ctx.profile.groupCount }
  }
  return view
}

/**
 * 只把具备 `all` 的策略组暴露给界面；节点顺序沿用内核给的顺序，
 * 延迟取该节点最近一次测试结果。策略组自身的 history 是聚合值，不作为节点延迟显示。
 *
 * `fixed` 是自动组（URLTest 等）里的手动钉选：它对 `PUT /proxies/<group>` 的响应
 * 只改 `fixed` 不改 `now`。空串按「没有钉选」处理，避免界面把它画成一个叫空串的选中项。
 */
export function toProxyGroups(res: ProxiesResponse): ProxyGroupView[] {
  const out: ProxyGroupView[] = []
  for (const entry of Object.values(res.proxies)) {
    if (entry === null || typeof entry !== 'object' || !Array.isArray(entry.all)) continue
    const fixed = typeof entry.fixed === 'string' && entry.fixed !== '' ? entry.fixed : undefined
    const group: ProxyGroupView = {
      name: typeof entry.name === 'string' ? entry.name : '',
      type: typeof entry.type === 'string' ? entry.type : '',
      now: typeof entry.now === 'string' ? entry.now : '',
      nodes: entry.all.map((name) => {
        const node = res.proxies[name]
        if (node === undefined || Array.isArray(node.all)) return { name }
        const delay = node.history?.at(-1)?.delay
        return typeof delay === 'number' ? { name, delay } : { name }
      })
    }
    if (fixed !== undefined) group.fixed = fixed
    out.push(group)
  }
  return out
}

/**
 * bootstrap 本身抛出时（不该发生的装配失败）仍注册全部通道，否则渲染层每个调用
 * 都会收到 "No handler registered"，状态页连错误都显示不出来。
 * 不回显装配错误原文：那里可能拼进配置片段或路径。
 *
 * 窗控必须照常工作：窗口是 `frame: false`，没有系统标题栏，关不掉的窗口等于
 * 只能杀进程。因此这里接收真实的管理器，而不是一律回 `{ok:false}`。
 */
export function registerUnavailableHandlers(
  ipcMain: IpcMainLike,
  windowDeps: {
    windowControls?: WindowControls
    windowState?: () => WindowStateView
    autostart?: AutostartHost
  } = {}
): void {
  const message = '应用初始化失败，请查看日志后重启'
  ipcMain.handle(IPC.statusGet, (): AppStatusView => ({
    status: 'core-error',
    restore: 'none',
    mode: 'rule',
    proxyEnabled: false
  }))
  ipcMain.handle(IPC.proxiesGet, (): ProxyGroupView[] => [])
  ipcMain.handle(IPC.modeSet, (): ModeSetResult => ({ ok: false, status: 0 }))
  for (const channel of [IPC.proxyEnable, IPC.proxyDisable, IPC.coreRestart] as const) {
    ipcMain.handle(channel, (): SimpleResult => ({ ok: false, message }))
  }
  ipcMain.handle(IPC.configImport, (): ImportResult => ({ ok: false, message }))
  ipcMain.handle(IPC.configPickImport, (): PickImportResult => ({ ok: false, message }))
  ipcMain.handle(IPC.configUrlImport, (): UrlImportResult => ({ ok: false, message }))

  // 新增通道也必须在「装配失败」变体里存在：否则渲染层第一次调用就会收到
  // "No handler registered"，状态页连错误都显示不出来。
  ipcMain.handle(IPC.connectionsGet, (): ConnectionsSnapshot => emptyConnectionsSnapshot())
  ipcMain.handle(IPC.logsCountsGet, (): DialFailureCounts | null => null)
  ipcMain.handle(IPC.logsRecentGet, (): LogsSnapshot | null => null)
  // 采集器不存在：没有流量数据来源，首屏补拉回 null。
  ipcMain.handle(IPC.statsGet, (): StatsSample | null => null)
  ipcMain.handle(IPC.nodeSwitch, (): NodeSwitchResult => ({ ok: false, status: 0 }))
  ipcMain.handle(IPC.configOpenDir, (): SimpleResult => ({ ok: false, message }))
  // 推送通道是主进程单向发送；这里注册空 handler 只为让通道集合完整，
  // 渲染层误调用时得到 undefined 而不是 "No handler registered"。
  ipcMain.handle(IPC.connectionsPush, () => {})
  ipcMain.handle(IPC.logsCountsPush, () => {})
  // 装配失败时窗口仍然是无边框的：必须能关、能最小化，否则用户只能杀进程。
  ipcMain.handle(
    IPC.windowControl,
    async (_event, action: unknown): Promise<SimpleResult> => {
      if (!isWindowAction(action)) return { ok: false, message }
      if (windowDeps.windowControls === undefined) return { ok: false, message }
      return runWindowAction(windowDeps.windowControls, action)
    }
  )
  ipcMain.handle(
    IPC.windowStateGet,
    (): WindowStateView => windowDeps.windowState?.() ?? { maximized: false }
  )
  ipcMain.handle(IPC.windowStatePush, () => {})

  // 装配失败时自启仍可读（设置页不该变成死页），但从这里读不碰系统注册表：
  // 失败装配下应用状态本身不可信，宁可回「不可用」也不冒险改启动项。
  ipcMain.handle(IPC.autostartGet, (): AutostartStateView => unavailableAutostart())
  ipcMain.handle(IPC.autostartSet, (): AutostartSetResult => ({
    ok: false,
    state: unavailableAutostart()
  }))
}

/**
 * 自启适配器缺席时的状态。`appliesToSystem: false` 是事实——没有适配器就无法注册；
 * `error` 说明原因，界面不会画出一个看起来能用、点了却什么都没有的开关。
 */
function unavailableAutostart(): AutostartStateView {
  return {
    enabled: false,
    persisted: false,
    appliesToSystem: false,
    systemDiffers: false,
    error: '应用初始化失败，无法读取开机自启设置'
  }
}

/**
 * 订阅地址校验。URL 来自渲染层，所以**只放行 http/https**：
 * 否则 file://、data: 等协议会变成渲染层驱动主进程读任意本地文件或解析任意内容的通道。
 * 返回规范化后的 href，非 http(s) 一律 null。
 */
function parseSubscriptionUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  return parsed.href
}

type ImportOutcome =
  | { ok: true; applied: ImportApplied; message?: string }
  | { ok: false; message: string }

/**
 * 导入成功之后让新配置真正生效。
 *
 * 内核在跑就热重载：不停进程、不断系统代理，用户粘贴完订阅立刻能看到新节点。
 * 内核没在跑时「重启后生效」就是事实，不必尝试。
 *
 * **热重载失败不是导入失败**：配置已经落盘，界面要说的是「已导入、但内核没接受」
 * 并把原因带出去——只报「已导入」会让用户以为已经生效，那是最坏的一种结果。
 */
async function applyImported(ctx: AppContext): Promise<{ applied: ImportApplied; message?: string }> {
  if (ctx.startupStatus !== 'ready') return { applied: 'pending-restart' }
  try {
    await ctx.reloadCore()
    return { applied: 'reloaded' }
  } catch (err) {
    return { applied: 'reload-failed', message: shortMessage(err) }
  }
}

/** 两个导入通道共用的落盘步骤：目录按需创建，失败只回短消息。 */
async function importIntoConfigDir(ctx: AppContext, sourcePath: string): Promise<ImportOutcome> {
  try {
    // configDir 才是 upstream.yaml 的落点；no-config 时 profileDir 为 null。
    await mkdir(ctx.configDir, { recursive: true })
    await importFromFile(ctx.configDir, sourcePath)
  } catch (err) {
    return { ok: false, message: shortMessage(err) }
  }
  return { ok: true, ...(await applyImported(ctx)) }
}

export function registerIpcHandlers(ipcMain: IpcMainLike, ctx: AppContext, deps: IpcDeps): void {
  ipcMain.handle(IPC.statusGet, () => buildStatusView(ctx))

  ipcMain.handle(IPC.proxiesGet, async (): Promise<ProxyGroupView[]> => {
    if (ctx.link === null) return []
    try {
      return toProxyGroups(await ctx.link.proxies())
    } catch {
      // 内核暂时不可达时界面拿到空列表，健康度由 status 通道说明。
      return []
    }
  })

  ipcMain.handle(IPC.modeSet, async (_event, mode: unknown): Promise<ModeSetResult> => {
    if (!isMode(mode) || ctx.link === null) return { ok: false, status: 0 }
    const result = await ctx.link.setMode(mode)
    if (result.ok) ctx.setMode(mode)
    return result
  })

  ipcMain.handle(IPC.proxyEnable, async (): Promise<SimpleResult> => {
    if (ctx.proxyServer === null) {
      return { ok: false, message: '内核未运行，无法开启系统代理' }
    }
    try {
      await ctx.controller.enable(ctx.proxyServer)
    } catch (err) {
      return { ok: false, message: shortMessage(err) }
    }
    ctx.proxyEnabled = true
    try {
      await writeSettings(deps.settingsFile, { proxyEnabled: true })
    } catch (err) {
      return { ok: false, message: `系统代理已开启，但设置未能保存：${shortMessage(err)}` }
    }
    return { ok: true }
  })

  ipcMain.handle(IPC.proxyDisable, async (): Promise<SimpleResult> => {
    try {
      await ctx.controller.disable()
    } catch (err) {
      // 保持 proxyEnabled 为实际状态：还原失败时界面不能假装已关闭。
      return { ok: false, message: shortMessage(err) }
    }
    ctx.proxyEnabled = false
    try {
      await writeSettings(deps.settingsFile, { proxyEnabled: false })
    } catch (err) {
      return { ok: false, message: `系统代理已关闭，但设置未能保存：${shortMessage(err)}` }
    }
    return { ok: true }
  })

  ipcMain.handle(IPC.coreRestart, async (): Promise<SimpleResult> => {
    if (ctx.startupStatus === 'in-use') {
      return { ok: false, message: '另一个实例正在使用代理，无法重启内核' }
    }
    try {
      await ctx.restartCore()
      return { ok: true }
    } catch (err) {
      return { ok: false, message: shortMessage(err) }
    }
  })

  ipcMain.handle(IPC.configImport, async (_event, arg: unknown): Promise<ImportResult> => {
    // 另一个实例正在使用这份配置：改写 upstream.yaml 会破坏它的运行状态。
    if (ctx.startupStatus === 'in-use') {
      return { ok: false, message: '另一个实例正在运行' }
    }
    const sourcePath =
      typeof arg === 'object' && arg !== null && typeof (arg as { sourcePath?: unknown }).sourcePath === 'string'
        ? (arg as { sourcePath: string }).sourcePath
        : null
    if (sourcePath === null) return { ok: false, message: '缺少配置路径' }
    return importIntoConfigDir(ctx, sourcePath)
  })

  ipcMain.handle(IPC.configPickImport, async (): Promise<PickImportResult> => {
    // 与 configImport 同一道闸：另一个实例占用配置时不能改写 upstream.yaml。
    // 先拒绝再弹框，用户不会为一个注定失败的导入白选文件。
    if (ctx.startupStatus === 'in-use') {
      return { ok: false, message: '另一个实例正在运行' }
    }
    if (deps.pickImportFile === undefined) {
      return { ok: false, message: '无法打开文件选择框' }
    }
    let sourcePath: string | null
    try {
      sourcePath = await deps.pickImportFile()
    } catch (err) {
      return { ok: false, message: shortMessage(err) }
    }
    if (sourcePath === null) return { ok: false, cancelled: true }
    return importIntoConfigDir(ctx, sourcePath)
  })

  ipcMain.handle(
    IPC.configUrlImport,
    async (_event, rawUrl: unknown): Promise<UrlImportResult> => {
      // 与文件导入同一道闸：另一个实例占用配置时不能改写 upstream.yaml。
      if (ctx.startupStatus === 'in-use') {
        return { ok: false, message: '另一个实例正在运行' }
      }
      const url = parseSubscriptionUrl(rawUrl)
      if (url === null) return { ok: false, message: '订阅地址无效：只支持 http / https' }
      try {
        await mkdir(ctx.configDir, { recursive: true })
        await importFromUrl(ctx.configDir, url)
      } catch (err) {
        return { ok: false, message: shortMessage(err) }
      }
      return { ok: true, ...(await applyImported(ctx)) }
    }
  )

  ipcMain.handle(
    IPC.connectionsGet,
    (): ConnectionsSnapshot => ctx.connections?.snapshot() ?? emptyConnectionsSnapshot()
  )

  /**
   * 流量缓冲的首屏补拉。窗口重建后不必等下一个采样点（一秒后）才画图。
   * 采集器不存在（内核未运行）时返回 null：没有数据来源，不能编一条零样本。
   */
  ipcMain.handle(IPC.statsGet, (): StatsSample | null => {
    if (ctx.stats === null) return null
    const snapshot = ctx.stats.snapshot()
    return {
      up: snapshot.up,
      down: snapshot.down,
      upTotal: snapshot.upTotal,
      downTotal: snapshot.downTotal,
      history: snapshot.history
    }
  })

  /**
   * 计数推送只在「新失败到达」时触发；失败滚出窗口时没有回调、没有推送。
   * 渲染层必须同时轮询本通道（`getLogCounts`），否则界面会一直显示过期的非零计数。
   * 采集器不存在时返回 null：没有计数来源，不能用 0 冒充「零次失败」。
   */
  ipcMain.handle(IPC.logsCountsGet, (): DialFailureCounts | null => ctx.logs?.counts() ?? null)

  /**
   * 日志尾巴。返回 null 而不是空数组，是因为两者对用户的含义完全不同：
   * 「内核没在跑、没有日志来源」必须说成这个，不能显示成「暂无日志」。
   */
  ipcMain.handle(
    IPC.logsRecentGet,
    (): LogsSnapshot | null =>
      ctx.logs === null
        ? null
        : { entries: ctx.logs.recent(), revision: ctx.logs.revision() }
  )

  ipcMain.handle(IPC.nodeSwitch, async (_event, arg: unknown): Promise<NodeSwitchResult> => {
    const input = parseNodeSwitch(arg)
    // 没有存活内核时与内核拒绝同形：渲染层只处理 ok:false，不需要区分原因。
    if (input === null || ctx.link === null) return { ok: false, status: 0 }
    return ctx.link.switchNode(input.group, input.node)
  })

  // 不接受任何入参：目标目录由主进程的 ctx 决定，渲染层传什么都忽略。
  ipcMain.handle(IPC.configOpenDir, async (): Promise<SimpleResult> => {
    if (deps.openPath === undefined) return { ok: false, message: '无法打开配置目录' }
    try {
      const error = await deps.openPath(ctx.configDir)
      // shell.openPath 用空串表示成功；错误原文可能带本地路径，不交给渲染层。
      return error === '' ? { ok: true } : { ok: false, message: '无法打开配置目录' }
    } catch {
      return { ok: false, message: '无法打开配置目录' }
    }
  })

  /**
   * 窗控。只认三个动作名，动作之外的多余参数一律忽略——通道不转发任何
   * 渲染层提供的路径、坐标或对象。`close` 只销毁窗口，不退出应用。
   */
  ipcMain.handle(IPC.windowControl, async (_event, action: unknown): Promise<SimpleResult> => {
    if (!isWindowAction(action)) return { ok: false }
    if (deps.windowControls === undefined) return { ok: false, message: '窗口不可用' }
    return runWindowAction(deps.windowControls, action)
  })

  ipcMain.handle(
    IPC.windowStateGet,
    (): WindowStateView => deps.windowState?.() ?? { maximized: false }
  )
  // 推送通道由主进程单向发送；注册空 handler 让通道集合完整。
  ipcMain.handle(IPC.windowStatePush, () => {})

  /**
   * 自启读取。入参一律忽略——`getLoginItemSettings` 不接受任何来自渲染层的输入。
   * 适配器缺席时回「不可用」，而不是抛错让设置页整页失败。
   */
  ipcMain.handle(IPC.autostartGet, async (): Promise<AutostartStateView> => {
    if (deps.autostart === undefined) return unavailableAutostart()
    return readAutostart(deps.autostart, deps.settingsFile)
  })

  /**
   * 自启设置。只接受布尔值：字符串 "false"、0、对象一律拒绝，避免 `Boolean(x)`
   * 把任何真值当「开启」写进系统启动项。
   */
  ipcMain.handle(IPC.autostartSet, async (_event, enabled: unknown): Promise<AutostartSetResult> => {
    if (deps.autostart === undefined) return { ok: false, state: unavailableAutostart() }
    if (typeof enabled !== 'boolean') {
      return { ok: false, state: await readAutostart(deps.autostart, deps.settingsFile) }
    }
    return setAutostart(deps.autostart, deps.settingsFile, enabled)
  })

  // 推送通道由主进程单向发送；注册空 handler 让通道集合与不可用变体保持一致。
  ipcMain.handle(IPC.connectionsPush, () => {})
  ipcMain.handle(IPC.logsCountsPush, () => {})
}
