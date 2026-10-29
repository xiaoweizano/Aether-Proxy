import type { AppStatusView, ProxyGroupView } from '../../shared/ipc'
import type { Mode } from '../../shared/types'
import { effectiveSelection, pickActiveProxy } from '../../shared/proxy-groups'
import type { AppContext } from '../bootstrap'
import { toProxyGroups } from '../ipc'
import { writeSettings } from '../settings'
import { trayCopy, UNKNOWN_NODE, type TrayStatus } from './copy'

/**
 * 托盘模块分成两层：
 * - **菜单模型**（`buildTrayMenu`）：纯函数，输入是一份状态快照 + 动作表，
 *   输出可序列化的菜单项。Vitest 里没有 Electron，这一层是全部测试的对象。
 * - **装配层**（`createTray`）：读快照、比签名、只在状态真的变化时调用
 *   `host.apply`。`host` 是 Electron 适配器，由 `src/main/index.ts` 注入，
 *   是唯一未被单测覆盖的部分。
 *
 * 账本裁决：速率变化不得重建菜单。这里有两道保险——快照里根本没有速率字段，
 * 以及重建前会比较菜单签名（节点延迟等每轮都会变、但不进菜单的数据因此不会触发重建）。
 */

export interface TraySnapshot {
  /** 内核/配置状态；`ready` 时状态行显示当前节点，其余状态显示一句事实文案。 */
  status: AppStatusView['status']
  mode: Mode
  /** 系统代理的实际状态（不是上一次动作的意图）。 */
  proxyEnabled: boolean
  /** `proxyServer` 已知（内核在跑）才允许「打开系统代理」。关闭永远允许。 */
  proxyAvailable: boolean
  /** 当前生效节点名；没有可用节点时为 null。 */
  activeNode: string | null
  /** 原始策略组视图（含 GLOBAL）；过滤在模型里做，便于测试断言。 */
  groups: ProxyGroupView[]
}

export type TrayItemType = 'normal' | 'separator' | 'checkbox' | 'submenu'

export interface TrayMenuItem {
  id: string
  type: TrayItemType
  label?: string
  enabled?: boolean
  checked?: boolean
  submenu?: TrayMenuItem[]
  /**
   * 返回值被忽略（Electron 也不看它）：动作可能返回「是否成功」，但托盘不据此
   * 单方面改勾——重建时会重新读真实状态。
   */
  click?: () => unknown
}

export interface TrayActions {
  /** 目标状态；返回「动作是否完整成功」。失败时不得改动实际状态。 */
  setProxyEnabled(enabled: boolean): Promise<boolean>
  switchNode(group: string, node: string): Promise<boolean>
  openWindow(): void
  quit(): void
}

/** 测试与适配层都按这个常量找菜单项，避免字符串散落。 */
export const TRAY_ID = {
  status: 'tray-status',
  separator: 'tray-separator',
  proxy: 'tray-proxy',
  switchRoot: 'tray-switch',
  noGroups: 'tray-switch-none',
  openWindow: 'tray-open-window',
  quit: 'tray-quit'
} as const

function isGlobal(name: string): boolean {
  return name.toUpperCase() === 'GLOBAL'
}

/**
 * 状态行文字：有节点就显示节点；内核没在跑时显示状态事实，而不是一个假的节点名。
 * 与悬浮提示共用，保证两处说的是同一件事。
 */
export function trayStatusLine(snapshot: Pick<TraySnapshot, 'status' | 'mode' | 'activeNode'>): string {
  const node =
    snapshot.activeNode ?? (snapshot.status === 'ready' ? UNKNOWN_NODE : trayCopy.statusText(snapshot.status))
  return trayCopy.statusLine(node, trayCopy.modeText(snapshot.mode))
}

/**
 * 菜单模型。顺序与设计文档一致：状态行 / 分隔线 / 系统代理 / 切换节点 / 打开主窗口 / 退出。
 *
 * 节点项用 `fixed || now` 作为勾选依据：自动组（URLTest 等）里内核只写 `fixed` 不改
 * `now`，照 `now` 画勾会显示出内核并未采纳的选择。节点标签只放名字——延迟不进菜单，
 * 否则每次测速都会重建一次托盘。
 */
