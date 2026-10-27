import type { DialFailureCounts } from '../shared/ipc'
import {
  DEFAULT_RECONNECT_MS,
  connectWithWs,
  toText,
  type StatsConnect,
  type WebSocketLike
} from './ws'

export interface LogsOptions {
  /** 形如 `ws://127.0.0.1:<controllerPort>/logs?level=warning`；只在主进程内存在。 */
  url: string
  secret: string
  /** 测试注入；缺省用 `ws` 并带 Bearer 头。 */
  connect?: StatsConnect
  /** 计数窗口，默认 60 分钟（见 DEFAULT_WINDOW_MS 的注释）。 */
  windowMs?: number
  /** 环形缓冲条数，默认 200（错误面板与「查看日志」页用）。 */
  maxEntries?: number
  /** 时钟注入，默认 `Date.now`；测试用它推进「滚出窗口」的边界。 */
  now?: () => number
}

/** 主进程规范化后的单条日志；渲染层只读。 */
export interface LogEntry {
  /** 到达时刻（主进程时钟，毫秒）。 */
  at: number
  /** 内核给的级别（实测是 `warning`）。 */
  level: string
  /** 内核原文，逐字保留。 */
  payload: string
}

/**
 * 窗口长度按规范定：`connection-inspector` 的 SHALL 写的是「最近 60 分钟 N 次失败」。
 * （`openspec/.../design.md` 与 `tasks.md` 写的是 5 分钟，是文档内的旧说法；
 * 规格是权威，这里以 60 分钟为准。）
 */
const DEFAULT_WINDOW_MS = 60 * 60_000
const DEFAULT_MAX_ENTRIES = 200

interface ParsedLogFrame {
  type: string
  payload: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 拨号失败的判定。上游每个 WS 帧形如 `{ "type": "warning", "payload": "…" }`，
 * 拨号失败原文（2026-10-27 实测）：
 *
 * `[TCP] dial Proxy (match Match/) 127.0.0.1:8608(curl.exe) --> example.com:80 error: …`
 *
 * 这个 payload 格式**没有版本约定**，所以只匹配稳定前缀与关键字，不解析字段。
 * 若上游改了格式，计数会静默变成 0（而不是崩溃）；这是刻意选择的降级方向。
 */
export function isDialFailure(type: string, payload: string): boolean {
  if (type !== 'warning') return false
  if (!payload.startsWith('[TCP] dial ') && !payload.startsWith('[UDP] dial ')) return false
  return payload.includes(' error: ')
}

/** 整帧坏掉（非 JSON、缺 type/payload、类型不对）时返回 null；调用方直接丢弃。 */
function parseFrame(text: string): ParsedLogFrame | null {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(body)) return null
  const { type, payload } = body
  if (typeof type !== 'string' || type === '') return null
  if (typeof payload !== 'string' || payload === '') return null
  return { type, payload }
}

/**
 * `/logs?level=warning` 采集器，同时维护两样东西：
 * - `recent()`：日志尾巴的环形缓冲（默认 200 条），界面错误面板与「查看日志」页用；
 * - `counts()`：拨号失败的滚动窗口计数（默认 60 分钟），保留独立的时间戳队列。
 *
 * 计数不依赖展示缓冲：`maxEntries` 淘汰日志条目不能把窗口内的真实失败次数一起抹掉。
 * 计数在 `counts()` 读取时按注入时钟惰性滚动，拨号失败到达时同步回调 `onCounts`，
 * 因此「失败到达后 5 秒内可见」对回调与轮询两条路径都成立。
 *
 * 注意：`onCounts` **只在有新失败时触发**，窗口到期不会有通知。只订阅推送的消费方
 * 会一直显示过期的非零计数（失败滚出窗口后没有帧到达就不会有推送），所以消费方
 * 必须同时以不超过窗口的量级轮询 `counts()`；这也是 `logsCountsGet` 存在的原因。
 *
 * 生命周期与 `ConnectionsCollector` 一致：`start()` 幂等，断线自动重连，`stop()` 关闭
 * 连接并取消重连。任何日志与推送都不含 secret；连接错误直接吞掉（内核重启期间会周期性发生）。
 */
