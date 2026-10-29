import type { AppStatusView } from '../shared/ipc'

export type StatusTone = 'ready' | 'error' | 'idle'

/**
 * 顶栏状态与侧栏版本点共用的三档语义。侧栏只是同一事实的「低一级」表达：
 * ready → 绿色，failure → 红色，其余（无配置 / 未连接 / 自动重连中）→ 灰色。
 * 组件只消费 tone，不各自判断 status 字符串。
 *
 * `reconnecting` 刻意落在灰档而不是新增蓝色：DESIGN.md 规定「Blue marks action,
 * red marks failure, each in exactly one place」，蓝色在这个系统里代表可交互，
 * 状态点不是交互元素。重连中既没在工作也没坏掉，事实由文案「内核重连中」承担，
 * 颜色不再额外表态。
 */
export function statusTone(status: AppStatusView | null): StatusTone {
  if (status?.status === 'ready') return 'ready'
  if (status?.status === 'core-error') return 'error'
  return 'idle'
}
