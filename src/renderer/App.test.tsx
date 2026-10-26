import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { App } from './App'
import { copy } from './copy'
import { makeAether, readyStatus } from './test-utils'

const NON_READY = [
  ['no-config', copy.state.noConfig.title],
  ['config-error', copy.state.configError.title],
  ['core-error', copy.state.coreError.title],
  ['in-use', copy.state.inUse.title]
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
})
