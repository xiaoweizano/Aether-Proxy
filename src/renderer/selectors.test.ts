import { describe, expect, it } from 'vitest'
import type { ProxyGroupView } from '../shared/ipc'
import { pickActiveProxy } from './selectors'

/**
 * 默认值与真实 `/proxies` 响应一致：手选组是 `Selector`（Go 类型名），
 * 不是 YAML 里的 `select`。
 */
function group(overrides: Partial<ProxyGroupView>): ProxyGroupView {
  return { name: 'Proxy', type: 'Selector', now: '', nodes: [], ...overrides }
}

describe('pickActiveProxy', () => {
  it('空列表返回 null', () => {
    expect(pickActiveProxy([])).toBeNull()
  })

  it('没有任何已选节点时返回 null', () => {
    expect(
      pickActiveProxy([
        group({ name: 'Proxy', now: '' }),
        group({ name: 'Auto', type: 'URLTest', now: '' })
      ])
    ).toBeNull()
  })

  it('优先选中手选组，即使自动组排在它前面', () => {
    const groups = [
      group({ name: 'Auto', type: 'URLTest', now: 'US-01' }),
      group({
        name: 'Proxy',
        type: 'Selector',
        now: 'HK-01',
        nodes: [
          { name: 'HK-01', delay: 38 },
          { name: 'US-01', delay: 120 }
        ]
      })
    ]

    expect(pickActiveProxy(groups)).toEqual({ group: 'Proxy', node: 'HK-01', delay: 38 })
  })

  it('真实形状：Proxy(Selector) / Auto(URLTest) / GLOBAL(Selector) 选中 Proxy', () => {
    // 来自 test/fixtures/proxies.json 的映射结果：GLOBAL 总在最前且 now 已设置，
    // 但它是全局模式的结果，不能当作普通配置下的「当前节点」。
    const groups: ProxyGroupView[] = [
      {
        name: 'GLOBAL',
        type: 'Selector',
        now: 'DIRECT',
        nodes: [{ name: 'Proxy' }, { name: 'Auto' }, { name: 'DIRECT' }]
      },
      {
        name: 'Auto',
        type: 'URLTest',
        now: 'DIRECT',
        nodes: [{ name: 'HK-01', delay: 41 }, { name: 'US-01', delay: 120 }, { name: 'DIRECT' }]
      },
      {
        name: 'Proxy',
        type: 'Selector',
        now: 'HK-01',
        nodes: [
          { name: 'HK-01', delay: 41 },
          { name: 'US-01', delay: 120 },
          { name: 'Auto' },
          { name: 'DIRECT' }
        ]
      }
    ]

    expect(pickActiveProxy(groups)).toEqual({ group: 'Proxy', node: 'HK-01', delay: 41 })
  })

  it('排除 GLOBAL 后没有其它已选组时返回 null', () => {
    expect(
      pickActiveProxy([
        group({ name: 'GLOBAL', type: 'Selector', now: 'DIRECT', nodes: [{ name: 'DIRECT' }] })
      ])
    ).toBeNull()
  })

  it('兼容小写 select 与 selector 两种写法', () => {
    for (const type of ['select', 'selector', 'SELECTOR']) {
      const groups = [
        group({ name: 'Auto', type: 'URLTest', now: 'US-01' }),
        group({ name: 'Proxy', type, now: 'HK-01', nodes: [{ name: 'HK-01', delay: 38 }] })
      ]
      expect(pickActiveProxy(groups)).toEqual({ group: 'Proxy', node: 'HK-01', delay: 38 })
    }
  })

  it('没有手选组时退回第一个已选组', () => {
    const groups = [
      group({ name: 'Auto', type: 'URLTest', now: 'US-01', nodes: [{ name: 'US-01', delay: 90 }] }),
      group({ name: 'Fallback', type: 'Fallback', now: 'HK-01' })
    ]

    expect(pickActiveProxy(groups)).toEqual({ group: 'Auto', node: 'US-01', delay: 90 })
  })

  it('节点没有延迟数据时不带 delay 字段', () => {
    const groups = [group({ name: 'Proxy', now: 'HK-01', nodes: [{ name: 'HK-01' }] })]

    const active = pickActiveProxy(groups)
    expect(active).toEqual({ group: 'Proxy', node: 'HK-01' })
    expect(active?.delay).toBeUndefined()
  })

  it('手选组没有 now 时不会挡住后面的组', () => {
    const groups = [
      group({ name: 'Empty', now: '' }),
      group({ name: 'Auto', type: 'URLTest', now: 'JP', nodes: [{ name: 'JP', delay: 55 }] })
    ]

    expect(pickActiveProxy(groups)).toEqual({ group: 'Auto', node: 'JP', delay: 55 })
  })
})
