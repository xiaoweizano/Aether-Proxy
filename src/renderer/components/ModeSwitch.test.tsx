import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { copy } from '../copy'
import { ModeSwitch } from './ModeSwitch'

describe('ModeSwitch', () => {
  it('模式切换失败时回滚选中态并显示错误', async () => {
    const setMode = vi.fn(async () => ({ ok: false, status: 500 }))
    render(<ModeSwitch value="rule" onChange={() => {}} setMode={setMode} />)

    await userEvent.click(screen.getByRole('button', { name: copy.mode.global }))

    expect(await screen.findByText(/切换失败/)).toBeTruthy()
    expect(screen.getByRole('button', { name: copy.mode.rule }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: copy.mode.global }).getAttribute('aria-pressed')).toBe('false')
  })

  it('setMode 抛错时同样回滚并显示错误', async () => {
    const setMode = vi.fn(async () => {
      throw new Error('boom')
    })
    render(<ModeSwitch value="rule" onChange={() => {}} setMode={setMode} />)

    await userEvent.click(screen.getByRole('button', { name: copy.mode.direct }))

    expect(await screen.findByText(/切换失败/)).toBeTruthy()
    expect(screen.getByRole('button', { name: copy.mode.rule }).getAttribute('aria-pressed')).toBe('true')
  })

  it('切换成功后通知 onChange 并保持选中态', async () => {
    const setMode = vi.fn(async () => ({ ok: true, status: 204 }))
    const onChange = vi.fn()
    render(<ModeSwitch value="rule" onChange={onChange} setMode={setMode} />)

    await userEvent.click(screen.getByRole('button', { name: copy.mode.global }))

    expect(setMode).toHaveBeenCalledWith('global')
    expect(onChange).toHaveBeenCalledWith('global')
    expect(screen.getByRole('button', { name: copy.mode.global }).getAttribute('aria-pressed')).toBe('true')
  })

  it('三个分段始终渲染', () => {
    render(<ModeSwitch value="rule" />)
    expect(screen.getAllByRole('button')).toHaveLength(3)
    expect(screen.getByRole('group', { name: copy.mode.label })).toBeInTheDocument()
  })
})
