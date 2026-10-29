import type { Mode } from '../../shared/types'
import type { AppStatusView } from '../../shared/ipc'

/**
 * 主进程面向用户的文案（托盘）。渲染层的 `src/renderer/copy.ts` 不能被主进程
 * import，所以这里单独一份；措辞与渲染层保持一致，避免同一个事实在两个地方
 * 说得不一样。
 */
export type TrayStatus = AppStatusView['status']

/** `ready` 不在这里：它就绪时状态行显示当前节点，而不是一句状态文案。 */
const STATUS_TEXT: Record<Exclude<TrayStatus, 'ready'>, string> = {
  'no-config': '没有配置',
  'config-error': '配置有误',
  'core-error': '内核未运行',
  'in-use': '另一个实例运行中',
  reconnecting: '内核重连中'
}

const MODE_TEXT: Record<Mode, string> = {
  rule: '规则',
  global: '全局',
  direct: '直连'
}

/** 节点未知时用破折号，与渲染层的 `UNKNOWN` 同一约定；不编造节点名。 */
export const UNKNOWN_NODE = '—'

export const trayCopy = {
  /** 悬浮提示：一段事实，不含速率（托盘不显示速率）。 */
  tooltip: (segment: string) => `Aether · ${segment}`,
  statusLine: (node: string, mode: string) => `${node} · ${mode}`,
  proxy: '系统代理',
  switchNode: '切换节点',
  openWindow: '打开主窗口',
  quit: '退出',
  /** 没有可切换的策略组（内核未运行、配置为空）：如实说明，不画一个空子菜单。 */
  noGroups: '没有可切换的节点',
  unknownNode: UNKNOWN_NODE,
  statusText(status: TrayStatus): string {
    return status === 'ready' ? '' : STATUS_TEXT[status]
  },
  modeText(mode: Mode): string {
    return MODE_TEXT[mode]
  }
}
