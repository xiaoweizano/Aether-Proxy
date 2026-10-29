import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  TrafficCollector,
  type StatsOptions,
  type TrafficSnapshot,
  type WebSocketLike
} from './stats'

const URL = 'ws://127.0.0.1:9090/traffic'
const SECRET = 's3cret-token'

type MessageHandler = (data: unknown) => void
type VoidHandler = () => void

/** 只实现 TrafficCollector 用到的三个事件与 close，便于手动推进消息/断线。 */
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
  collector: TrafficCollector
  sockets: FakeSocket[]
  calls: { url: string; options: { headers: Record<string, string> } }[]
  socket(): FakeSocket
}

function harness(opts: Partial<StatsOptions> = {}): Harness {
  const sockets: FakeSocket[] = []
  const calls: { url: string; options: { headers: Record<string, string> } }[] = []
  const connect = (url: string, options: { headers: Record<string, string> }): WebSocketLike => {
    calls.push({ url, options })
    const socket = new FakeSocket()
    sockets.push(socket)
    return socket
  }
  const collector = new TrafficCollector({ url: URL, secret: SECRET, connect, ...opts })
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

function sample(up: number, down: number, upTotal: number, downTotal: number): string {
  return JSON.stringify({ up, down, upTotal, downTotal })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('TrafficCollector 采样', () => {
  it('环形缓冲只保留最近 maxSamples 条，快照取最后一条的速率与总量', () => {
    const h = harness()
    const seen: TrafficSnapshot[] = []
    h.collector.start((s) => seen.push(s))

    for (let i = 1; i <= 65; i += 1) {
      h.socket().push(sample(i, i * 2, i * 1000, i * 2000))
    }

    const snap = h.collector.snapshot()
    expect(snap.history).toHaveLength(60)
    // 丢弃的是前 5 条（up=1..5），保留 up=6..65。
    expect(snap.history[0]).toEqual({ up: 6, down: 12 })
    expect(snap.history[59]).toEqual({ up: 65, down: 130 })
    expect(snap.up).toBe(65)
    expect(snap.down).toBe(130)
    expect(snap.upTotal).toBe(65_000)
    expect(snap.downTotal).toBe(130_000)

    // 每条消息推一次，且推送的快照也遵守缓冲上限。
    expect(seen).toHaveLength(65)
    expect(seen[0]?.history).toHaveLength(1)
    expect(seen.at(-1)?.history).toHaveLength(60)
  })

  it('maxSamples 可配置', () => {
    const h = harness({ maxSamples: 2 })
    h.collector.start()
    for (let i = 1; i <= 3; i += 1) h.socket().push(sample(i, i, i, i))

    expect(h.collector.snapshot().history).toEqual([
      { up: 2, down: 2 },
      { up: 3, down: 3 }
    ])
  })

  it('忽略无法解析或字段不全的消息', () => {
    const h = harness()
    h.collector.start()

    for (const bad of [
      'not json',
      '',
      'null',
      '42',
      '[1,2]',
      '{}',
      '{"up":1,"down":2,"upTotal":3}',
      '{"up":"1","down":2,"upTotal":3,"downTotal":4}',
      '{"up":1,"down":2,"upTotal":3,"downTotal":null}',
      '{"up":1,"down":2,"upTotal":3,"downTotal":4,"extra":"x"}'
    ]) {
      h.socket().push(bad)
    }
    // 二进制帧也能解析；上游只发 JSON 文本，这里覆盖 data 不是 string 的情况。
    h.socket().push(Buffer.from(sample(7, 8, 70, 80)))

    const snap = h.collector.snapshot()
    // 仅最后一条合法（extra 字段不影响解析）。
    expect(snap.history).toEqual([
      { up: 1, down: 2 },
      { up: 7, down: 8 }
    ])
    expect(snap.upTotal).toBe(70)
    expect(snap.downTotal).toBe(80)
  })

  it('没有样本时快照为零且 history 为空', () => {
    const h = harness()
    expect(h.collector.snapshot()).toEqual({
      up: 0,
      down: 0,
      upTotal: 0,
      downTotal: 0,
      history: []
    })
  })

  it('快照的 history 是副本，外部修改不影响内部缓冲', () => {
    const h = harness()
    h.collector.start()
    h.socket().push(sample(1, 2, 3, 4))

    const snap = h.collector.snapshot()
    snap.history[0]!.up = 999
    snap.history.push({ up: 1, down: 1 })
    expect(h.collector.snapshot().history).toEqual([{ up: 1, down: 2 }])
  })
})

describe('TrafficCollector 连接', () => {
  it('start 时用 Bearer secret 建立连接', () => {
    const h = harness()
    h.collector.start()

    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]?.url).toBe(URL)
    expect(h.calls[0]?.options.headers).toEqual({ authorization: `Bearer ${SECRET}` })
  })

  it('重复 start 不建立第二条连接，但会替换回调', () => {
    const h = harness()
    const first: TrafficSnapshot[] = []
    const second: TrafficSnapshot[] = []
    h.collector.start((s) => first.push(s))
    h.collector.start((s) => second.push(s))

    expect(h.calls).toHaveLength(1)
    h.socket().push(sample(1, 2, 3, 4))
    expect(first).toHaveLength(0)
    expect(second).toHaveLength(1)
  })

  it('未 stop 时断线会在 reconnectMs 后重连，缓冲继续累积', () => {
    vi.useFakeTimers()
    const h = harness({ reconnectMs: 2000 })
    h.collector.start()
    h.socket().push(sample(1, 1, 10, 10))

    h.socket().disconnect()
    vi.advanceTimersByTime(1999)
    expect(h.calls).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(h.calls).toHaveLength(2)

    h.socket().push(sample(2, 2, 20, 20))
    expect(h.collector.snapshot().history).toEqual([
      { up: 1, down: 1 },
      { up: 2, down: 2 }
    ])
    expect(h.collector.snapshot().upTotal).toBe(20)

    h.collector.stop()
  })

  it('stop 关闭连接、清空重连定时器，且之后不再重连', () => {
    vi.useFakeTimers()
    const h = harness()
    h.collector.start()
    const socket = h.socket()

    h.collector.stop()
    expect(socket.closed).toBe(true)

    // 关闭事件在 stop 之后到达也不能再排重连。
    socket.disconnect()
    vi.advanceTimersByTime(60_000)
    expect(h.calls).toHaveLength(1)
  })

  it('断线已排重连时 stop 会取消它', () => {
    vi.useFakeTimers()
    const h = harness()
    h.collector.start()
    h.socket().disconnect()
    h.collector.stop()

    vi.advanceTimersByTime(60_000)
    expect(h.calls).toHaveLength(1)
  })

  it('未 start 时 stop 不报错也不连接', () => {
    const h = harness()
    expect(() => h.collector.stop()).not.toThrow()
    expect(h.calls).toHaveLength(0)
  })

  it('连接错误不会中断采集器，也不泄漏 secret', () => {
    const h = harness()
    const logger = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const loggerError = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.collector.start()

    const err = new Error(`connect ECONNREFUSED ${URL}?token=${SECRET}`)
    for (const cb of h.socket().errors) cb(err)

    expect(logger).not.toHaveBeenCalled()
    expect(loggerError).not.toHaveBeenCalled()
    logger.mockRestore()
    loggerError.mockRestore()
  })

  it('stop 之后可以重新 start 并继续采样', () => {
    const h = harness()
    h.collector.start()
    h.socket().push(sample(1, 1, 1, 1))
    h.collector.stop()

    h.collector.start()
    expect(h.calls).toHaveLength(2)
    h.socket().push(sample(2, 2, 2, 2))
    expect(h.collector.snapshot().history).toEqual([
      { up: 1, down: 1 },
      { up: 2, down: 2 }
    ])
    h.collector.stop()
  })
})
