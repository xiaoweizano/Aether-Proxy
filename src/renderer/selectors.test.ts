import { describe, expect, it } from 'vitest'
import type { ProxyGroupView } from '../shared/ipc'
import { UNKNOWN } from './format'
import {
  connectionDurationMs,
  connectionHeaders,
  connectionHost,
  filterConnections,
  formatDestination,
  formatOutbound,
  formatRule,
  isRejectedConnection,
  pickActiveProxy,
  sortConnections,
  truncateMiddle
} from './selectors'
import { makeConnection } from './test-utils'

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

describe('truncateMiddle', () => {
  it('短域名原样返回', () => {
    expect(truncateMiddle('api.anthropic.com')).toBe('api.anthropic.com')
    expect(truncateMiddle('cdn.jsdelivr.net')).toBe('cdn.jsdelivr.net')
  })

  it('超长时保留头尾，总长不超过上限', () => {
    const value = 'very-long-subdomain.service.example.com'
    const result = truncateMiddle(value, 24)

    expect(result.length).toBeLessThanOrEqual(24)
    expect(result).toContain('…')
    expect(result.startsWith(value.slice(0, 6))).toBe(true)
    expect(result.endsWith(value.slice(-6))).toBe(true)
  })

  it('恰好等于上限时不截断', () => {
    expect(truncateMiddle('a'.repeat(24), 24)).toBe('a'.repeat(24))
  })

  it('上限极小时也不会把整串拼回来', () => {
    expect(truncateMiddle('abcdef', 2)).toBe('a…')
    expect(truncateMiddle('abcdef', 1)).toBe('…')
  })

  it('按码点截断：不会把 emoji 劈成半个', () => {
    const value = `${'😀'.repeat(10)}.example.com`
    const result = truncateMiddle(value, 6)

    expect(result).toBe('😀😀😀…om')
    expect(result).not.toContain('�')
    // 没有落单的代理项。
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(result)).toBe(
      false
    )
  })
})

describe('formatOutbound', () => {
  it('多段链路取首尾两段并省略中间', () => {
    expect(formatOutbound(['Proxy', 'Auto', 'HK'])).toBe('Proxy ▸ … ▸ HK')
  })

  it('两段链路没有可省略的中间段', () => {
    expect(formatOutbound(['Proxy', 'HK'])).toBe('Proxy ▸ HK')
  })

  it('单段直出', () => {
    expect(formatOutbound(['DIRECT'])).toBe('DIRECT')
  })

  it('空数组显示未知', () => {
    expect(formatOutbound([])).toBe(UNKNOWN)
  })

  it('已反转的数组不再反转：首段就是最外层策略组', () => {
    // Task 1 已把内核原始的 ['HK','Auto','Proxy'] 反转成 ['Proxy','Auto','HK']。
    // 这里再反转一次就会显示成 HK ▸ … ▸ Proxy。
    expect(formatOutbound(['Proxy', 'Auto', 'HK'])).toBe('Proxy ▸ … ▸ HK')
    expect(formatOutbound(['HK', 'Auto', 'Proxy'])).toBe('HK ▸ … ▸ Proxy')
  })
})

describe('formatRule', () => {
  it('规则与负载写成 DomainSuffix(github.com)', () => {
    expect(formatRule('DomainSuffix', 'github.com')).toBe('DomainSuffix(github.com)')
  })

  it('负载为空时只显示规则名', () => {
    expect(formatRule('Match', null)).toBe('Match')
    expect(formatRule('Match', '')).toBe('Match')
  })

  it('规则缺失时显示未知，绝不拼出空括号', () => {
    expect(formatRule(null, 'github.com')).toBe(UNKNOWN)
    expect(formatRule('', 'github.com')).toBe(UNKNOWN)
  })
})

describe('formatDestination', () => {
  it('IP 与端口齐全时拼成 ip:port', () => {
    expect(formatDestination('140.82.112.3', '443')).toBe('140.82.112.3:443')
  })

  it('端口未知时只显示 IP，不编造端口', () => {
    expect(formatDestination('140.82.112.3', null)).toBe('140.82.112.3')
  })

  it('IP 缺失时整体是未知，端口单独出现没有意义', () => {
    expect(formatDestination(null, '443')).toBe(UNKNOWN)
    expect(formatDestination(null, null)).toBe(UNKNOWN)
  })
})

describe('isRejectedConnection', () => {
  it('REJECT 与 REJECT-DROP 都算被拒绝', () => {
    expect(isRejectedConnection({ chains: ['Proxy', 'REJECT'] })).toBe(true)
    expect(isRejectedConnection({ chains: ['REJECT-DROP'] })).toBe(true)
  })

  it('直连与普通策略链不算被拒绝', () => {
    expect(isRejectedConnection({ chains: ['DIRECT'] })).toBe(false)
    expect(isRejectedConnection({ chains: ['Proxy', 'HK-01'] })).toBe(false)
    expect(isRejectedConnection({ chains: [] })).toBe(false)
  })
})

