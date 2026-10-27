import { describe, it, expect, vi, afterEach } from 'vitest'
import { ConnectionsCollector, type ConnectionsOptions } from './connections'
import type { ConnectionsSnapshot } from '../shared/ipc'
import type { WebSocketLike } from './ws'

const URL = 'ws://127.0.0.1:9090/connections?interval=500'
const SECRET = 's3cret-token'

type MessageHandler = (data: unknown) => void
type VoidHandler = () => void

/** 只实现采集器用到的三个事件与 close，便于手动推进消息/断线。 */
class FakeSocket implements WebSocketLike {
  readonly messages: MessageHandler[] = []
  readonly closes: VoidHandler[] = []
  readonly errors: ((err: unknown) => void)[] = []
  closed = false

  on(event: 'message', cb: MessageHandler): void
  on(event: 'close', cb: VoidHandler): void
  on(event: 'error', cb: (err: unknown) => void): void
  on(
    event: 'message' | 'close' | 'error',
    cb: MessageHandler | VoidHandler | ((err: unknown) => void)
  ): void {
    if (event === 'message') this.messages.push(cb as MessageHandler)
    else if (event === 'close') this.closes.push(cb as VoidHandler)
    else this.errors.push(cb as (err: unknown) => void)
  }

  close(): void {
    this.closed = true
  }

  push(payload: unknown): void {
    for (const cb of this.messages) cb(payload)
  }

  disconnect(): void {
    for (const cb of this.closes) cb()
  }
}

interface Harness {
  collector: ConnectionsCollector
  sockets: FakeSocket[]
  calls: { url: string; options: { headers: Record<string, string> } }[]
  socket(): FakeSocket
}

function harness(opts: Partial<ConnectionsOptions> = {}): Harness {
  const sockets: FakeSocket[] = []
  const calls: { url: string; options: { headers: Record<string, string> } }[] = []
  const connect = (url: string, options: { headers: Record<string, string> }): WebSocketLike => {
    calls.push({ url, options })
    const socket = new FakeSocket()
    sockets.push(socket)
    return socket
  }
  const collector = new ConnectionsCollector({ url: URL, secret: SECRET, connect, ...opts })
  return {
    collector,
    sockets,
    calls,
    socket() {
      const socket = sockets.at(-1)
      if (socket === undefined) throw new Error('还没有建立连接')
      return socket
    }
  }
}

/** 与 2026-10-27 实测 payload 同形；字段可按用例覆盖。 */
function rawConnection(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    metadata: {
      network: 'tcp',
      type: 'HTTPS',
      sourceIP: '127.0.0.1',
      sourcePort: '7608',
      destinationIP: '',
      destinationPort: '443',
      inboundIP: '127.0.0.1',
      inboundPort: '17891',
      inboundName: 'DEFAULT-MIXED',
      host: `${id}.example.com`,
      dnsMode: 'normal',
      uid: 0,
      process: 'curl.exe',
      processPath: 'D:\\Git\\Git\\mingw64\\bin\\curl.exe',
      remoteDestination: '172.66.147.243',
      sniffHost: ''
    },
    upload: 841,
    download: 5374,
    start: '2026-10-27T11:07:07.5185055+08:00',
    chains: ['DIRECT'],
    providerChains: [''],
    rule: 'Match',
    rulePayload: '',
    ...overrides
  }
}

function frame(connections: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    downloadTotal: 0,
    uploadTotal: 0,
    memory: 27544,
    connections,
    ...extra
  })
}

function idsFrame(ids: string[]): string {
  return frame(ids.map((id) => rawConnection(id)))
}

afterEach(() => {
  vi.useRealTimers()
})

