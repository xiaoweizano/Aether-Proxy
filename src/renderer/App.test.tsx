import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { AppStatusView } from '../shared/ipc'
import { App } from './App'
import { copy } from './copy'
import { makeAether, readyStatus } from './test-utils'

const NON_READY = [
  ['no-config', copy.state.noConfig.title],
  ['config-error', copy.state.configError.title],
  ['core-error', copy.state.coreError.title],
  ['in-use', copy.state.inUse.title]
] as const

/** 节点 / 设置 / 日志仍落在占位页；连接页在 Task 5 已实现。 */
const PLACEHOLDER_PAGES = [
  ['nodes', copy.nav.nodes],
  ['settings', copy.nav.settings],
  ['logs', copy.nav.logs]
] as const

describe('App', () => {
  it('ready 时渲染 Dashboard，而不是状态面板', async () => {
    window.aether = makeAether()

    render(<App />)

    expect(await screen.findByText(copy.dashboard.node.label)).toBeInTheDocument()
    expect(screen.queryByText(copy.state.noConfig.title)).toBeNull()
  })

  it.each(NON_READY)('%s 状态用 StatePanel 替代 Dashboard', async (status, title) => {
    window.aether = makeAether({
      getStatus: vi.fn(async () => ({ ...readyStatus, status }))
    })

    render(<App />)

    // 顶栏的「内核异常」与面板标题同名，按标题角色取，避免歧义。
    expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument()
    expect(screen.queryByText(copy.dashboard.node.label)).toBeNull()
    // 侧栏与顶栏仍然在场：状态页不劫持整个外壳。
    expect(screen.getByRole('navigation', { name: copy.nav.labelPrimary })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: copy.dashboard.title })).toBeInTheDocument()
  })

  it('点「连接」进入连接页，点回「仪表盘」恢复，标题跟随页面', async () => {
    window.aether = makeAether()
    render(<App />)

    expect(await screen.findByText(copy.dashboard.node.label)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: copy.nav.connections }))

    expect(await screen.findByText(copy.connections.empty)).toBeInTheDocument()
    expect(screen.getAllByRole('columnheader')).toHaveLength(6)
    expect(screen.queryByText(copy.dashboard.node.label)).toBeNull()
    expect(screen.getByRole('heading', { name: copy.nav.connections })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: copy.nav.dashboard }))

    expect(await screen.findByText(copy.dashboard.node.label)).toBeInTheDocument()
    expect(screen.queryByText(copy.connections.empty)).toBeNull()
    expect(screen.getByRole('heading', { name: copy.dashboard.title })).toBeInTheDocument()
  })

  it('aria-current 只标在当前页的导航项上', async () => {
    window.aether = makeAether()
    render(<App />)

    const dashboard = screen.getByRole('button', { name: copy.nav.dashboard })
    const connections = screen.getByRole('button', { name: copy.nav.connections })

    expect(dashboard).toHaveAttribute('aria-current', 'page')
    expect(connections).not.toHaveAttribute('aria-current')

    await userEvent.click(connections)

    expect(connections).toHaveAttribute('aria-current', 'page')
    expect(dashboard).not.toHaveAttribute('aria-current')
    expect(screen.getAllByRole('button', { name: copy.nav.connections })).toHaveLength(1)
  })

  it.each(PLACEHOLDER_PAGES)('「%s」在 Task 4 落在占位页', async (page, label) => {
    window.aether = makeAether()
    render(<App />)
    await screen.findByText(copy.dashboard.node.label)

    await userEvent.click(screen.getByRole('button', { name: label }))

    expect(screen.getByText(copy.pages[page].note)).toBeInTheDocument()
    expect(screen.queryByText(copy.dashboard.node.label)).toBeNull()
  })

  it('非 ready 时导航不被阻断：切页后面板保留、导航项可操作', async () => {
    window.aether = makeAether({
      getStatus: vi.fn(
        async (): Promise<AppStatusView> => ({ ...readyStatus, status: 'no-config' })
      )
    })
    render(<App />)

    expect(
      await screen.findByRole('heading', { name: copy.state.noConfig.title })
    ).toBeInTheDocument()

    const connections = screen.getByRole('button', { name: copy.nav.connections })
    await userEvent.click(connections)

    // 状态面板在任意页面都是主区内容；页面状态只体现在导航选中态上。
    expect(screen.getByRole('heading', { name: copy.state.noConfig.title })).toBeInTheDocument()
    expect(screen.queryByText(copy.connections.empty)).toBeNull()
    expect(connections).toHaveAttribute('aria-current', 'page')
    expect(connections).toBeEnabled()
  })
})
