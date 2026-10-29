import { useEffect, useState } from 'react'

/**
 * 当前窗口是否最大化。标题栏的中间按钮据此在「最大化」与「还原」之间切换：
 * 按钮说的是它**接下来会做的事**，不是窗口现在处在什么状态。
 *
 * 与 `useConnections` 同一形状：先订阅再补首屏，补拉失败时保留订阅来的状态。
 * 主进程在 `maximize` / `unmaximize` 时推送，双击拖动区触发的原生最大化
 * 也走同一条路径，所以按钮不会和窗口状态脱节。
 */
export function useWindowMaximized(): boolean {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    const api = window.aether
    if (api === undefined) return undefined

    let active = true
    const off = api.onWindowState((state) => {
      if (active) setMaximized(state.maximized === true)
    })
    void api.getWindowState().then(
      (state) => {
        if (active) setMaximized(state.maximized === true)
      },
      () => {
        // 首屏失败不影响订阅；后续推送到达会自然补齐。
      }
    )

    return () => {
      active = false
      off()
    }
  }, [])

  return maximized
}
