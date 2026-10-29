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

/**
 * 开机自启的失败说明（主进程侧）。
 *
 * 只放**失败原因**这一句；开关标签、警告与「仅打包版生效」属于界面文案，
 * 在渲染层的 `src/renderer/copy.ts`——那几句必须和开关同屏可读，不能藏进提示。
 */
export const autostartCopy = {
  /** `getLoginItemSettings` 抛错：现在显示的是上次保存的设置，不是 Windows 的实际状态。 */
  readFailed: '无法读取系统的开机启动项，当前显示的是上次保存的设置',
  /** `setLoginItemSettings` 抛错：注册表写入被拒绝。 */
  systemFailed: '无法写入开机启动项，开关已恢复原状',
  /** 回读 `getLoginItemSettings` 抛错：无法确认改动是否生效。 */
  verifyFailed: '无法确认开机启动项是否生效，开关已恢复原状',
  /** 回读值与目标值不一致（组策略、杀软或权限拦下了写入）。 */
  notApplied: '系统没有接受开机自启的改动，开关已恢复原状',
  /** 意向落盘失败：系统已变，但下次启动记不住。 */
  saveFailed: '设置未能保存，重启应用后会丢失这次改动'
}
