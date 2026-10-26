import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { copy } from '../copy'
import { makeAether, readyStatus } from '../test-utils'
import { TopBar } from './TopBar'

describe('TopBar', () => {
  it('core-error 时显示内核异常', () => {
    render(<TopBar status={{ ...readyStatus, status: 'core-error' }} />)
    expect(screen.getByText(copy.status.coreError)).toBeInTheDocument()
  })

  it('ready 时显示已连接', () => {
    render(<TopBar status={readyStatus} />)
    expect(screen.getByText(copy.status.connected)).toBeInTheDocument()
  })

  it('代理关闭时点击 pill 调用 enableProxy', async () => {
    const enableProxy = vi.fn(async () => ({ ok: true }))
    const disableProxy = vi.fn(async () => ({ ok: true }))
    window.aether = makeAether({ enableProxy, disableProxy })
    render(<TopBar status={{ ...readyStatus, proxyEnabled: false }} />)

    await userEvent.click(screen.getByRole('button', { name: copy.proxy.off }))

    expect(enableProxy).toHaveBeenCalledTimes(1)
    expect(disableProxy).not.toHaveBeenCalled()
  })

  it('代理开启时点击 pill 调用 disableProxy', async () => {
    const enableProxy = vi.fn(async () => ({ ok: true }))
    const disableProxy = vi.fn(async () => ({ ok: true }))
    window.aether = makeAether({ enableProxy, disableProxy })
    render(<TopBar status={{ ...readyStatus, proxyEnabled: true }} />)

    await userEvent.click(screen.getByRole('button', { name: copy.proxy.on }))

    expect(disableProxy).toHaveBeenCalledTimes(1)
    expect(enableProxy).not.toHaveBeenCalled()
  })

  it('代理切换失败时显示错误', async () => {
    const enableProxy = vi.fn(async () => ({ ok: false }))
    window.aether = makeAether({ enableProxy })
    render(<TopBar status={{ ...readyStatus, proxyEnabled: false }} />)

    await userEvent.click(screen.getByRole('button', { name: copy.proxy.off }))

    expect(await screen.findByText(/切换失败/)).toBeInTheDocument()
  })
})