export class LogsCollector {
  private readonly url: string
  private readonly secret: string
  private readonly connect: StatsConnect
  private readonly windowMs: number
  private readonly maxEntries: number
  private readonly now: () => number

  /** 日志尾巴，按到达顺序，最新在最后。 */
  private readonly entries: LogEntry[] = []
  /** 窗口内拨号失败的到达时刻，升序；与 entries 相互独立。 */
  private readonly failures: number[] = []

  private onCounts: ((c: DialFailureCounts) => void) | null = null
  private socket: WebSocketLike | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private started = false

  constructor(opts: LogsOptions) {
    this.url = opts.url
    this.secret = opts.secret
    this.connect = opts.connect ?? connectWithWs
    const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS
    this.windowMs =
      Number.isFinite(windowMs) && windowMs > 0 ? windowMs : DEFAULT_WINDOW_MS
    const max = opts.maxEntries ?? DEFAULT_MAX_ENTRIES
    this.maxEntries = Number.isFinite(max) && max >= 1 ? Math.floor(max) : DEFAULT_MAX_ENTRIES
    this.now = opts.now ?? Date.now
  }

  /** 幂等：已连接时只替换回调，不新建连接。 */
  start(onCounts?: (c: DialFailureCounts) => void): void {
    this.onCounts = onCounts ?? null
    if (this.started) return
    this.started = true
    this.open()
  }

  stop(): void {
    this.started = false
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const socket = this.socket
    this.socket = null
    if (socket === null) return
    try {
      socket.close()
    } catch {
      // 关闭失败无需上报：采集器已经不再持有它。
    }
  }

  /** 任意时刻可调用；窗口按注入时钟惰性滚动。 */
  counts(): DialFailureCounts {
    return this.buildCounts(this.now())
  }

  /** 日志尾巴的副本，最新在最后；不受计数窗口影响。 */
  recent(): LogEntry[] {
    return this.entries.map((entry) => ({ ...entry }))
  }

  private buildCounts(now: number): DialFailureCounts {
    this.pruneFailures(now)
    return { recent: this.failures.length, windowMs: this.windowMs }
  }

  /** 到达时刻恰好满 `windowMs` 即视为滚出（与 `ConnectionsCollector` 的 retain 边界一致）。 */
  private pruneFailures(now: number): void {
    while (this.failures.length > 0) {
      const oldest = this.failures[0]
      if (oldest === undefined || now - oldest < this.windowMs) return
      this.failures.shift()
    }
  }

  private append(entry: LogEntry): void {
    this.entries.push(entry)
    while (this.entries.length > this.maxEntries) this.entries.shift()
  }

  private open(): void {
    if (!this.started) return
    let socket: WebSocketLike
    try {
      socket = this.connect(this.url, {
        headers: { authorization: `Bearer ${this.secret}` }
      })
    } catch {
      // 构造失败（例如 URL 非法）同样按断线处理，避免把异常抛给启动路径。
      this.scheduleReconnect()
      return
    }
    this.socket = socket
    socket.on('message', (data) => {
      // stop()/重连后旧连接仍可能送进最后几条消息，不能污染新连接的缓冲。
      if (this.socket === socket) this.handleMessage(data)
    })
    socket.on('close', () => {
      if (this.socket !== socket) return
      this.socket = null
      this.scheduleReconnect()
    })
    // ws 连接失败时先 emit error 再 emit close；必须挂监听，否则未处理的 error 会终止进程。
    socket.on('error', () => {})
  }

  private handleMessage(data: unknown): void {
    const text = toText(data)
    if (text === null) return
    const frame = parseFrame(text)
    if (frame === null) return

    const now = this.now()
    this.append({ at: now, level: frame.type, payload: frame.payload })
    if (!isDialFailure(frame.type, frame.payload)) return

    this.failures.push(now)
    this.onCounts?.(this.buildCounts(now))
  }

  private scheduleReconnect(): void {
    if (!this.started || this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.open()
    }, DEFAULT_RECONNECT_MS)
  }
}
