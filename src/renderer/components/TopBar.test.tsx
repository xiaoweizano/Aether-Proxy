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

  it('reconnecting 时显示内核重连中，而不是内核异常', () => {
    render(<TopBar status={{ ...readyStatus, status: 'reconnecting' }} />)
    expect(screen.getByText(copy.status.reconnecting)).toBeInTheDocument()
    expect(screen.queryByText(copy.status.coreError)).toBeNull()
    // 重连中不是已连接：不能借 ready 的绿点说健康。
    expect(screen.queryByText(copy.status.connected)).toBeNull()
  })

  it('reconnecting 时模式切换与代理开关仍然禁用', () => {
    render(<TopBar status={{ ...readyStatus, status: 'reconnecting', proxyEnabled: true }} />)

    expect(screen.getByRole('button', { name: copy.mode.rule })).toBeDisabled()
    expect(screen.getByRole('button', { name: copy.proxy.off })).toBeDisabled()
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

  it('非 ready 时禁用模式切换与代理开关，且不发 IPC', async () => {
    const enableProxy = vi.fn(async () => ({ ok: true }))
    const setMode = vi.fn(async () => ({ ok: true, status: 204 }))
    window.aether = makeAether({ enableProxy, setMode })
    render(<TopBar status={{ ...readyStatus, status: 'no-config' }} />)

    const modes = [
      screen.getByRole('button', { name: copy.mode.rule }),
      screen.getByRole('button', { name: copy.mode.global }),
      screen.getByRole('button', { name: copy.mode.direct })
    ]
    for (const button of modes) {
      expect(button).toBeDisabled()
      // 没有内核时不显示任何选中段，即使状态里带着一个模式值。
      expect(button).toHaveAttribute('aria-pressed', 'false')
    }

    const pill = screen.getByRole('button', { name: copy.proxy.off })
    expect(pill).toBeDisabled()
    expect(pill).toHaveAttribute('aria-pressed', 'false')
    expect(pill).not.toHaveClass('on')

    await userEvent.click(pill)
    await userEvent.click(modes[0]!)

    expect(enableProxy).not.toHaveBeenCalled()
    expect(setMode).not.toHaveBeenCalled()
  })

  it('ready 时模式切换与代理开关可用', () => {
    render(<TopBar status={readyStatus} />)

    expect(screen.getByRole('button', { name: copy.mode.rule })).toBeEnabled()
    expect(screen.getByRole('button', { name: copy.mode.rule })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByRole('button', { name: copy.proxy.off })).toBeEnabled()
  })
})
