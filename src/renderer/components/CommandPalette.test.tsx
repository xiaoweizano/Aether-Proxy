import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppStatusView, ProxyGroupView } from '../../shared/ipc'
import { copy } from '../copy'
import { makeAether, readyStatus } from '../test-utils'
import { CommandPalette } from './CommandPalette'

/** 手选组在前：`pickActiveProxy` 会优先取它，复制动作因此得到 HK-01。 */
const GROUPS: ProxyGroupView[] = [
  {
    name: 'Proxy',
    type: 'Selector',
    now: 'HK-01',
    nodes: [
      { name: 'HK-01', delay: 38 },
      { name: 'US-01', delay: 120 }
    ]
  },
  {
    name: 'Auto',
    type: 'URLTest',
    now: 'JP-01',
    nodes: [{ name: 'JP-01', delay: 85 }]
  }
]

interface MountOptions {
  groups?: ProxyGroupView[]
  status?: AppStatusView
}

function mount(options: MountOptions = {}) {
  const onNavigate = vi.fn()
  const onRefresh = vi.fn()
  render(
    <>
      <button type="button">触发</button>
      <CommandPalette
        groups={options.groups ?? GROUPS}
        status={options.status ?? readyStatus}
        onNavigate={onNavigate}
        onRefresh={onRefresh}
      />
    </>
  )
  return { onNavigate, onRefresh }
}

async function openPalette(): Promise<HTMLElement> {
  await userEvent.keyboard('{Control>}k{/Control}')
  return screen.getByRole('combobox', { name: copy.palette.inputLabel })
}

/** 输入完整标题把目标动作筛成唯一一项，再回车执行。 */
async function runAction(title: string): Promise<void> {
  const input = await openPalette()
  await userEvent.type(input, title)
  await userEvent.keyboard('{Enter}')
}

