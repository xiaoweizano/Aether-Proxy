import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ProxyGroupView } from '../../shared/ipc'
import { copy } from '../copy'
import { UNKNOWN } from '../format'
import { makeAether } from '../test-utils'
import { NodesPage } from './NodesPage'

/** 默认值与真实 `/proxies` 一致：手选组是 Go 类型名 `Selector`。 */
function group(overrides: Partial<ProxyGroupView>): ProxyGroupView {
  return { name: 'Proxy', type: 'Selector', now: '', nodes: [], ...overrides }
}

const PROXY = group({
  name: 'Proxy',
  now: 'HK-01',
  nodes: [
    { name: 'HK-01', delay: 38 },
    { name: 'US-01', delay: 120 }
  ]
})

const AUTO = group({
  name: 'Auto',
  type: 'URLTest',
  now: 'JP-01',
  nodes: [
    { name: 'JP-01', delay: 85 },
    // 从没测过速的节点：延迟必须是未知，不能显示 0ms。
    { name: 'SG-01' }
  ]
})

const GLOBAL = group({
  name: 'GLOBAL',
  now: 'Proxy',
  nodes: [{ name: 'DIRECT' }, { name: 'Proxy' }]
})

function mount(groups: ProxyGroupView[] = [PROXY, AUTO]) {
  const switchNode = vi.fn(async () => ({ ok: true, status: 204 }))
  window.aether = makeAether({ switchNode })
  const view = render(<NodesPage groups={groups} />)
  return { ...view, switchNode }
}

/** 组头与节点按钮同在一个按钮上，名字里含节点计数，用前缀匹配。 */
function groupHead(name: string): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(`^${name}`) })
}

describe('NodesPage', () => {
  it('按策略组分组渲染各自的节点', () => {
    mount()

    expect(groupHead('Proxy')).toHaveAttribute('aria-expanded', 'true')
    expect(groupHead('Auto')).toHaveAttribute('aria-expanded', 'true')

    const proxy = screen.getByRole('button', { name: /^Proxy/ }).closest('.node-group')
    expect(proxy).not.toBeNull()
    expect(within(proxy as HTMLElement).getByRole('button', { name: /HK-01/ })).toBeInTheDocument()
    expect(within(proxy as HTMLElement).getByRole('button', { name: /US-01/ })).toBeInTheDocument()

    expect(screen.getByRole('button', { name: /JP-01/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /SG-01/ })).toBeInTheDocument()
    // 节点是真正的按钮，键盘可达。
    expect(screen.getAllByRole('button')).toHaveLength(6)
  })

  it('点击节点用该组与该节点名调用 switchNode', async () => {
    const { switchNode } = mount()

    await userEvent.click(screen.getByRole('button', { name: /US-01/ }))

    expect(switchNode).toHaveBeenCalledTimes(1)
    expect(switchNode).toHaveBeenCalledWith({ group: 'Proxy', node: 'US-01' })
  })

  it('切换失败时显示一行错误，选中态保持内核给的值', async () => {
    const switchNode = vi.fn(async () => ({ ok: false, status: 503 }))
    window.aether = makeAether({ switchNode })
    render(<NodesPage groups={[PROXY]} />)

    await userEvent.click(screen.getByRole('button', { name: /US-01/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent(copy.nodes.switchFailed)
    expect(screen.getByRole('button', { name: /HK-01/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /US-01/ })).toHaveAttribute('aria-pressed', 'false')
  })

  it('IPC 抛错时同样显示错误而不是未捕获拒绝', async () => {
    const switchNode = vi.fn(async () => {
      throw new Error('boom')
    })
    window.aether = makeAether({ switchNode })
    render(<NodesPage groups={[PROXY]} />)

    await userEvent.click(screen.getByRole('button', { name: /US-01/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent(copy.nodes.switchFailed)
  })

  it('GLOBAL 默认折叠，点组头展开', async () => {
    mount([GLOBAL, PROXY])

    const global = groupHead('GLOBAL')
    expect(global).toHaveAttribute('aria-expanded', 'false')
    // 折叠时节点不在无障碍树里，键盘也到不了。
    expect(screen.queryByRole('button', { name: /DIRECT/ })).toBeNull()

    await userEvent.click(global)

    expect(groupHead('GLOBAL')).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: /DIRECT/ })).toBeInTheDocument()
  })

  it('没有测速记录的节点延迟显示破折号', () => {
    mount([AUTO])

    const unknown = screen.getByRole('button', { name: /SG-01/ })
    expect(within(unknown).getByText(UNKNOWN)).toBeInTheDocument()
    expect(unknown.textContent).not.toContain('0ms')

    expect(screen.getByRole('button', { name: /JP-01/ }).textContent).toContain('85ms')
  })

  it('选中态来自 now，不做乐观更新', async () => {
    const { rerender, switchNode } = mount([PROXY])

    await userEvent.click(screen.getByRole('button', { name: /US-01/ }))

    expect(switchNode).toHaveBeenCalledWith({ group: 'Proxy', node: 'US-01' })
    // 切换成功只是写进内核；界面等下一次轮询的 now，不自己改选中态。
    expect(screen.getByRole('button', { name: /HK-01/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /US-01/ })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByRole('alert')).toBeNull()

    rerender(<NodesPage groups={[{ ...PROXY, now: 'US-01' }]} />)

    expect(screen.getByRole('button', { name: /US-01/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /HK-01/ })).toHaveAttribute('aria-pressed', 'false')
  })

  it('URLTest 组里切换后内核只改 fixed：选中态跟随 fixed，而不是一直停在 now', async () => {
    const { rerender, switchNode } = mount([AUTO])

    await userEvent.click(screen.getByRole('button', { name: /SG-01/ }))

    expect(switchNode).toHaveBeenCalledWith({ group: 'Auto', node: 'SG-01' })
    // 切换成功后：PUT 返回 204，now 仍是 JP-01，fixed 变成 SG-01。
    rerender(<NodesPage groups={[{ ...AUTO, fixed: 'SG-01' }]} />)

    expect(screen.getByRole('button', { name: /SG-01/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /JP-01/ })).toHaveAttribute('aria-pressed', 'false')
  })

  it('fixed 为空串时退回 now；两者都没有时没有选中行', () => {
    const { rerender } = mount([{ ...AUTO, fixed: '' }])

    expect(screen.getByRole('button', { name: /JP-01/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /SG-01/ })).toHaveAttribute('aria-pressed', 'false')

    rerender(<NodesPage groups={[{ ...AUTO, now: '', fixed: '' }]} />)

    expect(screen.getByRole('button', { name: /JP-01/ })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: /SG-01/ })).toHaveAttribute('aria-pressed', 'false')
  })

  it('轮询换了一组新对象后，手动展开的 GLOBAL 仍然展开', async () => {
    const { rerender } = mount([GLOBAL, PROXY])

    await userEvent.click(groupHead('GLOBAL'))
    expect(groupHead('GLOBAL')).toHaveAttribute('aria-expanded', 'true')

    // 模拟下一次 getProxies：每次都是新数组、新对象。
    rerender(<NodesPage groups={[{ ...GLOBAL }, { ...PROXY }]} />)

    expect(groupHead('GLOBAL')).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: /DIRECT/ })).toBeInTheDocument()
  })

  it('没有策略组时显示空状态', () => {
    mount([])

    expect(screen.getByText(copy.nodes.empty)).toBeInTheDocument()
  })
})
