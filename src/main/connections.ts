import type { ConnectionView, ConnectionsSnapshot } from '../shared/ipc'
import {
  DEFAULT_RECONNECT_MS,
  connectWithWs,
  toText,
  type StatsConnect,
  type WebSocketLike
} from './ws'

export interface ConnectionsOptions {
  /** 形如 `ws://127.0.0.1:<controllerPort>/connections?interval=500`；只在主进程内存在。 */
  url: string
  secret: string
  /** 测试注入；缺省用 `ws` 并带 Bearer 头。 */
  connect?: StatsConnect
  /** 已结束连接的保留时长，默认 60_000。 */
  retainEndedMs?: number
  /** 总条目上限，默认 2000。 */
  maxEntries?: number
  /** 时钟注入，默认 `Date.now`；测试用它推进「结束→移除」的边界。 */
  now?: () => number
}

const DEFAULT_RETAIN_ENDED_MS = 60_000
const DEFAULT_MAX_ENTRIES = 2000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 缺失、空串、类型不对一律视为未知（null），界面渲染为 `—`。 */
function asText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** 实测 `/connections` 的端口是字符串；同时容忍某些版本给数字。 */
function asPort(value: unknown): string | null {
  if (typeof value === 'string') return value === '' ? null : value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function asStartedAt(value: unknown): number | null {
  if (typeof value !== 'string' || value === '') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/** 内核的 `chains[0]` 是实际出站；反转后才是「最外层策略组 → … → 实际出站」。 */
function asChains(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const chains: string[] = []
  for (let i = value.length - 1; i >= 0; i -= 1) {
    const item = value[i]
    if (typeof item === 'string' && item !== '') chains.push(item)
  }
  return chains
}

/**
 * 单条连接解析。id 缺失或不是非空字符串就无法做帧间对齐，返回 null；
 * 其余字段缺失只影响该字段，不影响整条记录（字段容错）。
 */
function parseConnection(raw: unknown): ConnectionView | null {
  if (!isRecord(raw)) return null
  const id = asText(raw.id)
  if (id === null) return null

  const meta = isRecord(raw.metadata) ? raw.metadata : {}
  const host = asText(meta.host) ?? asText(meta.remoteDestination) ?? asText(meta.destinationIP)

  return {
    id,
    startedAt: asStartedAt(raw.start),
    chains: asChains(raw.chains),
    rule: asText(raw.rule),
    rulePayload: asText(raw.rulePayload),
    host,
    process: asText(meta.process),
    processPath: asText(meta.processPath),
    network: asText(meta.network),
    destinationIp: asText(meta.destinationIP),
    destinationPort: asPort(meta.destinationPort),
    sourceIp: asText(meta.sourceIP),
    sourcePort: asPort(meta.sourcePort),
    upload: asCount(raw.upload),
    download: asCount(raw.download),
    ended: false,
    endedAt: null
  }
}

interface ParsedFrame {
  memory: number | null
  connections: unknown[]
}

/** 整帧坏掉（非 JSON、没有 connections 数组）时返回 null；单条坏记录由调用方跳过。 */
function parseFrame(text: string): ParsedFrame | null {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(body) || !Array.isArray(body.connections)) return null
  const memory =
    typeof body.memory === 'number' && Number.isFinite(body.memory) ? body.memory : null
  return { memory, connections: body.connections }
}

/**
 * `/connections?interval=500` 采集器。每帧都是完整快照，不是差分：
 * - 帧里出现的连接更新字段并清除「已结束」；
 * - 从帧里消失的连接标为已结束但保留，`retainEndedMs` 后才移除；
 * - 总条目超过上限时先淘汰最早结束的，全部活跃时才淘汰最早出现的活跃条目。
 *
 * 生命周期与 `TrafficCollector` 一致：`start()` 幂等，断线自动重连，`stop()` 关闭连接
 * 并取消重连。`snapshot()` 任意时刻可读，窗口重建后可据此补首屏。
 *
 * 任何日志与推送都不含 secret；连接错误直接吞掉（内核重启期间会周期性发生）。
 */
export class ConnectionsCollector {
  private readonly url: string
  private readonly secret: string
  private readonly connect: StatsConnect
  private readonly retainEndedMs: number
  private readonly maxEntries: number
  private readonly now: () => number

  /** 插入顺序就是「最早出现」的顺序，Map.set 覆盖已有 id 时不会改变位置。 */
  private readonly entries = new Map<string, ConnectionView>()
  private memory: number | null = null

  private onSnapshot: ((s: ConnectionsSnapshot) => void) | null = null
  private socket: WebSocketLike | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private started = false

  constructor(opts: ConnectionsOptions) {
    this.url = opts.url
    this.secret = opts.secret
    this.connect = opts.connect ?? connectWithWs
    const retain = opts.retainEndedMs ?? DEFAULT_RETAIN_ENDED_MS
    this.retainEndedMs =
      Number.isFinite(retain) && retain >= 0 ? retain : DEFAULT_RETAIN_ENDED_MS
    const max = opts.maxEntries ?? DEFAULT_MAX_ENTRIES
    this.maxEntries = Number.isFinite(max) && max >= 1 ? Math.floor(max) : DEFAULT_MAX_ENTRIES
    this.now = opts.now ?? Date.now
  }

  /** 幂等：已连接时只替换回调，不新建连接。 */
  start(onSnapshot?: (s: ConnectionsSnapshot) => void): void {
    this.onSnapshot = onSnapshot ?? null
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

  /** 任意时刻可调用；尚未收到任何帧时返回空列表与 memory: null。 */
  snapshot(): ConnectionsSnapshot {
    const now = this.now()
    this.prune(now)
    return this.build(now)
  }

  private build(now: number): ConnectionsSnapshot {
    const items: ConnectionView[] = []
    for (const entry of this.entries.values()) {
      items.push({ ...entry, chains: [...entry.chains] })
    }
    return { items, memory: this.memory, retainMs: this.retainEndedMs, at: now }
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
    const seen = new Set<string>()
    for (const raw of frame.connections) {
      const view = parseConnection(raw)
      if (view === null) continue
      seen.add(view.id)
      this.entries.set(view.id, view)
    }

    for (const entry of this.entries.values()) {
      if (!seen.has(entry.id) && !entry.ended) {
        entry.ended = true
        entry.endedAt = now
      }
    }

    this.memory = frame.memory
    this.prune(now)
    this.enforceCap()
    // 保留期与上限的推进必须每帧都做（上面两行），但快照的构建要按需：
    // 没有窗口订阅时没必要为 2000 条连接分配视图对象，推送本身会被丢弃。
    if (this.onSnapshot !== null) this.onSnapshot(this.build(now))
  }

  private prune(now: number): void {
    for (const [id, entry] of this.entries) {
      if (entry.ended && entry.endedAt !== null && now - entry.endedAt >= this.retainEndedMs) {
        this.entries.delete(id)
      }
    }
  }

  /** 先淘汰 endedAt 最早的已结束条目；没有已结束条目时淘汰最早插入的活跃条目。 */
  private enforceCap(): void {
    while (this.entries.size > this.maxEntries) {
      let victimId: string | null = null
      let victimEndedAt = Number.POSITIVE_INFINITY
      for (const [id, entry] of this.entries) {
        if (!entry.ended || entry.endedAt === null) continue
        if (entry.endedAt < victimEndedAt) {
          victimEndedAt = entry.endedAt
          victimId = id
        }
      }
      if (victimId === null) {
        const first = this.entries.keys().next()
        if (first.done === true) return
        victimId = first.value
      }
      this.entries.delete(victimId)
    }
  }

  private scheduleReconnect(): void {
    if (!this.started || this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.open()
    }, DEFAULT_RECONNECT_MS)
  }
}
