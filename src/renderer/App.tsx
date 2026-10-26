import { Sidebar } from './components/Sidebar'
import { TitleBar } from './components/TitleBar'
import { TopBar } from './components/TopBar'
import { copy } from './copy'
import { useStatus } from './hooks/useStatus'

export function App() {
  const { status, refresh } = useStatus()

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
          <p className="connecting">{copy.dashboard.connecting}</p>
        </main>
      </div>
    </div>
  )
}
