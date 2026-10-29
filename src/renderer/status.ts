import type { AppStatusView } from '../shared/ipc'

export type StatusTone = 'ready' | 'pending' | 'error' | 'idle'

/**
 * 顶栏状态与侧栏版本点共用的语义档位。侧栏只是同一事实的「低一级」表达：
 * ready → 绿色，failure → 红色，reconnecting（自动恢复中，既非健康也非终态）→ 蓝色，
 * 其余（无配置 / 未连接）→ 灰色。组件只消费 tone，不各自判断 status 字符串。
 */
export function statusTone(status: AppStatusView | null): StatusTone {
  if (status?.status === 'ready') return 'ready'
  if (status?.status === 'reconnecting') return 'pending'
  if (status?.status === 'core-error') return 'error'
  return 'idle'
}
