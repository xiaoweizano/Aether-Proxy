import { describe, it, expect, vi, afterEach } from 'vitest'
import { LogsCollector, isDialFailure, type LogsOptions } from './logs'
import type { DialFailureCounts } from '../shared/ipc'
import type { WebSocketLike } from './ws'

const URL = 'ws://127.0.0.1:9090/logs?level=warning'
const SECRET = 's3cret-token'
const WINDOW = 5 * 60_000

/** 2026-10-27 从真实的 vendored 内核抓到的拨号失败原文（TCP 版）。 */
const DIAL_TCP =
  '[TCP] dial Proxy (match Match/) 127.0.0.1:8608(curl.exe) --> example.com:80 error: 127.0.0.1:9 connect error: dial tcp 127.0.0.1:9: connectex: No connection could be made because the target machine actively refused it.'
const DIAL_UDP =
  '[UDP] dial DIRECT (match RuleSet/) 127.0.0.1:8609(example.exe) --> dns.example:53 error: timeout'
/** 同一路 `/logs` 里会混进来的非拨号 warning。 */
const OTHER_WARNING = '[DNS] resolve example.com failed: timeout'

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
  collector: LogsCollector
  sockets: FakeSocket[]
  calls: { url: string; options: { headers: Record<string, string> } }[]
  socket(): FakeSocket
  /** 推一帧上游日志。 */
  push(type: string, payload: string): void
}

function harness(opts: Partial<LogsOptions> = {}): Harness {
  const sockets: FakeSocket[] = []
  const calls: { url: string; options: { headers: Record<string, string> } }[] = []
  const connect = (url: string, options: { headers: Record<string, string> }): WebSocketLike => {
    calls.push({ url, options })
    const socket = new FakeSocket()
    sockets.push(socket)
    return socket
  }
  const collector = new LogsCollector({ url: URL, secret: SECRET, connect, ...opts })
  return {
    collector,
    sockets,
    calls,
    socket() {
      const socket = sockets.at(-1)
      if (socket === undefined) throw new Error('还没有建立连接')
      return socket
    },
    push(type: string, payload: string) {
      this.socket().push(JSON.stringify({ type, payload }))
    }
  }
}

