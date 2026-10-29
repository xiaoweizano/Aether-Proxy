import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { CommandPalette } from './components/CommandPalette'
import { Dashboard } from './components/Dashboard'
import { Sidebar } from './components/Sidebar'
import { StatePanel } from './components/StatePanel'
import { TitleBar } from './components/TitleBar'
import { TopBar } from './components/TopBar'
import { useConnections, summarizeConnections } from './hooks/useConnections'
import { useLogCounts } from './hooks/useLogCounts'
import { useProxies } from './hooks/useProxies'
import { useStats } from './hooks/useStats'
import { useStatus } from './hooks/useStatus'
import { useWindowMaximized } from './hooks/useWindowMaximized'
import { ConnectionsPage } from './pages/ConnectionsPage'
import { NodesPage } from './pages/NodesPage'
import { LogsPage } from './pages/LogsPage'
import { SettingsPage } from './pages/SettingsPage'
import { PAGE_TITLES, initialPage, type Page } from './page'
import { pickActiveProxy } from './selectors'

export function App() {
  const [page, setPage] = useState<Page>(() => initialPage(window.location.search))
  const { status, error, refresh } = useStatus()
  const { groups } = useProxies()
  const { current, history } = useStats()
  // 订阅 + 轮询都挂在 App：NodeCard 会因换页卸载，钩子放在卡片里会丢掉已落地的计数。
  const dialFailures = useLogCounts()
  // 连接快照同理只订阅一次：仪表盘的活跃连接数在离开连接页后仍要更新。
  const connections = useConnections()
  // 标题栏的中间按钮需要知道当前是否最大化：按钮文字是「下一步动作」。
  const maximized = useWindowMaximized()
  const connectionSummary = useMemo(
    () => summarizeConnections(connections),
    [connections]
  )
  const active = pickActiveProxy(groups)

  // 状态刷新函数保持稳定：命令面板的 useCommands 以它为依赖，避免每次轮询重建动作集。
  const refreshNow = useCallback(() => {
    void refresh()
  }, [refresh])

  /** 失败计数点击后的去向；与命令面板的「查看日志」走同一个页面状态。 */
  const viewLogs = useCallback(() => {
    setPage('logs')
  }, [])

  /**
   * 分发写成穷尽的 Record：新增页面必须同时在这里登记，否则 tsc 直接报缺键。
   * 用三元表达式时，漏接的页面不会在类型层面暴露出来。
   */
  const pages: Record<Page, ReactNode> = {
    dashboard: (
      <Dashboard
        status={status}
        active={active}
        current={current}
        history={history}
        connections={connectionSummary}
        dialFailures={dialFailures}
        onViewLogs={viewLogs}
      />
    ),
    nodes: <NodesPage groups={groups} />,
    connections: <ConnectionsPage connections={connections} />,
    settings: <SettingsPage />,
    logs: <LogsPage />
  }

  return (
    <div className="app">
      <TitleBar maximized={maximized} />
      <div className="shell">
        <Sidebar status={status} page={page} onNavigate={setPage} />
        <main className="main">
          <TopBar
            status={status}
            title={PAGE_TITLES[page]}
            onRefresh={refreshNow}
          />
          {/*
            非 ready 时只把**仪表盘**换成状态面板，其余页面照常渲染：崩溃后最想看的
            就是日志与设置，把整个主区锁在状态页上会让「查看日志」无处可去。
            规格（desktop-shell）也要求状态页出现时侧栏仍可操作。
          */}
          {status === null ? null : status.status !== 'ready' && page === 'dashboard' ? (
            // key 让状态切换时清掉上一套状态里的「已导入 / 错误」提示。
            <StatePanel
              key={status.status}
              status={status.status}
              {...(error === null ? {} : { proxyError: error })}
              onRefresh={refreshNow}
              onViewLogs={viewLogs}
            />
          ) : (
            pages[page]
          )}
        </main>
      </div>
      <CommandPalette
        groups={groups}
        status={status}
        onNavigate={setPage}
        onRefresh={refreshNow}
      />
    </div>
  )
}
