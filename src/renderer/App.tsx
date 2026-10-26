import { Dashboard } from './components/Dashboard'
import { Sidebar } from './components/Sidebar'
import { TitleBar } from './components/TitleBar'
import { TopBar } from './components/TopBar'
import { useProxies } from './hooks/useProxies'
import { useStats } from './hooks/useStats'
import { useStatus } from './hooks/useStatus'
import { pickActiveProxy } from './selectors'

export function App() {
  const { status, refresh } = useStatus()
  const { groups } = useProxies()
  const { current, history } = useStats()
  const active = pickActiveProxy(groups)

  return (
    <div className="app">
      <TitleBar />
      <div className="shell">
        <Sidebar />
        <main className="main">
          <TopBar
            status={status}
            onRefresh={() => {
              void refresh()
            }}
          />
          <Dashboard status={status} active={active} current={current} history={history} />
        </main>
      </div>
    </div>
  )
}