describe('ConnectionsCollector 帧解析', () => {
  it('任何帧到达前也能读快照，memory 为 null 而不是 0', () => {
    const h = harness({ now: () => 1_000 })
    expect(h.collector.snapshot()).toEqual({ items: [], memory: null, at: 1_000 })
    expect(h.calls).toHaveLength(0)
  })

  it('把实测字段映射为视图模型，未知字段被忽略', () => {
    const h = harness({ now: () => 1_000 })
    const raw = rawConnection('x', {
      providerChains: [''],
      UnknownTopLevel: { nested: true },
      metadata: {
        ...(rawConnection('x').metadata as Record<string, unknown>),
        unknownMetadata: 'ignored'
      }
    })
    h.collector.start()
    h.socket().push(frame([raw]))

    // toEqual 是双向比较：视图模型里多出任何未知字段都会失败。
    expect(h.collector.snapshot().items).toEqual([
      {
        id: 'x',
        startedAt: 1793070427518,
        chains: ['DIRECT'],
        rule: 'Match',
        rulePayload: null,
        host: 'x.example.com',
        process: 'curl.exe',
        processPath: 'D:\\Git\\Git\\mingw64\\bin\\curl.exe',
        network: 'tcp',
        destinationIp: null,
        destinationPort: '443',
        sourceIp: '127.0.0.1',
        sourcePort: '7608',
        upload: 841,
        download: 5374,
        ended: false,
        endedAt: null
      }
    ])
  })

  it('chains 反转后存储，单元素数组保持原样', () => {
    const h = harness()
    h.collector.start()
    h.socket().push(
      frame([
        rawConnection('nested', { chains: ['HK-01', 'Auto', 'Proxy'] }),
        rawConnection('direct', { chains: ['DIRECT'] }),
        rawConnection('missing', { chains: undefined })
      ])
    )

    const byId = new Map(h.collector.snapshot().items.map((item) => [item.id, item]))
    expect(byId.get('nested')?.chains).toEqual(['Proxy', 'Auto', 'HK-01'])
    expect(byId.get('direct')?.chains).toEqual(['DIRECT'])
    expect(byId.get('missing')?.chains).toEqual([])
  })

  it('host 为空时退回 remoteDestination，再退回 destinationIP，全空为 null', () => {
    const h = harness()
    h.collector.start()
    h.socket().push(
      frame([
        rawConnection('remote', {
          metadata: { host: '', remoteDestination: '172.66.147.243', destinationIP: '10.0.0.1' }
        }),
        rawConnection('ip', {
          metadata: { host: '', remoteDestination: '', destinationIP: '10.0.0.2' }
        }),
        rawConnection('none', { metadata: { host: '', remoteDestination: '', destinationIP: '' } })
      ])
    )

    const byId = new Map(h.collector.snapshot().items.map((item) => [item.id, item]))
    expect(byId.get('remote')?.host).toBe('172.66.147.243')
    expect(byId.get('ip')?.host).toBe('10.0.0.2')
    expect(byId.get('none')?.host).toBeNull()
  })

  it('到达时间的字符串解析失败时为 null', () => {
    const h = harness()
    h.collector.start()
    h.socket().push(frame([rawConnection('bad', { start: 'not-a-date' }), rawConnection('none', { start: undefined })]))
    expect(h.collector.snapshot().items.map((item) => item.startedAt)).toEqual([null, null])
  })

  it('memory 缺失或类型错误为 null，0 是真实值要保留', () => {
    const h = harness()
    h.collector.start()

    h.socket().push(frame([]))
    expect(h.collector.snapshot().memory).toBe(27544)

    h.socket().push(JSON.stringify({ connections: [] }))
    expect(h.collector.snapshot().memory).toBeNull()

    h.socket().push(JSON.stringify({ connections: [], memory: '27544' }))
    expect(h.collector.snapshot().memory).toBeNull()

    h.socket().push(JSON.stringify({ connections: [], memory: 0 }))
    expect(h.collector.snapshot().memory).toBe(0)
  })

  it('单条坏记录跳过，不影响同一帧里的合法记录', () => {
    const h = harness()
    h.collector.start()
    h.socket().push(
      frame([
        rawConnection('a'),
        null,
        42,
        'x',
        [],
        {},
        { id: '' },
        { id: 7 },
        { id: 'broken', metadata: 'nope', upload: 'x', download: null, chains: 'nope', start: 'bad' },
        rawConnection('z')
      ])
    )

    const items = h.collector.snapshot().items
    expect(items.map((item) => item.id)).toEqual(['a', 'broken', 'z'])
    expect(items[1]).toMatchObject({
      upload: 0,
      download: 0,
      chains: [],
      startedAt: null,
      host: null,
      process: null,
      network: null,
      rule: null
    })
  })

  it('整帧无法解析时忽略，不推送也不改动缓冲', () => {
    const h = harness()
    const seen: ConnectionsSnapshot[] = []
    h.collector.start((s) => seen.push(s))
    h.socket().push(idsFrame(['a']))
    seen.length = 0

    for (const bad of ['not json', '', 'null', '42', '[]', '{}', '{"connections":{}}', '{"connections":null}']) {
      h.socket().push(bad)
    }

    expect(seen).toHaveLength(0)
    expect(h.collector.snapshot().items.map((item) => item.id)).toEqual(['a'])
  })
})

describe('ConnectionsCollector 已结束缓冲', () => {
  it('离开快照的连接标为已结束并保留，60 秒后移除', () => {
    let now = 1_000
    const sent: ConnectionsSnapshot[] = []
    const h = harness({ now: () => now })
    h.collector.start((s) => sent.push(s))

    h.socket().push(idsFrame(['a', 'b']))
    now = 2_000
    h.socket().push(idsFrame(['a']))

    expect(h.collector.snapshot().items.map((item) => [item.id, item.ended, item.endedAt])).toEqual([
      ['a', false, null],
      ['b', true, 2_000]
    ])
    // 保留最后已知流量，界面降权显示时仍能看到它跑过多少。
    expect(h.collector.snapshot().items[1]).toMatchObject({ upload: 841, download: 5374 })

    now = 2_000 + 59_999
    expect(h.collector.snapshot().items.map((item) => item.id)).toEqual(['a', 'b'])
    now += 1
    expect(h.collector.snapshot().items.map((item) => item.id)).toEqual(['a'])

    // 每帧有效快照推一次。
    expect(sent).toHaveLength(2)
    expect(sent[1]?.at).toBe(2_000)
  })

  it('重新出现的连接清除已结束状态与 endedAt', () => {
    let now = 1_000
    const h = harness({ now: () => now })
    h.collector.start()

    h.socket().push(idsFrame(['a']))
    now = 2_000
    h.socket().push(idsFrame([]))
    expect(h.collector.snapshot().items[0]).toMatchObject({ ended: true, endedAt: 2_000 })

    now = 3_000
    h.socket().push(frame([rawConnection('a', { upload: 9, download: 8 })]))
    expect(h.collector.snapshot().items[0]).toMatchObject({
      ended: false,
      endedAt: null,
      upload: 9,
      download: 8
    })
  })
})

