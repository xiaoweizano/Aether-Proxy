import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { copy } from '../copy'
import type { Page } from '../page'
import { readyStatus } from '../test-utils'
import { Sidebar } from './Sidebar'

function dotClass(container: HTMLElement): string | undefined {
  return container.querySelector('.sidebar-meta-dot')?.className
}

/** 状态点用例只关心 status；导航参数给一份不参与断言的最小实现。 */
function renderSidebar(status: Parameters<typeof Sidebar>[0]['status'], page: Page = 'dashboard') {
  return render(<Sidebar status={status} page={page} onNavigate={() => {}} />)
}

describe('Sidebar', () => {
  it('ready 时版本点是绿色（与顶栏同色，低一级）', () => {
    const { container } = renderSidebar(readyStatus)
    expect(dotClass(container)).toContain('ready')
    expect(dotClass(container)).not.toContain('idle')
  })

  it('core-error 时版本点转红', () => {
    const { container } = renderSidebar({ ...readyStatus, status: 'core-error' })
    expect(dotClass(container)).toContain('error')
  })

  it.each(['no-config', 'config-error', 'in-use'] as const)(
    '%s 时版本点变淡，不再显示绿色',
    (status) => {
      const { container } = renderSidebar({ ...readyStatus, status })
      expect(dotClass(container)).toContain('idle')
      expect(dotClass(container)).not.toContain('ready')
    }
  )

  it('reconnecting 时版本点用 pending 档：既不是绿也不是红', () => {
    const { container } = renderSidebar({ ...readyStatus, status: 'reconnecting' })
    expect(dotClass(container)).toContain('pending')
    expect(dotClass(container)).not.toContain('ready')
    expect(dotClass(container)).not.toContain('error')
    expect(dotClass(container)).not.toContain('idle')
  })

  it('状态尚未加载时也是灰点', () => {
    const { container } = renderSidebar(null)
    expect(dotClass(container)).toContain('idle')
  })

  it('侧栏仍显示版本号', () => {
    const { getByText } = renderSidebar(readyStatus)
    expect(getByText(copy.version)).toBeInTheDocument()
  })

  it.each<Page>(['dashboard', 'nodes', 'connections', 'settings', 'logs'])(
    '%s 页只有对应导航项带 aria-current',
    (page) => {
      const { getByRole, getAllByRole } = renderSidebar(readyStatus, page)

      const current = getAllByRole('button').filter((node) => node.hasAttribute('aria-current'))
      expect(current).toHaveLength(1)
      expect(current[0]).toHaveAccessibleName(copy.nav[page])
      expect(getByRole('button', { name: copy.nav[page] })).toHaveAttribute(
        'aria-current',
        'page'
      )
    }
  )

  it('导航项是按钮（不是链接），点击回传目标页', async () => {
    const onNavigate = vi.fn()
    const { getByRole, queryByRole } = render(
      <Sidebar status={readyStatus} page="dashboard" onNavigate={onNavigate} />
    )

    const connections = getByRole('button', { name: copy.nav.connections })
    expect(connections.tagName).toBe('BUTTON')
    expect(queryByRole('link')).toBeNull()

    await userEvent.click(connections)
    expect(onNavigate).toHaveBeenCalledWith('connections')
  })

  it('导航项可用键盘到达并激活（Tab + Enter / Space）', async () => {
    const onNavigate = vi.fn()
    render(<Sidebar status={readyStatus} page="dashboard" onNavigate={onNavigate} />)
    const user = userEvent.setup()

    // 逐个 Tab 直到焦点落到「连接」，确认它是原生可聚焦元素而不是 div。
    const target = document.querySelector<HTMLButtonElement>(
      `button[data-page="connections"]`
    )
    expect(target).not.toBeNull()
    let guard = 0
    while (document.activeElement !== target && guard < 40) {
      await user.tab()
      guard += 1
    }
    expect(document.activeElement).toBe(target)

    await user.keyboard('{Enter}')
    expect(onNavigate).toHaveBeenLastCalledWith('connections')

    await user.keyboard(' ')
    expect(onNavigate).toHaveBeenLastCalledWith('connections')
  })

  it('非 ready 时导航项仍可用', async () => {
    const onNavigate = vi.fn()
    const { getByRole } = render(
      <Sidebar
        status={{ ...readyStatus, status: 'no-config' }}
        page="dashboard"
        onNavigate={onNavigate}
      />
    )

    const logs = getByRole('button', { name: copy.nav.logs })
    expect(logs).toBeEnabled()
    await userEvent.click(logs)
    expect(onNavigate).toHaveBeenCalledWith('logs')
  })
})
