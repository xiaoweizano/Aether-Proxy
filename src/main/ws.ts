import { WebSocket } from 'ws'

/**
 * 只声明采集器用到的三个事件。Node 内建 WebSocket 不支持自定义头，所以真实连接用
 * `ws`；测试注入的假连接实现同一接口即可。
 */
export interface WebSocketLike {
  on(event: 'message', cb: (data: unknown) => void): void
  on(event: 'close', cb: () => void): void
  on(event: 'error', cb: (err: unknown) => void): void
  close(): void
}

/** 所有 controller WS 采集器共用的断线重连间隔；两个采集器必须一致，避免漂移。 */
export const DEFAULT_RECONNECT_MS = 2000

export type StatsConnect = (
  url: string,
  options: { headers: Record<string, string> }
) => WebSocketLike

/** `ws` 的 WebSocket 结构上满足 WebSocketLike，但 RawData 与 unknown 需要一次收敛。 */
export const connectWithWs: StatsConnect = (url, options) =>
  new WebSocket(url, { headers: options.headers }) as unknown as WebSocketLike

/** ws 的 message 事件给 string 或 Buffer/ArrayBuffer；上游只发 JSON 文本。 */
export function toText(data: unknown): string | null {
  if (typeof data === 'string') return data
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8')
  }
  return null
}