describe('connectionHost', () => {
  it('优先 host', () => {
    expect(connectionHost({ host: 'github.com', destinationIp: '1.1.1.1' })).toBe('github.com')
  })

  it('host 缺失时退回目标 IP', () => {
    expect(connectionHost({ host: null, destinationIp: '1.1.1.1' })).toBe('1.1.1.1')
  })

  it('两者都缺显示未知', () => {
    expect(connectionHost({ host: null, destinationIp: null })).toBe(UNKNOWN)
  })
})

describe('connectionDurationMs', () => {
  const now = 10_000

  it('活跃连接用当前时刻减建立时刻', () => {
    expect(connectionDurationMs(makeConnection({ startedAt: 4_000 }), now)).toBe(6_000)
  })

  it('已结束连接冻结在 endedAt，不随 now 前进', () => {
    const ended = makeConnection({ startedAt: 4_000, ended: true, endedAt: 7_000 })
    expect(connectionDurationMs(ended, now)).toBe(3_000)
    expect(connectionDurationMs(ended, now + 60_000)).toBe(3_000)
  })

  it('建立时刻未知时返回 null', () => {
    expect(connectionDurationMs(makeConnection({ startedAt: null }), now)).toBeNull()
  })

  it('时钟早于建立时刻或 now 未知时不伪造时长', () => {
    expect(connectionDurationMs(makeConnection({ startedAt: 20_000 }), now)).toBeNull()
    expect(connectionDurationMs(makeConnection({ startedAt: 4_000 }), null)).toBeNull()
  })
})

describe('filterConnections', () => {
  const chromeGithub = makeConnection({
    id: 'a',
    process: 'chrome',
    host: 'github.com',
    destinationIp: '140.82.112.3'
  })
  const codeAnthropic = makeConnection({
    id: 'b',
    process: 'Code',
    host: 'api.anthropic.com',
    destinationIp: '160.79.104.10'
  })
  const ended = makeConnection({ id: 'c', process: 'QQ', host: 'img.qq.com', ended: true, endedAt: 1 })
  const items = [chromeGithub, codeAnthropic, ended]

  it('空查询与关闭开关时原样返回', () => {
    expect(filterConnections(items, { query: '  ', activeOnly: false })).toEqual(items)
  })

  it('搜索域名不区分大小写', () => {
    expect(filterConnections(items, { query: 'GITHUB', activeOnly: false })).toEqual([chromeGithub])
  })

  it('搜索进程名不区分大小写', () => {
    expect(filterConnections(items, { query: 'cOdE', activeOnly: false })).toEqual([codeAnthropic])
  })

  it('host 缺失时用目标 IP 参与搜索', () => {
    const byIp = makeConnection({ id: 'd', host: null, destinationIp: '203.0.113.9' })
    expect(filterConnections([byIp], { query: '203.0.113', activeOnly: false })).toEqual([byIp])
  })

  it('只看活跃会去掉已结束的连接', () => {
    expect(filterConnections(items, { query: '', activeOnly: true })).toEqual([
      chromeGithub,
      codeAnthropic
    ])
  })
})

describe('sortConnections', () => {
  const newer = makeConnection({ id: 'newer', startedAt: 2_000 })
  const older = makeConnection({ id: 'older', startedAt: 1_000 })
  const unknown = makeConnection({ id: 'unknown', startedAt: null })

  it('默认倒序：最新在前', () => {
    expect(sortConnections([older, newer], 'desc').map((item) => item.id)).toEqual([
      'newer',
      'older'
    ])
  })

  it('正序：最早在前', () => {
    expect(sortConnections([newer, older], 'asc').map((item) => item.id)).toEqual([
      'older',
      'newer'
    ])
  })

  it('建立时刻未知的条目无论方向都排在最后', () => {
    expect(sortConnections([unknown, older, newer], 'desc').map((item) => item.id)).toEqual([
      'newer',
      'older',
      'unknown'
    ])
    expect(sortConnections([unknown, newer, older], 'asc').map((item) => item.id)).toEqual([
      'older',
      'newer',
      'unknown'
    ])
  })

  it('不修改输入数组', () => {
    const input = [older, newer]
    sortConnections(input, 'desc')
    expect(input).toEqual([older, newer])
  })

  it('建立时刻相同的条目保持输入顺序（两次快照的副本也不换位）', () => {
    const first = makeConnection({ id: 'same-1', startedAt: 1_000 })
    const second = makeConnection({ id: 'same-2', startedAt: 1_000 })

    const snapshotA = sortConnections([first, second], 'desc').map((item) => item.id)
    // 下一次快照会给每条连接新的对象与 chains 副本，但插入顺序不变。
    const snapshotB = sortConnections(
      [{ ...first, chains: [...first.chains] }, { ...second, chains: [...second.chains] }],
      'desc'
    ).map((item) => item.id)

    expect(snapshotA).toEqual(['same-1', 'same-2'])
    expect(snapshotB).toEqual(snapshotA)
  })
})

describe('connectionHeaders', () => {
  it('六列顺序与设计文档一致', () => {
    expect(connectionHeaders).toEqual(['time', 'process', 'host', 'outbound', 'traffic', 'duration'])
  })
})
