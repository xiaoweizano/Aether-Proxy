import { Sidebar } from './components/Sidebar'
import { TitleBar } from './components/TitleBar'
import { copy } from './copy'

export function App() {
  return (
    <div className="app">
      <TitleBar />
      <div className="shell">
        <Sidebar />
        <main className="main">
          <h1 className="page-title">{copy.dashboard.title}</h1>
          <p className="connecting">{copy.dashboard.connecting}</p>
        </main>
      </div>
    </div>
  )
}
