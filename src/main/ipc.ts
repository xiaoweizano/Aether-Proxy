import { mkdir } from 'node:fs/promises'
import type { Mode } from '../shared/types'
import { IPC } from '../shared/ipc'
import type {
  AppStatusView,
  ImportResult,
  ModeSetResult,
  PickImportResult,
  ProxyGroupView,
  SimpleResult
} from '../shared/ipc'
import type { ProxiesResponse } from './core/link'
import type { AppContext } from './bootstrap'
import { importFromFile } from './config/import'
import { writeSettings } from './settings'

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
}

const MODES: readonly Mode[] = ['rule', 'global', 'direct']

function isMode(value: unknown): value is Mode {
  return typeof value === 'string' && (MODES as readonly string[]).includes(value)
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
 */
export function toProxyGroups(res: ProxiesResponse): ProxyGroupView[] {
  const out: ProxyGroupView[] = []
  for (const entry of Object.values(res.proxies)) {
    if (entry === null || typeof entry !== 'object' || !Array.isArray(entry.all)) continue
    out.push({
      name: typeof entry.name === 'string' ? entry.name : '',
      type: typeof entry.type === 'string' ? entry.type : '',
      now: typeof entry.now === 'string' ? entry.now : '',
      nodes: entry.all.map((name) => {
        const node = res.proxies[name]
        if (node === undefined || Array.isArray(node.all)) return { name }
        const delay = node.history?.at(-1)?.delay
        return typeof delay === 'number' ? { name, delay } : { name }
      })
    })
  }
  return out
}

/**
 * bootstrap 本身抛出时（不该发生的装配失败）仍注册全部通道，否则渲染层每个调用
 * 都会收到 "No handler registered"，状态页连错误都显示不出来。
 * 不回显装配错误原文：那里可能拼进配置片段或路径。
 */
export function registerUnavailableHandlers(ipcMain: IpcMainLike): void {
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
    try {
      await mkdir(ctx.configDir, { recursive: true })
      await importFromFile(ctx.configDir, sourcePath)
      return { ok: true, needsRestart: true }
    } catch (err) {
      return { ok: false, message: shortMessage(err) }
    }
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
    try {
      // configDir 才是 upstream.yaml 的落点；no-config 时 profileDir 为 null。
      await mkdir(ctx.configDir, { recursive: true })
      await importFromFile(ctx.configDir, sourcePath)
      return { ok: true, needsRestart: true }
    } catch (err) {
      return { ok: false, message: shortMessage(err) }
    }
  })
}
