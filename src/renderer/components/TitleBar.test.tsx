import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { copy } from '../copy'
import { makeAether } from '../test-utils'
import { TitleBar } from './TitleBar'

const css = readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'styles', 'app.css'),
  'utf8'
)

/** 取出一条规则的声明块；找不到时返回 null，让断言给出可读的失败。 */
function ruleBody(selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(css)
  return match?.[1] ?? null
}

describe('TitleBar', () => {
  it('渲染三个窗口按钮，无障碍名来自 copy', () => {
    window.aether = makeAether()
    render(<TitleBar />)

    expect(screen.getByRole('button', { name: copy.window.minimize })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: copy.window.maximize })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: copy.window.close })).toBeInTheDocument()
  })

  it.each([
    ['minimize', copy.window.minimize],
    ['maximize', copy.window.maximize],
    ['close', copy.window.close]
  ] as const)('点击 %s 按钮调用 windowControl(%s)', async (action, label) => {
    const windowControl = vi.fn(async () => ({ ok: true }))
    window.aether = makeAether({ windowControl })
    render(<TitleBar />)

    await userEvent.click(screen.getByRole('button', { name: label }))

    expect(windowControl).toHaveBeenCalledTimes(1)
    expect(windowControl).toHaveBeenCalledWith(action)
  })

  it('最大化时中间按钮变成「还原」，点击仍然发 maximize（主进程负责切换）', async () => {
    const windowControl = vi.fn(async () => ({ ok: true }))
    window.aether = makeAether({ windowControl })
    render(<TitleBar maximized />)

    const button = screen.getByRole('button', { name: copy.window.restore })
    expect(screen.queryByRole('button', { name: copy.window.maximize })).toBeNull()

    await userEvent.click(button)
    expect(windowControl).toHaveBeenCalledWith('maximize')
  })

  it('没有 preload（window.aether 缺失）时点击不抛错', async () => {
    Reflect.deleteProperty(window, 'aether')
    render(<TitleBar />)

    await expect(
      userEvent.click(screen.getByRole('button', { name: copy.window.close }))
    ).resolves.toBeUndefined()
  })

  it('窗控调用失败不会冒出未处理的 rejection', async () => {
    const windowControl = vi.fn(async () => {
      throw new Error('主进程重启中')
    })
    window.aether = makeAether({ windowControl })
    const errors: unknown[] = []
    const onError = (event: unknown): void => {
      errors.push(event)
    }
    window.addEventListener('unhandledrejection', onError)

    render(<TitleBar />)
    await userEvent.click(screen.getByRole('button', { name: copy.window.close }))
    // 让微任务队列排空：抛出的 rejection 若没被 catch 会在这里冒出来。
    await Promise.resolve()
    await Promise.resolve()

    window.removeEventListener('unhandledrejection', onError)
    expect(errors).toEqual([])
  })
})

/**
 * 拖动区两条规则只能在 CSS 层验证：jsdom 没有 `-webkit-app-region` 的命中测试，
 * 渲染出来的元素也不会真的被系统拖走。这两条规则缺失时窗口**完全拖不动**，
 * 或者三个按钮全部点不动，所以必须钉住。
 */
describe('标题栏拖动区（CSS 级）', () => {
  it('标题栏是拖动区', () => {
    const body = ruleBody('.titlebar')
    expect(body).not.toBeNull()
    expect(body).toMatch(/-webkit-app-region:\s*drag/)
  })

  it('按钮容器退出拖动区，否则点击会被拖动吞掉', () => {
    const body = ruleBody('.titlebar-buttons')
    expect(body).not.toBeNull()
    expect(body).toMatch(/-webkit-app-region:\s*no-drag/)
  })

  it('标题栏高度来自 token，不写裸 px', () => {
    const body = ruleBody('.titlebar')
    expect(body).toContain('height: var(--titlebar-height)')
  })
})
