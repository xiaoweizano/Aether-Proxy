import type { ReactNode } from 'react'
import type { AppStatusView } from '../../shared/ipc'
import { copy } from '../copy'
import { statusTone } from '../status'

function DashboardIcon() {
  return (
    <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  )
}

function NodesIcon() {
  return (
    <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18" />
    </svg>
  )
}

function ConnectionsIcon() {
  return (
    <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 7h16M4 12h10M4 17h13" />
      <circle cx="18" cy="12" r="2" />
      <circle cx="20" cy="17" r="2" />
    </svg>
  )
}

function SettingsIcon() {
  return (
    <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 7a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 9 3.1V3a2 2 0 1 1 4 0v.1A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 20.9 9H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 2z" />
    </svg>
  )
}

function LogsIcon() {
  return (
    <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M14 3v5h5M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M8 13h8M8 17h5" />
    </svg>
  )
}

interface NavItem {
  label: string
  icon: ReactNode
  active?: boolean
}

const primaryNav: NavItem[] = [
  { label: copy.nav.dashboard, icon: <DashboardIcon />, active: true },
  { label: copy.nav.nodes, icon: <NodesIcon /> },
  { label: copy.nav.connections, icon: <ConnectionsIcon /> }
]

const secondaryNav: NavItem[] = [
  { label: copy.nav.settings, icon: <SettingsIcon /> },
  { label: copy.nav.logs, icon: <LogsIcon /> }
]

function NavGroup({ label, items }: { label: string; items: NavItem[] }) {
  return (
    <nav className="nav" aria-label={label}>
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          className={item.active === true ? 'nav-item active' : 'nav-item'}
          aria-current={item.active === true ? 'page' : undefined}
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </nav>
  )
}

export interface SidebarProps {
  status: AppStatusView | null
}

export function Sidebar({ status }: SidebarProps) {
  // 版本点重复顶栏的状态，只是低一级：ready 绿、失败红、其余灰。
  const tone = statusTone(status)
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-logo" aria-hidden="true">
          {copy.app.logo}
        </span>
        <span className="brand-word">{copy.app.name}</span>
      </div>
      <NavGroup label={copy.nav.labelPrimary} items={primaryNav} />
      <div className="sidebar-grow" />
      <NavGroup label={copy.nav.labelSecondary} items={secondaryNav} />
      <div className="sidebar-meta">
        <span className={`sidebar-meta-dot ${tone}`} aria-hidden="true" />
        {copy.version}
      </div>
    </aside>
  )
}