export function buildTrayMenu(snapshot: TraySnapshot, actions: TrayActions): TrayMenuItem[] {
  const switchable = snapshot.groups.filter((group) => !isGlobal(group.name))

  const switchMenu: TrayMenuItem[] =
    switchable.length === 0
      ? [{ id: TRAY_ID.noGroups, type: 'normal', label: trayCopy.noGroups, enabled: false }]
      : switchable.map((group, groupIndex) => ({
          id: `tray-group:${groupIndex}:${group.name}`,
          type: 'submenu',
          label: group.name,
          submenu: group.nodes.map((node, nodeIndex) => ({
            id: `tray-node:${groupIndex}:${nodeIndex}:${group.name}:${node.name}`,
            type: 'checkbox',
            label: node.name,
            checked: effectiveSelection(group) === node.name,
            click: () => actions.switchNode(group.name, node.name)
          }))
        }))

  return [
    {
      id: TRAY_ID.status,
      type: 'normal',
      label: trayStatusLine(snapshot),
      enabled: false
    },
    { id: TRAY_ID.separator, type: 'separator' },
    {
      id: TRAY_ID.proxy,
      type: 'checkbox',
      label: trayCopy.proxy,
      // 勾选态只来自 `proxyEnabled`（系统代理的实际状态），不来自上一次点击。
      checked: snapshot.proxyEnabled,
      // 内核没起来时不能开启（会指向一个死端口），但已经开着时必须还能关。
      enabled: snapshot.proxyEnabled || snapshot.proxyAvailable,
      click: () => actions.setProxyEnabled(!snapshot.proxyEnabled)
    },
    {
      id: TRAY_ID.switchRoot,
      type: 'submenu',
      label: trayCopy.switchNode,
      enabled: switchable.length > 0,
      submenu: switchMenu
    },
    {
      id: TRAY_ID.openWindow,
      type: 'normal',
      label: trayCopy.openWindow,
      click: () => actions.openWindow()
    },
    {
      id: TRAY_ID.quit,
      type: 'normal',
      label: trayCopy.quit,
      click: () => actions.quit()
    }
  ]
}

/** 菜单的可比较投影：不含点击处理器，只保留会影响视觉与可用性的字段。 */
function projectMenu(items: readonly TrayMenuItem[]): unknown {
  return items.map((item) => [
    item.id,
    item.type,
    item.label ?? '',
    item.enabled ?? true,
    item.checked ?? null,
    item.submenu === undefined ? null : projectMenu(item.submenu)
  ])
}

/** 重建判定用的签名；导出便于测试直接比较两份模型。 */
export function menuSignature(items: readonly TrayMenuItem[]): string {
  return JSON.stringify(projectMenu(items))
}

/** Electron 适配器的最小接口；测试里用假体，生产实现见 `src/main/index.ts`。 */
export interface TrayHost {
  apply(items: readonly TrayMenuItem[], tooltip: string): void
  /** 托盘左键：打开/聚焦主窗口。 */
  onActivate(handler: () => void): void
  /** 退出前销毁托盘对象，避免图标残留到进程结束。 */
  dispose(): void
}

/**
 * 菜单模型的扁平投影，形状与 Electron 的 `MenuItemConstructorOptions` 一致，
 * 但不 import electron（测试环境没有它）。适配层直接 `Menu.buildFromTemplate`。
 */
export interface MenuTemplateItem {
  id: string
  type: 'normal' | 'separator' | 'checkbox' | 'submenu'
  label?: string
  enabled?: boolean
  checked?: boolean
  submenu?: MenuTemplateItem[]
  click?: () => void
}

/**
 * 把菜单模型翻成 Electron 模板。
 *
 * `click` 包一层：Electron 的点击回调是同步的，动作却是异步的（开关代理要写注册表、
 * 切节点要走 controller）。未处理的 rejection 会在主进程里冒成 unhandledRejection
 * 并可能带出整份堆栈，所以这里显式 `catch` 并交给 `onError`——正常路径上动作已经
 * 把失败转成了 false，这一层只是防止意外的同步/异步异常逃出回调。
 *
 * 复选框的自动取反：Electron 在调用 click 前会**先**把 checked 翻过去。这里不拦，
 * 因为动作完成后装配层会按真实状态重建整份菜单——那一份才是权威的。
 */
