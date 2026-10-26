import { Dashboard } from './components/Dashboard'
import { Sidebar } from './components/Sidebar'
import { StatePanel } from './components/StatePanel'
import { TitleBar } from './components/TitleBar'
import { TopBar } from './components/TopBar'
import { useProxies } from './hooks/useProxies'
import { useStats } from './hooks/useStats'
import { useStatus } from './hooks/useStatus'
import { pickActiveProxy } from './selectors'

export function App() {
  const { status, error, refresh } = useStatus()
  const { groups } = useProxies()
  const { current, history } = useStats()
  const active = pickActiveProxy(groups)

  return (
    <div className="app">
      <TitleBar />
      <div className="shell">
        <Sidebar status={status} />
        <main className="main">
          <TopBar
            status={status}
            onRefresh={() => {
              void refresh()
            }}
          />
          {status === null ? null : status.status === 'ready' ? (
            <Dashboard status={status} active={active} current={current} history={history} />
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