describe('ConnectionsCollector 条目上限', () => {
  it('超过上限先淘汰最早结束的，全部活跃后才淘汰最早的活跃条目', () => {
    let now = 1_000
    const h = harness({ now: () => now, maxEntries: 3 })
    h.collector.start()

    h.socket().push(idsFrame(['a', 'b', 'c']))
    now = 2_000
    h.socket().push(idsFrame(['a', 'b'])) // c 结束于 2000
    now = 3_000
    h.socket().push(idsFrame(['a'])) // b 结束于 3000

    now = 4_000
    h.socket().push(idsFrame(['a', 'd'])) // 超额 1：淘汰 c（endedAt 2000）
    expect(h.collector.snapshot().items.map((item) => item.id)).toEqual(['a', 'b', 'd'])

    now = 5_000
    h.socket().push(idsFrame(['a', 'd', 'e', 'f', 'g'])) // 6 条超额 3：b → a → d
    expect(h.collector.snapshot().items.map((item) => item.id)).toEqual(['e', 'f', 'g'])
  })

  it('默认上限是 2000 条，超出的最早活跃条目被淘汰', () => {
    const h = harness()
    h.collector.start()
    const ids = Array.from({ length: 2_001 }, (_, i) => `c${i}`)
    h.socket().push(idsFrame(ids))

    const items = h.collector.snapshot().items
    expect(items).toHaveLength(2_000)
    expect(items[0]?.id).toBe('c1')
    expect(items.at(-1)?.id).toBe('c2000')
  })
})

describe('ConnectionsCollector 连接生命周期', () => {
  it('start 用 Bearer secret 建立连接，重复 start 只替换回调', () => {
    const h = harness()
    const first: ConnectionsSnapshot[] = []
    const second: ConnectionsSnapshot[] = []
    h.collector.start((s) => first.push(s))
    h.collector.start((s) => second.push(s))

    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]?.url).toBe(URL)
    expect(h.calls[0]?.options.headers).toEqual({ authorization: `Bearer ${SECRET}` })

    h.socket().push(idsFrame(['a']))
    expect(first).toHaveLength(0)
    expect(second).toHaveLength(1)
  })

  it('断线后自动重连，旧 socket 的迟到消息被忽略', () => {
    vi.useFakeTimers()
    const h = harness()
    h.collector.start()
    const stale = h.socket()

    stale.disconnect()
    vi.advanceTimersByTime(1_999)
    expect(h.calls).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(h.calls).toHaveLength(2)

    stale.push(idsFrame(['ghost']))
    h.socket().push(idsFrame(['a']))
    expect(h.collector.snapshot().items.map((item) => item.id)).toEqual(['a'])

    h.collector.stop()
  })

  it('stop 关闭连接、取消重连，之后不再连接', () => {
    vi.useFakeTimers()
    const h = harness()
    h.collector.start()
    const socket = h.socket()

    h.collector.stop()
    expect(socket.closed).toBe(true)

    socket.disconnect()
    vi.advanceTimersByTime(60_000)
    expect(h.calls).toHaveLength(1)
  })

  it('未 start 时 stop 不报错也不连接', () => {
    const h = harness()
    expect(() => h.collector.stop()).not.toThrow()
    expect(h.calls).toHaveLength(0)
  })

  it('连接错误被吞掉，不记录含 secret 的错误', () => {
    const h = harness()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.collector.start()

    const err = new Error(`connect ECONNREFUSED ${URL}?token=${SECRET}`)
    for (const cb of h.socket().errors) cb(err)

    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    warn.mockRestore()
    error.mockRestore()
  })

  it('快照返回副本，外部修改不污染内部缓冲', () => {
    const h = harness()
    h.collector.start()
    h.socket().push(frame([rawConnection('a', { chains: ['DIRECT'] })]))

    const snap = h.collector.snapshot()
    snap.items[0]!.ended = true
    snap.items[0]!.chains.push('INJECTED')

    expect(h.collector.snapshot().items[0]).toMatchObject({ ended: false, chains: ['DIRECT'] })
  })
})
