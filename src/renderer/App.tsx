import { useState, type ReactNode } from 'react'
import { Dashboard } from './components/Dashboard'
import { Sidebar } from './components/Sidebar'
import { StatePanel } from './components/StatePanel'
import { TitleBar } from './components/TitleBar'
import { TopBar } from './components/TopBar'
import { useProxies } from './hooks/useProxies'
import { useStats } from './hooks/useStats'
import { useStatus } from './hooks/useStatus'
import { Placeholder } from './pages/Placeholder'
import { PAGE_TITLES, type Page } from './page'
import { pickActiveProxy } from './selectors'

export function App() {
  const [page, setPage] = useState<Page>('dashboard')
  const { status, error, refresh } = useStatus()
  const { groups } = useProxies()
  const { current, history } = useStats()
  const active = pickActiveProxy(groups)

  /**
   * 分发写成穷尽的 Record：新增页面必须同时在这里登记，否则 tsc 直接报缺键。
   * 用三元表达式时，`Placeholder` 接受任意非 dashboard 页，漏接的类型错误不会出现。
   */
  const pages: Record<Page, ReactNode> = {
    dashboard: <Dashboard status={status} active={active} current={current} history={history} />,
    nodes: <Placeholder page="nodes" />,
    connections: <Placeholder page="connections" />,
    settings: <Placeholder page="settings" />,
    logs: <Placeholder page="logs" />
  }

  return (
    <div className="app">
      <TitleBar />
      <div className="shell">
        <Sidebar status={status} page={page} onNavigate={setPage} />
        <main className="main">
          <TopBar
            status={status}
            title={PAGE_TITLES[page]}
            onRefresh={() => {
              void refresh()
            }}
          />
          {status === null ? null : status.status === 'ready' ? (
            pages[page]
          ) : (
            // key 让状态切换时清掉上一套状态里的「已导入 / 错误」提示。
            <StatePanel
              key={status.status}
              status={status.status}
              {...(error === null ? {} : { proxyError: error })}
              onRefresh={() => {
                void refresh()
              }}
            />
          )}
        </main>
      </div>
    </div>
  )
}
