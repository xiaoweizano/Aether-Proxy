import { describe, expect, it } from 'vitest'
import type { ProxyGroupView } from '../shared/ipc'
import { pickActiveProxy } from './selectors'

function group(overrides: Partial<ProxyGroupView>): ProxyGroupView {
  return { name: 'Proxy', type: 'select', now: '', nodes: [], ...overrides }
}

describe('pickActiveProxy', () => {
  it('空列表返回 null', () => {
    expect(pickActiveProxy([])).toBeNull()
  })

  it('没有任何已选节点时返回 null', () => {
    expect(
      pickActiveProxy([
        group({ name: 'Proxy', now: '' }),
        group({ name: 'Auto', type: 'url-test', now: '' })
      ])
    ).toBeNull()
  })

  it('优先选中的 select 组，即使它排在后面', () => {
    const groups = [
      group({ name: 'Auto', type: 'url-test', now: 'US' }),
      group({
        name: 'Proxy',
        type: 'select',
        now: 'HK-01',
        nodes: [
          { name: 'HK-01', delay: 38 },
          { name: 'US', delay: 120 }
        ]
      })
    ]

    expect(pickActiveProxy(groups)).toEqual({ group: 'Proxy', node: 'HK-01', delay: 38 })
  })

  it('没有 select 组时退回第一个已选组', () => {
    const groups = [
      group({ name: 'Auto', type: 'url-test', now: 'US', nodes: [{ name: 'US', delay: 90 }] }),
      group({ name: 'Fallback', type: 'fallback', now: 'HK' })
    ]

    expect(pickActiveProxy(groups)).toEqual({ group: 'Auto', node: 'US', delay: 90 })
  })

  it('节点没有延迟数据时不带 delay 字段', () => {
    const groups = [group({ name: 'Proxy', now: 'HK-01', nodes: [{ name: 'HK-01' }] })]

    const active = pickActiveProxy(groups)
    expect(active).toEqual({ group: 'Proxy', node: 'HK-01' })
    expect(active?.delay).toBeUndefined()
  })

  it('select 组没有 now 时不会挡住后面的组', () => {
    const groups = [
      group({ name: 'Empty', type: 'select', now: '' }),
      group({ name: 'Auto', type: 'url-test', now: 'JP', nodes: [{ name: 'JP', delay: 55 }] })
    ]

    expect(pickActiveProxy(groups)).toEqual({ group: 'Auto', node: 'JP', delay: 55 })
  })
})
