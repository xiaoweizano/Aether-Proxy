import type { Mode } from '../../shared/types'

export interface ProxiesResponse {
  proxies: Record<
    string,
    { name: string; type: string; now?: string; history?: { delay: number }[]; all?: string[] }
  >
}

export interface CoreVersion {
  version: string
}

export interface CoreMemory {
  inuse: number
}

export interface ConnectionsResponse {
  connections: unknown[]
  downloadTotal: number
  uploadTotal: number
}

export interface ModeResult {
  ok: boolean
  status: number
}

/** getter 失败时的错误：只包含方法名、状态码或通用原因，绝不回显 secret。 */
export class CoreLinkError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'CoreLinkError'
  }
}

/**
 * mihomo controller 的唯一客户端。baseUrl 与 secret 只在主进程内存在，
 * 这个类不导出任何渲染层可用的形状。
 */
export class CoreLink {
  private readonly fetchFn: typeof fetch
  private readonly base: string

  constructor(
    baseUrl: string,
    private readonly secret: string,
    fetchFn?: typeof fetch
  ) {
    this.base = baseUrl.replace(/\/+$/, '')
    this.fetchFn = fetchFn ?? fetch
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await this.fetchFn(`${this.base}${path}`, {
        ...init,
        headers: {
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(init.headers as Record<string, string> | undefined),
          authorization: `Bearer ${this.secret}`
        },
        signal: init.signal ?? AbortSignal.timeout(5_000)
      })
    } catch {
      // fetch 的原始错误可能带 URL 与请求细节；绝不把它透传给上层。
      throw new CoreLinkError('内核不可达', 0)
    }
  }

  private async getJson<T>(path: string): Promise<T> {
    const res = await this.request(path)
    if (!res.ok) throw new CoreLinkError(`内核返回 ${res.status}`, res.status)
    return (await res.json()) as T
  }

  /** getter 的传输错误已在 request 内转为 CoreLinkError。 */
  async version(): Promise<CoreVersion> {
    const body = await this.getJson<{ version?: unknown }>('/version')
    return { version: typeof body.version === 'string' ? body.version : 'unknown' }
  }

  async proxies(): Promise<ProxiesResponse> {
    const body = await this.getJson<{ proxies?: unknown }>('/proxies')
    const proxies = typeof body.proxies === 'object' && body.proxies !== null ? body.proxies : {}
    return { proxies: proxies as ProxiesResponse['proxies'] }
  }

  /** PATCH 失败不抛错：渲染层要据此回滚选中态，而不是看到主进程崩溃。 */
  async setMode(mode: Mode): Promise<ModeResult> {
    try {
      const res = await this.request('/configs', {
        method: 'PATCH',
        body: JSON.stringify({ mode })
      })
      return { ok: res.ok, status: res.status }
    } catch {
      return { ok: false, status: 0 }
    }
  }

  /**
   * 切换策略组里的节点：`PUT /proxies/<url-encoded group>`，body `{ "name": node }`，
   * 成功返回 204。组名放在路径段里，必须整体编码，否则名字里的斜杠会拼出别的路径。
   * 与 `setMode` 一致：失败不抛错，渲染层据此回滚而不是看到主进程崩溃。
   */
  async switchNode(group: string, node: string): Promise<ModeResult> {
    try {
      const res = await this.request(`/proxies/${encodeURIComponent(group)}`, {
        method: 'PUT',
        body: JSON.stringify({ name: node })
      })
      return { ok: res.ok, status: res.status }
    } catch {
      return { ok: false, status: 0 }
    }
  }

  async memory(): Promise<CoreMemory> {
    const body = await this.getJson<{ inuse?: unknown }>('/memory')
    return { inuse: typeof body.inuse === 'number' ? body.inuse : 0 }
  }

  async connections(): Promise<ConnectionsResponse> {
    const body = await this.getJson<{
      connections?: unknown
      downloadTotal?: unknown
      uploadTotal?: unknown
    }>('/connections')
    return {
      connections: Array.isArray(body.connections) ? body.connections : [],
      downloadTotal: typeof body.downloadTotal === 'number' ? body.downloadTotal : 0,
      uploadTotal: typeof body.uploadTotal === 'number' ? body.uploadTotal : 0
    }
  }
}

