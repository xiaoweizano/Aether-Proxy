import { connectWithWs, toText, type StatsConnect, type WebSocketLike } from './ws'

// 连接抽象已抽到 ws.ts；这里保留再导出，既有 import 路径（bootstrap / 测试）不变。
export { toText }
export type { StatsConnect, WebSocketLike }

/** 单个采样点：毫秒级瞬时速率（字节/秒），与 mihomo `/traffic` 推送一一对应。 */
export interface TrafficSample {
  up: number
  down: number
}

/** 推给上层（最终是渲染层）的快照：当前速率 + 累计流量 + 最近 maxSamples 个速率点。 */
export interface TrafficSnapshot extends TrafficSample {
  upTotal: number
  downTotal: number
  history: TrafficSample[]
}

export interface StatsOptions {
  /** 形如 `ws://127.0.0.1:<controllerPort>/traffic`；只在主进程内存在。 */
  url: string
  secret: string
  /** 测试注入；缺省用 `ws` 并带 Bearer 头。 */
  connect?: StatsConnect
  /** 环形缓冲长度，默认 60（约一分钟）。 */
  maxSamples?: number
  /** 断线重连间隔，默认 2000ms。 */
  reconnectMs?: number
}

const DEFAULT_MAX_SAMPLES = 60
const DEFAULT_RECONNECT_MS = 2000

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

interface ParsedMessage {
  up: number
  down: number
  upTotal: number
  downTotal: number
}

/** 坏消息（非 JSON、字段缺失或类型不对）一律返回 null，不能中断采集。 */
function parseMessage(text: string): ParsedMessage | null {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const { up, down, upTotal, downTotal } = body as Record<string, unknown>
  if (!isCount(up) || !isCount(down) || !isCount(upTotal) || !isCount(downTotal)) return null
  return { up, down, upTotal, downTotal }
}

/**
 * `/traffic` 采集器。生命周期：`start()` 建连并持续采样，断线每 reconnectMs 重连一次
 * 直到 `stop()`。采样与连接状态无关：断线期间保留已有缓冲，重连后继续追加。
 *
 * 任何日志与推送都不含 secret；连接错误直接吞掉（内核重启期间每 2 秒都会发生一次，
 * 打日志只会刷屏）。
 */
export class TrafficCollector {
  private readonly url: string
  private readonly secret: string
  private readonly connect: StatsConnect
  private readonly maxSamples: number
  private readonly reconnectMs: number

  private readonly samples: TrafficSample[] = []
  private last: ParsedMessage | null = null

  private onSample: ((s: TrafficSnapshot) => void) | null = null
  private socket: WebSocketLike | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private started = false

  constructor(opts: StatsOptions) {
    this.url = opts.url
    this.secret = opts.secret
    this.connect = opts.connect ?? connectWithWs
    const max = opts.maxSamples ?? DEFAULT_MAX_SAMPLES
    this.maxSamples = Number.isFinite(max) && max >= 1 ? Math.floor(max) : DEFAULT_MAX_SAMPLES
    const reconnect = opts.reconnectMs ?? DEFAULT_RECONNECT_MS
    this.reconnectMs = Number.isFinite(reconnect) && reconnect >= 0 ? reconnect : DEFAULT_RECONNECT_MS
  }

  /**
   * 幂等：已连接时只替换回调，不新建连接。窗口重建后重新挂回调时不会多开一条 WS。
   */
  start(onSample?: (s: TrafficSnapshot) => void): void {
    this.onSample = onSample ?? null
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

  /** 任意时刻可调用；没有样本时返回全零与空 history。 */
  snapshot(): TrafficSnapshot {
    const last = this.last
    return {
      up: last?.up ?? 0,
      down: last?.down ?? 0,
      upTotal: last?.upTotal ?? 0,
      downTotal: last?.downTotal ?? 0,
      history: this.samples.map((s) => ({ ...s }))
    }
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
      // 旧连接在 stop()/重连之后仍可能送进最后几条消息，不能污染新连接的缓冲。
      if (this.socket === socket) this.handleMessage(data)
    })
    socket.on('close', () => {
      if (this.socket !== socket) return
      this.socket = null
      this.scheduleReconnect()
    })
    // ws 在连接失败时先 emit error 再 emit close；这里必须挂监听，否则 Node 会以
    // 未处理的 error 事件终止进程。重连交给 close。
    socket.on('error', () => {})
  }

  private handleMessage(data: unknown): void {
    const text = toText(data)
    if (text === null) return
    const parsed = parseMessage(text)
    if (parsed === null) return

    const sample: TrafficSample = { up: parsed.up, down: parsed.down }
    this.samples.push(sample)
    while (this.samples.length > this.maxSamples) this.samples.shift()
    this.last = parsed

    this.onSample?.(this.snapshot())
  }

  private scheduleReconnect(): void {
    if (!this.started || this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.open()
    }, this.reconnectMs)
  }
}
