import { useState } from 'react'
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
            page === 'dashboard' ? (
              <Dashboard status={status} active={active} current={current} history={history} />
            ) : (
              <Placeholder page={page} />
            )
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
