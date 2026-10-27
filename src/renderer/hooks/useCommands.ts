import { useMemo } from 'react'
import type { AetherApi, AppStatusView, ProxyGroupView } from '../../shared/ipc'
import type { Mode } from '../../shared/types'
import { copy } from '../copy'
import type { Page } from '../page'
import { pickActiveProxy } from '../selectors'

/**
 * 面板里的两种条目：动作是固定集合，节点来自 `useProxies` 的轮询结果。
 * 分组的唯一目的是渲染顺序（动作在前），过滤与高亮仍按一条扁平列表处理。
 */
export type CommandKind = 'action' | 'node'

export interface PaletteCommand {
  id: string
  /** 过滤与显示都用它：节点是节点名，动作是标题。 */
  title: string
  /** 次要信息：节点所属策略组，或当前节点名。 */
  detail?: string
  kind: CommandKind
  run(): void
}

export interface UseCommandsOptions {
  /** 由 App 的 `useProxies` 传入：面板不再开第二个轮询器。 */
  groups: ProxyGroupView[]
  status: AppStatusView | null
  onNavigate(page: Page): void
  /** 切换模式 / 代理 / 重启内核后让 App 重新拉状态。 */
  onRefresh?(): void
}

/** 「切换模式」在设计文档里是一组：规则 / 全局 / 直连各一条。 */
const MODES: readonly Mode[] = ['rule', 'global', 'direct']

function isGlobal(name: string): boolean {
  return name.toUpperCase() === 'GLOBAL'
}

/**
 * 内核动作都返回结果对象、不抛错；这里仍然接住 reject，避免未处理拒绝。
 * `onDone` 只在请求成功落地后触发（失败时界面停留在旧状态，不假装成功）。
 */
function invoke(action: Promise<unknown>, onDone?: () => void): void {
  void action.then(
    () => {
      onDone?.()
    },
    () => {}
  )
}

function withApi(action: (api: AetherApi) => Promise<unknown>, onDone?: () => void): void {
  const api = window.aether
  if (api === undefined) return
  invoke(action(api), onDone)
}

/**
 * 命令面板的动作与节点条目。
 *
 * 复制动作用 `pickActiveProxy` 取当前真正生效的节点，和仪表盘的「当前节点」同一口径；
 * 没有当前节点时动作仍在（六个动作的集合稳定），但执行时静默无操作——不能复制一个
 * 编造的破折号。`navigator.clipboard` 缺失或拒绝时同样静默，面板不是报错的地方。
 */
export function useCommands({
  groups,
  status,
  onNavigate,
  onRefresh
}: UseCommandsOptions): PaletteCommand[] {
  return useMemo(() => {
    const commands: PaletteCommand[] = []
    const proxyOn = status?.proxyEnabled === true
    const active = pickActiveProxy(groups)

    commands.push({
      id: 'proxy-toggle',
      kind: 'action',
      title: proxyOn ? copy.palette.actions.proxyOff : copy.palette.actions.proxyOn,
      run: () => {
        withApi((api) => (proxyOn ? api.disableProxy() : api.enableProxy()), onRefresh)
      }
    })

    for (const mode of MODES) {
      commands.push({
        id: `mode-${mode}`,
        kind: 'action',
        title: copy.palette.actions.mode(copy.mode[mode]),
        run: () => {
          withApi((api) => api.setMode(mode), onRefresh)
        }
      })
    }

    commands.push({
      id: 'core-restart',
      kind: 'action',
      title: copy.palette.actions.restartCore,
      run: () => {
        withApi((api) => api.restartCore(), onRefresh)
      }
    })

    commands.push({
      id: 'config-open-dir',
      kind: 'action',
      title: copy.palette.actions.openConfigDir,
      run: () => {
        withApi((api) => api.openConfigDir())
      }
    })

    commands.push({
      id: 'view-logs',
      kind: 'action',
      title: copy.palette.actions.viewLogs,
      run: () => {
        onNavigate('logs')
      }
    })

    const nodeName = active?.node ?? null
    commands.push({
      id: 'copy-node',
      kind: 'action',
      title: copy.palette.actions.copyNode,
      ...(nodeName === null ? {} : { detail: nodeName }),
      run: () => {
        if (nodeName === null) return
        void navigator.clipboard?.writeText(nodeName).catch(() => {})
      }
    })

    for (const group of groups) {
      // GLOBAL 只是全局模式下的入口集合，列出来会和真实节点重复（组名还会变成节点）。
      if (isGlobal(group.name)) continue
      for (const node of group.nodes) {
        commands.push({
          id: `node-${group.name}-${node.name}`,
          kind: 'node',
          title: node.name,
          detail: group.name,
          run: () => {
            withApi((api) => api.switchNode({ group: group.name, node: node.name }))
          }
        })
      }
    }

    return commands
  }, [groups, status, onNavigate, onRefresh])
}
