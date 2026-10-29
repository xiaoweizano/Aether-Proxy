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
  ['reconnecting', copy.state.reconnecting.title],
  ['in-use', copy.state.inUse.title]
] as const

/** 日志仍落在占位页；设置页由 Task 5 换成真实内容。 */
const PLACEHOLDER_PAGES = [['logs', copy.nav.logs]] as const

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

  it('reconnecting 时不提供「重启内核」，顶栏说的是重连中而不是内核异常', async () => {
    window.aether = makeAether({
      getStatus: vi.fn(
        async (): Promise<AppStatusView> => ({ ...readyStatus, status: 'reconnecting' })
      )
    })

    const { container } = render(<App />)

    expect(await screen.findByRole('heading', { name: copy.state.reconnecting.title })).toBeInTheDocument()
    // 后台已有退避定时器在拉内核；再给手动重启会让两边抢着 spawn。
    expect(screen.queryByRole('button', { name: copy.state.coreError.restartAction })).toBeNull()
    // 顶栏与状态卡标题同名，按顶栏的状态元素取，避免歧义。
    expect(container.querySelector('.topbar-status')?.textContent).toBe(copy.status.reconnecting)
    expect(screen.queryByText(copy.status.coreError)).toBeNull()
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

  it.each(PLACEHOLDER_PAGES)('「%s」仍落在占位页', async (page, label) => {
    window.aether = makeAether()
    render(<App />)
    await screen.findByText(copy.dashboard.node.label)

    await userEvent.click(screen.getByRole('button', { name: label }))

    expect(screen.getByText(copy.pages[page].note)).toBeInTheDocument()
    expect(screen.queryByText(copy.dashboard.node.label)).toBeNull()
  })

  it('「设置」进入真实设置页，关闭自启后同屏显示警告', async () => {
    window.aether = makeAether({
      getAutostart: vi.fn(async () => ({
        enabled: true,
        persisted: true,
        appliesToSystem: true,
        systemDiffers: false
      })),
      setAutostart: vi.fn(async () => ({
        ok: true,
        state: {
          enabled: false,
          persisted: false,
          appliesToSystem: true,
          systemDiffers: false
        }
      }))
    })
    render(<App />)
    await screen.findByText(copy.dashboard.node.label)

    await userEvent.click(screen.getByRole('button', { name: copy.nav.settings }))

    expect(screen.getByRole('heading', { name: copy.nav.settings })).toBeInTheDocument()
    expect(screen.queryByText(copy.pages.planned)).toBeNull()
    const toggle = await screen.findByRole('switch', {
      name: copy.settings.autostart.label
    })
    expect(toggle).toHaveAttribute('aria-checked', 'true')

    await userEvent.click(toggle)

    expect(await screen.findByText(copy.settings.autostart.warning)).toBeInTheDocument()
    expect(toggle).toHaveAttribute('aria-checked', 'false')
  })

  it('节点页与仪表盘共用同一个轮询器，切换节点走 switchNode', async () => {
    const groups = [
      {
        name: 'Proxy',
        type: 'Selector',
        now: 'HK-01',
        nodes: [{ name: 'HK-01', delay: 38 }, { name: 'US-01', delay: 120 }]
      }
    ]
    const getProxies = vi.fn(async () => groups)
    const switchNode = vi.fn(async () => ({ ok: true, status: 204 }))
    window.aether = makeAether({ getProxies, switchNode })
    render(<App />)
    await screen.findByText(copy.dashboard.node.label)
    const callsOnDashboard = getProxies.mock.calls.length

    await userEvent.click(screen.getByRole('button', { name: copy.nav.nodes }))

    expect(screen.getByRole('heading', { name: copy.nav.nodes })).toBeInTheDocument()
    // 进节点页不会再拉一份：App 的 useProxies 是唯一轮询器，节点页只是渲染它的结果。
    expect(getProxies).toHaveBeenCalledTimes(callsOnDashboard)
    expect(screen.getByRole('button', { name: /HK-01/ })).toHaveAttribute('aria-pressed', 'true')

    await userEvent.click(screen.getByRole('button', { name: /US-01/ }))

    expect(switchNode).toHaveBeenCalledWith({ group: 'Proxy', node: 'US-01' })
    expect(screen.queryByText(copy.dashboard.node.label)).toBeNull()
  })

  it('Ctrl+K 打开命令面板，「查看日志」经同一套页面状态导航到日志页', async () => {
    window.aether = makeAether()
    render(<App />)
    await screen.findByText(copy.dashboard.node.label)

    await userEvent.keyboard('{Control>}k{/Control}')
    const input = screen.getByRole('combobox', { name: copy.palette.inputLabel })
    await userEvent.type(input, copy.palette.actions.viewLogs)
    await userEvent.keyboard('{Enter}')

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText(copy.pages.logs.note)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: copy.nav.logs })).toBeInTheDocument()
    // 导航仍走 sidebar 的同一个 page 状态，日志项的 aria-current 跟随。
    expect(screen.getByRole('button', { name: copy.nav.logs })).toHaveAttribute(
      'aria-current',
      'page'
    )
  })

  it('面板打开时 Esc 只关闭面板，不会让连接页同时清空搜索', async () => {
    window.aether = makeAether()
    render(<App />)
    await screen.findByText(copy.dashboard.node.label)
    await userEvent.click(screen.getByRole('button', { name: copy.nav.connections }))

    const search = screen.getByRole('searchbox', { name: copy.connections.searchLabel })
    await userEvent.type(search, 'github')
    expect(search).toHaveValue('github')

    await userEvent.keyboard('{Control>}k{/Control}')
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    await userEvent.keyboard('{Escape}')

    expect(screen.queryByRole('dialog')).toBeNull()
    // 连接页的全局 Esc 会清空搜索；面板必须截断这次按键。
    expect(search).toHaveValue('github')
    expect(search).toHaveFocus()
  })

  it('仪表盘的失败计数来自 App 级订阅，点击后导航到日志页', async () => {
    const groups = [
      { name: 'Proxy', type: 'Selector', now: 'HK-01', nodes: [{ name: 'HK-01', delay: 38 }] }
    ]
    window.aether = makeAether({
      getProxies: vi.fn(async () => groups),
      getLogCounts: vi.fn(async () => ({ recent: 2, windowMs: 60 * 60_000 }))
    })
    render(<App />)

    // 首屏轮询就足以让计数出现：不依赖推送。
    const action = await screen.findByRole('button', {
      name: copy.dashboard.node.healthFailuresAction(
        copy.dashboard.node.healthFailures('60 分钟', 2)
      )
    })
    await userEvent.click(action)

    expect(screen.getByText(copy.pages.logs.note)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: copy.nav.logs })).toHaveAttribute(
      'aria-current',
      'page'
    )
  })

  it('切页再回来不会丢掉已经落地的失败计数（订阅在 App，不在卡片里）', async () => {
    const groups = [
      { name: 'Proxy', type: 'Selector', now: 'HK-01', nodes: [{ name: 'HK-01', delay: 38 }] }
    ]
    const onLogCounts = vi.fn(() => () => {})
    window.aether = makeAether({
      getProxies: vi.fn(async () => groups),
      getLogCounts: vi.fn(async () => ({ recent: 1, windowMs: 60 * 60_000 })),
      onLogCounts
    })
    render(<App />)
    await screen.findByText(copy.dashboard.node.healthFailures('60 分钟', 1))

    await userEvent.click(screen.getByRole('button', { name: copy.nav.nodes }))
    expect(screen.queryByText(copy.dashboard.node.healthFailures('60 分钟', 1))).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: copy.nav.dashboard }))

    expect(screen.getByText(copy.dashboard.node.healthFailures('60 分钟', 1))).toBeInTheDocument()
    // 订阅只有 App 一处：卡片卸载重挂不会新建（也不会漏掉）一个订阅。
    expect(onLogCounts).toHaveBeenCalledTimes(1)
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
