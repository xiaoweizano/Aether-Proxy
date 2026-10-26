import { describe, it, expect } from 'vitest'
import { mergeConfig } from './merge'

const inject = { mixedPort: 5566, controllerPort: 5567, secret: 'abc123' }

describe('mergeConfig', () => {
  it('rules 前后插入，顺序正确', () => {
    const out = mergeConfig(
      { rules: ['MATCH,DIRECT'] },
      { rules: { prepend: ['DOMAIN,a.com,DIRECT'], append: ['GEOIP,CN,DIRECT'] } },
      inject
    )
    expect(out.rules).toEqual(['DOMAIN,a.com,DIRECT', 'MATCH,DIRECT', 'GEOIP,CN,DIRECT'])
  })

  it('proxies 与 proxy-groups 按 name 合并，同名整条替换', () => {
    const out = mergeConfig(
      { proxies: [{ name: 'HK', type: 'ss', server: 'old' }], 'proxy-groups': [{ name: 'Proxy', type: 'select', proxies: ['HK'] }] },
      { proxies: [{ name: 'HK', type: 'ss', server: 'new' }] },
      inject
    )
    expect(out.proxies).toEqual([{ name: 'HK', type: 'ss', server: 'new' }])
    expect((out['proxy-groups'] as any[])[0].proxies).toEqual(['HK'])
  })

  it('dns 深合并，nameserver-policy 按 key 合并', () => {
    const out = mergeConfig(
      { dns: { enable: true, 'nameserver-policy': { 'geosite:cn': '223.5.5.5' } } },
      { dns: { 'nameserver-policy': { 'geosite:geolocation-!cn': '1.1.1.1' } } },
      inject
    ) as any
    expect(out.dns.enable).toBe(true)
    expect(out.dns['nameserver-policy']).toEqual({
      'geosite:cn': '223.5.5.5',
      'geosite:geolocation-!cn': '1.1.1.1'
    })
  })

  it('强制关闭 tun 并清空 redir/tproxy', () => {
    const out = mergeConfig(
      { tun: { enable: true, stack: 'gvisor' }, 'redir-port': 7892, 'tproxy-port': 7893 },
      {},
      inject
    ) as any
    expect(out.tun.enable).toBe(false)
    expect(out.tun.stack).toBe('gvisor')
    expect(out['redir-port']).toBeUndefined()
    expect(out['tproxy-port']).toBeUndefined()
  })

  it('注入端口、控制器、secret 与 find-process-mode', () => {
    const out = mergeConfig({ 'mixed-port': 7890 }, {}, inject) as any
    expect(out['mixed-port']).toBe(5566)
    expect(out['external-controller']).toBe('127.0.0.1:5567')
    expect(out.secret).toBe('abc123')
    expect(out['find-process-mode']).toBe('always')
  })

  it('proxy-providers / rule-providers 按 name 合并（对象 map，不是数组）', () => {
    const out = mergeConfig(
      { 'proxy-providers': { 'prov-a': { type: 'http' } } },
      { 'proxy-providers': { 'prov-b': { type: 'file' } }, 'rule-providers': { 'rp-a': { type: 'http' } } },
      inject
    ) as any
    expect(Object.keys(out['proxy-providers']).sort()).toEqual(['prov-a', 'prov-b'])
    expect(out['rule-providers']).toEqual({ 'rp-a': { type: 'http' } })
  })

  it('未知顶层键原样透传', () => {
    const out = mergeConfig({ 'geodata-mode': true }, {}, inject) as any
    expect(out['geodata-mode']).toBe(true)
  })
})
