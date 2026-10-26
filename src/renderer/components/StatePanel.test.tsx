import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { copy } from '../copy'
import { makeAether } from '../test-utils'
import { StatePanel } from './StatePanel'

describe('StatePanel', () => {
  it('no-config：标题、说明与唯一的导入主操作', () => {
    render(<StatePanel status="no-config" />)

    expect(screen.getByText(copy.state.noConfig.title)).toBeInTheDocument()
    expect(screen.getByText(copy.state.noConfig.detail)).toBeInTheDocument()
    const action = screen.getByRole('button', { name: copy.state.noConfig.importAction })
    expect(action).toHaveClass('primary')
    expect(screen.queryByRole('button', { name: copy.state.coreError.restartAction })).toBeNull()
  })

  it('config-error：导入主操作 + 查看日志占位', () => {
    render(<StatePanel status="config-error" />)

    expect(screen.getByText(copy.state.configError.title)).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: copy.state.configError.importAction })
    ).toBeEnabled()
    const logs = screen.getByRole('button', { name: copy.state.logsAction })
    expect(logs).toBeDisabled()
    expect(logs).toHaveAttribute('title', copy.state.logsPlaceholder)
  })

  it('core-error：重启主操作 + 查看日志占位', () => {
    render(<StatePanel status="core-error" />)

    expect(screen.getByText(copy.state.coreError.title)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: copy.state.coreError.restartAction })).toBeEnabled()
    const logs = screen.getByRole('button', { name: copy.state.logsAction })
    expect(logs).toBeDisabled()
    expect(logs).toHaveAttribute('title', copy.state.logsPlaceholder)
  })

  it('in-use：只有说明，没有任何操作，尤其没有重启内核', () => {
    render(<StatePanel status="in-use" />)

    expect(screen.getByText(copy.state.inUse.title)).toBeInTheDocument()
    expect(screen.getByText(copy.state.inUse.detail)).toBeInTheDocument()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(screen.queryByText(copy.state.coreError.restartAction)).toBeNull()
  })

  it('取消导入：不显示错误，也不显示成功提示', async () => {
    const importConfig = vi.fn(async () => ({ ok: false as const, cancelled: true as const }))
    render(<StatePanel status="no-config" importConfig={importConfig} />)

    await userEvent.click(screen.getByRole('button', { name: copy.state.noConfig.importAction }))

    expect(importConfig).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText(copy.state.noConfig.imported)).toBeNull()
  })

  it('导入成功：显示「重启后生效」并出现次要的重启按钮', async () => {
    const importConfig = vi.fn(async () => ({ ok: true as const, needsRestart: true as const }))
    render(<StatePanel status="no-config" importConfig={importConfig} />)

    await userEvent.click(screen.getByRole('button', { name: copy.state.noConfig.importAction }))

    expect(await screen.findByText(copy.state.noConfig.imported)).toBeInTheDocument()
    const restart = screen.getByRole('button', { name: copy.state.noConfig.restartAction })
    expect(restart).toHaveClass('state-action')
    expect(restart).not.toHaveClass('primary')
  })

  it('导入失败：把主进程给的消息渲染出来', async () => {
    const importConfig = vi.fn(async () => ({ ok: false as const, message: '缺少 proxies' }))
    render(<StatePanel status="no-config" importConfig={importConfig} />)

    await userEvent.click(screen.getByRole('button', { name: copy.state.noConfig.importAction }))

    expect(await screen.findByRole('alert')).toHaveTextContent('缺少 proxies')
    expect(screen.queryByText(copy.state.noConfig.imported)).toBeNull()
  })

  it('重启失败：把失败消息渲染出来', async () => {
    const restartCore = vi.fn(async () => ({ ok: false as const, message: '内核握手超时' }))
    render(<StatePanel status="core-error" restartCore={restartCore} />)

    await userEvent.click(screen.getByRole('button', { name: copy.state.coreError.restartAction }))

    expect(await screen.findByRole('alert')).toHaveTextContent('内核握手超时')
  })

  it('未注入回调时走 window.aether', async () => {
    const restartCore = vi.fn(async () => ({ ok: true as const }))
    const onRefresh = vi.fn()
    window.aether = makeAether({ restartCore })
    render(<StatePanel status="core-error" onRefresh={onRefresh} />)

    await userEvent.click(screen.getByRole('button', { name: copy.state.coreError.restartAction }))

    expect(restartCore).toHaveBeenCalledTimes(1)
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })
})