/** 可注入的时钟；窗口推进全部靠它，测试不睡墙钟。 */
function clock(start = 1_000) {
  let value = start
  return {
    now: () => value,
    set(ms: number) {
      value = ms
    },
    advance(ms: number) {
      value += ms
    }
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('isDialFailure', () => {
  it('识别实测的 TCP 与 UDP 拨号失败原文', () => {
    expect(isDialFailure('warning', DIAL_TCP)).toBe(true)
    expect(isDialFailure('warning', DIAL_UDP)).toBe(true)
  })

  it('只认 warning 级别：info/error 里的同形文本不计入', () => {
    expect(isDialFailure('info', DIAL_TCP)).toBe(false)
    expect(isDialFailure('error', DIAL_TCP)).toBe(false)
    expect(isDialFailure('Warning', DIAL_TCP)).toBe(false)
  })

  it('前缀必须出现在开头，且必须带 " error: "', () => {
    expect(isDialFailure('warning', `proxying ${DIAL_TCP}`)).toBe(false)
    expect(isDialFailure('warning', '[TCP] dial DIRECT --> example.com:80 timeout')).toBe(false)
    expect(isDialFailure('warning', '[TCP] connect 127.0.0.1:9 error: refused')).toBe(false)
    expect(isDialFailure('warning', '[DNS] resolve error: timeout')).toBe(false)
    expect(isDialFailure('warning', '')).toBe(false)
  })

  it('不把普通 warning 当成拨号失败', () => {
    expect(isDialFailure('warning', OTHER_WARNING)).toBe(false)
  })
})

describe('LogsCollector 计数与缓冲', () => {
  it('任何帧到达前也有稳定返回值，不伪造条目', () => {
    const h = harness({ now: () => 1_000 })
    expect(h.collector.counts()).toEqual({ recent: 0, windowMs: WINDOW })
    expect(h.collector.recent()).toEqual([])
    expect(h.calls).toHaveLength(0)
  })

  it('3 条拨号失败 + 2 条其它 warning：计数为 3，5 条都进 recent()，新条目在最后', () => {
    const c = clock(1_000)
    const h = harness({ now: c.now })
    h.collector.start()

    h.push('warning', DIAL_TCP)
    c.advance(10)
    h.push('warning', OTHER_WARNING)
    c.advance(10)
    h.push('warning', DIAL_UDP)
    c.advance(10)
    h.push('warning', OTHER_WARNING)
    c.advance(10)
    h.push('warning', DIAL_TCP)

    expect(h.collector.counts()).toEqual({ recent: 3, windowMs: WINDOW })
    const entries = h.collector.recent()
    expect(entries).toHaveLength(5)
    expect(entries.map((entry) => entry.payload)).toEqual([
      DIAL_TCP,
      OTHER_WARNING,
      DIAL_UDP,
      OTHER_WARNING,
      DIAL_TCP
    ])
    expect(entries.map((entry) => entry.at)).toEqual([1_000, 1_010, 1_020, 1_030, 1_040])
    expect(entries[0]).toEqual({ at: 1_000, level: 'warning', payload: DIAL_TCP })
  })

  it('窗口随注入时钟滚动：更早的失败掉出，边界时刻归零', () => {
    const c = clock(1_000)
    const h = harness({ now: c.now })
    h.collector.start()

    h.push('warning', DIAL_TCP) // t = 1000
    c.set(2_000)
    h.push('warning', DIAL_TCP) // t = 2000

    c.set(1_000 + WINDOW - 1)
    expect(h.collector.counts().recent).toBe(2)

    c.set(1_000 + WINDOW) // 第一条恰好满 5 分钟，掉出
    expect(h.collector.counts().recent).toBe(1)

    c.set(2_000 + WINDOW) // 第二条也满 5 分钟
    expect(h.collector.counts().recent).toBe(0)
    // 计数滚出不影响日志尾巴本身。
    expect(h.collector.recent()).toHaveLength(2)
  })

  it('计数窗口与展示缓冲解耦：ring 淘汰不影响窗口内的真实计数', () => {
    const c = clock(1_000)
    const h = harness({ now: c.now, maxEntries: 2 })
    h.collector.start()

    h.push('warning', DIAL_TCP)
    c.advance(1)
    h.push('warning', DIAL_UDP)
    c.advance(1)
    h.push('warning', DIAL_TCP)

    expect(h.collector.recent()).toHaveLength(2)
    expect(h.collector.recent().map((entry) => entry.payload)).toEqual([DIAL_UDP, DIAL_TCP])
    expect(h.collector.counts().recent).toBe(3)
  })

  it('recent() 是环形缓冲：超过 maxEntries 淘汰最旧的，默认上限 200', () => {
    const h = harness({ maxEntries: 3 })
    h.collector.start()
    for (let i = 0; i < 5; i += 1) h.push('warning', `warning-${i}`)

    expect(h.collector.recent().map((entry) => entry.payload)).toEqual([
      'warning-2',
      'warning-3',
      'warning-4'
    ])

    const d = harness()
    d.collector.start()
    for (let i = 0; i < 201; i += 1) d.push('warning', `warning-${i}`)
    const entries = d.collector.recent()
    expect(entries).toHaveLength(200)
    expect(entries[0]?.payload).toBe('warning-1')
    expect(entries.at(-1)?.payload).toBe('warning-200')
  })

  it('返回副本，外部修改不污染内部缓冲', () => {
    const h = harness({ now: () => 1_000 })
    h.collector.start()
    h.push('warning', OTHER_WARNING)

    const entries = h.collector.recent()
    entries[0]!.payload = 'tampered'
    entries.pop()

    expect(h.collector.recent()).toEqual([
      { at: 1_000, level: 'warning', payload: OTHER_WARNING }
    ])
  })

  it('坏帧被丢弃：既不计数也不进 recent()，好帧不受影响', () => {
    const c = clock(1_000)
    const h = harness({ now: c.now })
    h.collector.start()
    h.push('warning', DIAL_TCP)

    const bad = [
      'not json',
      '',
      'null',
      '42',
      '[]',
      '{}',
      JSON.stringify({ type: 'warning' }),
      JSON.stringify({ payload: DIAL_TCP }),
      JSON.stringify({ type: 42, payload: DIAL_TCP }),
      JSON.stringify({ type: 'warning', payload: 42 }),
      JSON.stringify({ type: null, payload: DIAL_TCP }),
      JSON.stringify({ type: 'warning', payload: null })
    ]
    for (const text of bad) h.socket().push(text)
    // 上游可能发 Buffer，而不是 string。
    h.socket().push(Buffer.from(JSON.stringify({ type: 'warning', payload: OTHER_WARNING })))

    expect(h.collector.counts().recent).toBe(1)
    expect(h.collector.recent().map((entry) => entry.payload)).toEqual([
      DIAL_TCP,
      OTHER_WARNING
    ])
  })

  it('拨号失败到达时同步推送计数（无定时器：界面轮询/回调都能在 SLA 内看到）', () => {
    const c = clock(1_000)
    const sent: DialFailureCounts[] = []
    const h = harness({ now: c.now })
    h.collector.start((counts) => sent.push(counts))

    h.push('warning', DIAL_TCP)
    expect(sent).toEqual([{ recent: 1, windowMs: WINDOW }])

    h.push('warning', OTHER_WARNING) // 非拨号 warning 不触发计数推送
    expect(sent).toHaveLength(1)

    h.push('warning', DIAL_UDP)
    expect(sent).toEqual([
      { recent: 1, windowMs: WINDOW },
      { recent: 2, windowMs: WINDOW }
    ])
  })
})

describe('LogsCollector 连接生命周期', () => {
  it('start 用 Bearer secret 建立连接，重复 start 只替换回调', () => {
    const first: DialFailureCounts[] = []
    const second: DialFailureCounts[] = []
    const h = harness()
    h.collector.start((counts) => first.push(counts))
    h.collector.start((counts) => second.push(counts))

    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]?.url).toBe(URL)
    expect(h.calls[0]?.options).toEqual({ headers: { authorization: `Bearer ${SECRET}` } })

    h.push('warning', DIAL_TCP)
    expect(first).toHaveLength(0)
    expect(second).toEqual([{ recent: 1, windowMs: WINDOW }])
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

    stale.push(JSON.stringify({ type: 'warning', payload: DIAL_TCP }))
    h.push('warning', OTHER_WARNING)
    expect(h.collector.counts().recent).toBe(0)
    expect(h.collector.recent().map((entry) => entry.payload)).toEqual([OTHER_WARNING])

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

  it('secret 只出现在 Bearer 头：不进 URL、payload、返回值或错误', () => {
    const sent: DialFailureCounts[] = []
    const h = harness()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.collector.start((counts) => sent.push(counts))

    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]?.url).toBe(URL)
    expect(h.calls[0]?.url).not.toContain(SECRET)
    // 除 headers 外没有别的连接参数，secret 无处可藏。
    expect(Object.keys(h.calls[0]?.options ?? {})).toEqual(['headers'])

    h.push('warning', DIAL_TCP)
    expect(h.collector.recent()[0]?.payload).toBe(DIAL_TCP)
    expect(JSON.stringify(h.collector.recent())).not.toContain(SECRET)
    expect(JSON.stringify(h.collector.counts())).not.toContain(SECRET)
    expect(JSON.stringify(sent)).not.toContain(SECRET)

    // 内核重启期间连接错误的 message 常带 URL/凭据，直接吞掉，不落任何日志。
    for (const cb of h.socket().errors) {
      cb(new Error(`connect ECONNREFUSED ${URL}?token=${SECRET}`))
    }
    expect(error).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    error.mockRestore()
    warn.mockRestore()
  })
})