export function toMenuTemplate(
  items: readonly TrayMenuItem[],
  onError?: (error: unknown) => void
): MenuTemplateItem[] {
  return items.map((item) => {
    const out: MenuTemplateItem = { id: item.id, type: item.type }
    if (item.label !== undefined) out.label = item.label
    if (item.enabled !== undefined) out.enabled = item.enabled
    if (item.checked !== undefined) out.checked = item.checked
    if (item.submenu !== undefined) out.submenu = toMenuTemplate(item.submenu, onError)
    if (item.click !== undefined) {
      const run = item.click
      out.click = () => {
        void Promise.resolve()
          .then(run)
          .catch((err: unknown) => onError?.(err))
      }
    }
    return out
  })
}

export interface TrayDeps {
  host: TrayHost
  actions: TrayActions
  readSnapshot(): Promise<TraySnapshot>
  onError?(error: unknown): void
}

export interface TrayController {
  /** 读快照并在状态变化时重建菜单；并发调用会串行执行。 */
  refresh(): Promise<void>
  /** 已应用菜单的次数；测试用它断言「速率变化/重复刷新不重建」。 */
  buildCount(): number
  dispose(): void
}

/**
 * 装配层。菜单只在签名变化时重建——Electron 的菜单不可变，重建即整份替换，
 * 所以这里替换的是整个 Menu 对象，旧菜单随之失效，不会留下悬空的监听器
 * （监听器都内嵌在菜单项里，随旧对象一起被回收）。
 */
export function createTray(deps: TrayDeps): TrayController {
  let buildCount = 0
  let signature: string | null = null
  let disposed = false
  let queue: Promise<void> = Promise.resolve()
  /** 队列里已经有一次待跑的刷新：后来的定时器 tick 只置位「再读一次」。 */
  let pending = false
  /** 本轮跑完后还要不要再读一次（合并到下一次，而不是排成一串）。 */
  let rerun = false
  /**
   * 下一次应用菜单时强制重画，即使签名没变。
   *
   * Electron 在调用复选框的 click **之前**就把 checked 翻过去了（自动取反）。
   * 动作失败时真实状态没变、签名也就没变——若不强制重画，托盘会停在一个
   * 「点了但没生效」的勾上，正是任务要求避免的那种说谎。
   */
  let forceApply = false

  /** 动作执行完再刷一次：勾选态必须反映动作之后的真实状态，而不是动作的意图。 */
  const afterAction = async (ok: boolean): Promise<boolean> => {
    forceApply = true
    await refresh()
    return ok
  }
  const actions: TrayActions = {
    async setProxyEnabled(enabled) {
      return afterAction(await deps.actions.setProxyEnabled(enabled))
    },
    async switchNode(group, node) {
      return afterAction(await deps.actions.switchNode(group, node))
    },
    openWindow: () => deps.actions.openWindow(),
    quit: () => deps.actions.quit()
  }

  async function runOnce(): Promise<void> {
    if (disposed) return
    let items: TrayMenuItem[]
    let tooltip: string
    try {
      const snapshot = await deps.readSnapshot()
      if (disposed) return
      items = buildTrayMenu(snapshot, actions)
      tooltip = trayCopy.tooltip(trayStatusLine(snapshot))
    } catch (err) {
      // 快照读取失败（内核暂时不可达等）：保持上一份菜单，不要画出一份空壳。
      deps.onError?.(err)
      return
    }
    const next = `${menuSignature(items)}\u0000${tooltip}`
    if (next === signature && !forceApply) return
    forceApply = false
    signature = next
    buildCount += 1
    deps.host.apply(items, tooltip)
  }

  /**
   * 刷新串行执行。内核不可达时 `readSnapshot` 会等到 fetch 超时（5 秒），
   * 比 1.5 秒的定时器慢，所以不能让每个 tick 都排进队列。这里用一个「再看一次」
   * 标记合并请求：已经有读取在跑时，后来的请求只把标记置位，跑完后再补读一轮。
   *
   * 补读这一轮是必要的，不只是省事：托盘动作（开关代理）完成时会调用 refresh，
   * 若此时恰好有一次读取正在读「动作前」的状态，直接并进它就会把旧状态画成菜单。
   */
  function refresh(): Promise<void> {
    rerun = true
    if (pending) return queue
    pending = true
    queue = queue.then(async () => {
      while (rerun && !disposed) {
        rerun = false
        await runOnce()
      }
      pending = false
    })
    return queue
  }

  deps.host.onActivate(() => deps.actions.openWindow())

  return {
    refresh,
    buildCount: () => buildCount,
    dispose() {
      if (disposed) return
      disposed = true
      deps.host.dispose()
    }
  }
}