describe('CommandPalette', () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'clipboard')
  })

  it('Ctrl+K 打开面板，焦点落在输入框', async () => {
    mount()

    const input = await openPalette()

    const dialog = screen.getByRole('dialog', { name: copy.palette.label })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(input).toHaveFocus()
    expect(input).toHaveAttribute('aria-expanded', 'true')
  })

  it('打开后输入节点名过滤列表，不区分大小写', async () => {
    mount()
    const input = await openPalette()

    await userEvent.type(input, 'hk')

    expect(screen.getByRole('option', { name: /HK-01/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /US-01/ })).toBeNull()
    expect(screen.queryByRole('option', { name: /JP-01/ })).toBeNull()
    // 动作标题不含查询词，同样被筛掉。
    expect(screen.queryByRole('option', { name: copy.palette.actions.restartCore })).toBeNull()
  })

  it('输入动作标题时只保留匹配的动作，节点结果为空', async () => {
    mount()
    const input = await openPalette()

    await userEvent.type(input, '重启')

    expect(screen.getByRole('option', { name: copy.palette.actions.restartCore })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /HK-01/ })).toBeNull()
  })

  it('↑↓ 移动高亮，Enter 在节点上用该组与节点名调用 switchNode 并关闭', async () => {
    const switchNode = vi.fn(async () => ({ ok: true, status: 204 }))
    window.aether = makeAether({ switchNode })
    mount()
    const input = await openPalette()

    // 空查询下动作在前；输入 jp 后只剩 Auto 组里的 JP-01。
    await userEvent.type(input, 'jp')
    expect(screen.getByRole('option', { name: /JP-01/ })).toHaveAttribute('aria-selected', 'true')

    await userEvent.keyboard('{Enter}')

    expect(switchNode).toHaveBeenCalledWith({ group: 'Auto', node: 'JP-01' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('↑↓ 在多个结果之间移动高亮，并在两端停住', async () => {
    mount()
    const input = await openPalette()

    await userEvent.type(input, '0')
    // Proxy / Auto 两个组里共有 HK-01 / US-01 / JP-01 三条，仍应只有一个高亮。
    const options = screen.getAllByRole('option')
    expect(options.length).toBeGreaterThan(1)
    expect(options[0]).toHaveAttribute('aria-selected', 'true')

    await userEvent.keyboard('{ArrowDown}')
    expect(options[0]).toHaveAttribute('aria-selected', 'false')
    expect(options[1]).toHaveAttribute('aria-selected', 'true')

    await userEvent.keyboard('{ArrowUp}')
    expect(options[0]).toHaveAttribute('aria-selected', 'true')

    // 顶部继续按 ↑ 停在第一项；多次 ↓ 也不会越过最后一项。
    await userEvent.keyboard('{ArrowUp}')
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    for (let step = 0; step < options.length + 2; step += 1) {
      await userEvent.keyboard('{ArrowDown}')
    }
    expect(options[options.length - 1]).toHaveAttribute('aria-selected', 'true')
  })

  it('Esc 关闭面板并把焦点还给打开前的元素', async () => {
    mount()
    const trigger = screen.getByRole('button', { name: '触发' })
    trigger.focus()
    expect(trigger).toHaveFocus()

    await openPalette()
    expect(screen.getByRole('combobox')).toHaveFocus()

    await userEvent.keyboard('{Escape}')

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(trigger).toHaveFocus()
  })

  it('点击遮罩关闭，点击面板内部不关闭', async () => {
    mount()
    await openPalette()

    const dialog = screen.getByRole('dialog')
    const backdrop = dialog.parentElement as HTMLElement
    await userEvent.click(dialog)
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    await userEvent.click(backdrop)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Tab 在面板内循环，不会跑到下层页面', async () => {
    mount()
    const input = await openPalette()

    await userEvent.tab()
    expect(input).toHaveFocus()
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    await userEvent.tab({ shift: true })
    expect(input).toHaveFocus()
  })

  it('关闭状态下不拦截 Ctrl+K 之外的按键', async () => {
    mount()
    const listener = vi.fn()
    window.addEventListener('keydown', listener)

    try {
      await userEvent.keyboard('k')
      await userEvent.keyboard('{Control>}j{/Control}')
      await userEvent.keyboard('{Escape}')

      expect(screen.queryByRole('dialog')).toBeNull()
      // 面板的监听器没有把事件吃掉：页面自己的监听器仍能收到每次按键。
      expect(listener).toHaveBeenCalled()
      for (const call of listener.mock.calls) {
        const event = call[0] as KeyboardEvent
        expect(event.defaultPrevented).toBe(false)
      }
    } finally {
      window.removeEventListener('keydown', listener)
    }
  })

  it('「开启系统代理」在代理关闭时调用 enableProxy 并刷新状态', async () => {
    const enableProxy = vi.fn(async () => ({ ok: true }))
    window.aether = makeAether({ enableProxy })
    const { onRefresh } = mount({ status: { ...readyStatus, proxyEnabled: false } })

    await runAction(copy.palette.actions.proxyOn)

    expect(enableProxy).toHaveBeenCalledTimes(1)
    expect(onRefresh).toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('「关闭系统代理」在代理开启时调用 disableProxy', async () => {
    const disableProxy = vi.fn(async () => ({ ok: true }))
    window.aether = makeAether({ disableProxy })
    mount({ status: { ...readyStatus, proxyEnabled: true } })

    await runAction(copy.palette.actions.proxyOff)

    expect(disableProxy).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['rule', copy.mode.rule],
    ['global', copy.mode.global],
    ['direct', copy.mode.direct]
  ] as const)('「切换到%s模式」调用 setMode(%s)', async (mode, label) => {
    const setMode = vi.fn(async () => ({ ok: true, status: 204 }))
    window.aether = makeAether({ setMode })
    mount()

    await runAction(copy.palette.actions.mode(label))

    expect(setMode).toHaveBeenCalledWith(mode)
  })

  it('「重启内核」调用 restartCore 并刷新状态', async () => {
    const restartCore = vi.fn(async () => ({ ok: true }))
    window.aether = makeAether({ restartCore })
    const { onRefresh } = mount()

    await runAction(copy.palette.actions.restartCore)

    expect(restartCore).toHaveBeenCalledTimes(1)
    expect(onRefresh).toHaveBeenCalled()
  })

  it('「打开配置目录」调用 openConfigDir', async () => {
    const openConfigDir = vi.fn(async () => ({ ok: true }))
    window.aether = makeAether({ openConfigDir })
    mount()

    await runAction(copy.palette.actions.openConfigDir)

    expect(openConfigDir).toHaveBeenCalledTimes(1)
  })

  it('「查看日志」导航到日志页', async () => {
    window.aether = makeAether()
    const { onNavigate } = mount()

    await runAction(copy.palette.actions.viewLogs)

    expect(onNavigate).toHaveBeenCalledWith('logs')
  })

  it('「复制当前节点名」写入当前生效的节点名', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    })
    window.aether = makeAether()
    mount()

    await runAction(copy.palette.actions.copyNode)

    expect(writeText).toHaveBeenCalledWith('HK-01')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('剪贴板被拒绝时静默，不出现错误 UI', async () => {
    const writeText = vi.fn(async () => {
      throw new Error('denied')
    })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    })
    window.aether = makeAether()
    mount()

    await runAction(copy.palette.actions.copyNode)
    // 让拒绝的 promise 走完微任务，再确认没有错误界面。
    await Promise.resolve()
    await Promise.resolve()

    expect(writeText).toHaveBeenCalledWith('HK-01')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText(copy.nodes.switchFailed)).toBeNull()
  })

  it('没有匹配结果时显示空状态，Enter 不执行任何动作', async () => {
    window.aether = makeAether()
    mount()
    const input = await openPalette()

    await userEvent.type(input, 'zzz')
    expect(screen.getByText(copy.palette.empty)).toBeInTheDocument()

    await userEvent.keyboard('{Enter}')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})
