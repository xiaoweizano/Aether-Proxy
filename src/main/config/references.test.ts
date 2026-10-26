import { describe, it, expect } from 'vitest'
import { missingReferences } from './references'

describe('missingReferences', () => {
  it('引用存在的节点时不报错，组名互引也合法', () => {
    const cfg = {
      proxies: [{ name: 'HK' }],
      'proxy-groups': [
        { name: 'Proxy', proxies: ['HK', 'DIRECT'] },
        { name: 'Auto', proxies: ['Proxy'] }
      ]
    }
    expect(missingReferences(cfg)).toEqual([])
  })

  it('引用不存在的节点时报出组名与缺失名', () => {
    const cfg = {
      proxies: [{ name: 'HK' }],
      'proxy-groups': [{ name: 'Proxy', proxies: ['HK', 'JP-99'] }]
    }
    expect(missingReferences(cfg)).toEqual(['Proxy:JP-99'])
  })

  it('use 引用不存在的 provider 时报错', () => {
    const cfg = {
      proxies: [],
      'proxy-providers': { 'prov-a': {} },
      'proxy-groups': [{ name: 'Auto', use: ['prov-a', 'prov-b'] }]
    }
    expect(missingReferences(cfg)).toEqual(['Auto:provider:prov-b'])
  })
})