export interface TrayActionDeps {
  ctx: AppContext
  settingsFile: string
  openWindow(): void
  quit(): void
  /** 测试注入；缺省写真实的 settings.json。 */
  writeSettingsFn?: (file: string, settings: { proxyEnabled: boolean }) => Promise<void>
}

/**
 * 从 `AppContext` 读出菜单需要的状态。策略组经 `toProxyGroups` 规范化（与渲染层
 * 同一份视图模型），节点切换与「当前节点」显示都用它，托盘不会自己解析内核原文。
 *
 * 内核不可达或未运行时 `groups` 为空：菜单退回「没有可切换的节点」，而不是拿一份
 * 过期列表骗人。`proxyEnabled` 一律取实际状态。
 */
export async function readTraySnapshot(ctx: AppContext): Promise<TraySnapshot> {
  let groups: ProxyGroupView[] = []
  if (ctx.link !== null) {
    try {
      groups = toProxyGroups(await ctx.link.proxies())
    } catch {
      // 内核暂时不可达：空列表，状态行由 status 决定，不伪造上一轮的节点。
      groups = []
    }
  }
  const active = ctx.startupStatus === 'ready' ? pickActiveProxy(groups) : null
  return {
    status: ctx.startupStatus,
    mode: ctx.mode,
    proxyEnabled: ctx.proxyEnabled,
    proxyAvailable: ctx.proxyServer !== null,
    activeNode: active?.node ?? null,
    groups
  }
}

/**
 * 把托盘动作接到 `AppContext` 上，与 `src/main/ipc.ts` 的 IPC 处理器走同一套底层操作
 * （不经 IPC 往返）。开关语义也必须一致：
 *
 * - 成功后才把 `ctx.proxyEnabled` 改成目标值；
 * - 失败时保持 `ctx.proxyEnabled` 不变——界面随后重建菜单，勾选态就是系统的实际状态，
 *   不会留下一个「点了但没生效」的勾。
 * - 结果同时落盘，否则下次启动会按旧偏好重新接管代理。
 */
export function createTrayActions(deps: TrayActionDeps): TrayActions {
  const { ctx, settingsFile } = deps
  const persist =
    deps.writeSettingsFn ?? ((file: string, settings: { proxyEnabled: boolean }) => writeSettings(file, settings))
  return {
    async setProxyEnabled(enabled) {
      if (enabled) {
        if (ctx.proxyServer === null) return false
        try {
          await ctx.controller.enable(ctx.proxyServer)
        } catch {
          return false
        }
        ctx.proxyEnabled = true
        try {
          await persist(settingsFile, { proxyEnabled: true })
        } catch {
          return false
        }
        return true
      }
      try {
        await ctx.controller.disable()
      } catch {
        // 还原失败：保持 proxyEnabled 原值，界面不能假装已经关闭。
        return false
      }
      ctx.proxyEnabled = false
      try {
        await persist(settingsFile, { proxyEnabled: false })
      } catch {
        return false
      }
      return true
    },

    async switchNode(group, node) {
      if (ctx.link === null) return false
      const result = await ctx.link.switchNode(group, node)
      return result.ok
    },

    openWindow: deps.openWindow,
    quit: deps.quit
  }
}

export type { TrayStatus }
