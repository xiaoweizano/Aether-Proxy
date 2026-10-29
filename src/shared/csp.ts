/**
 * 渲染层的内容安全策略。
 *
 * 渲染进程是沙箱，而且它**不需要任何网络访问**：所有 controller 请求、订阅拉取都经
 * IPC 交给主进程。因此默认 `default-src 'none'`，只逐个放开真正用到的能力。
 *
 * 开发态是唯一例外：Vite HMR 需要一个内联的 React Refresh 脚本和一条到 dev server 的
 * WebSocket。宽松项只在 `dev` 里出现，打包产物中脚本来源没有 'unsafe-inline'。
 *
 * 两条刻意不写进来的指令：
 * - `frame-ancestors` 在 `<meta>` 里会被浏览器直接忽略（只认 HTTP 头），写进来只会
 *   在开发者工具里留一条警告；本应用也没有任何嵌入方。
 * - 没有 `'unsafe-eval'`：Vite 的产物是原生 ESM，不需要它。
 */
export interface CspOptions {
  /** 开发服务器（Vite HMR）需要内联脚本与 ws 连接。 */
  dev?: boolean
}

export function buildCsp(options: CspOptions = {}): string {
  const dev = options.dev === true
  const directives = [
    "default-src 'none'",
    // 开发态 Vite 会注入内联的 React Refresh 预置脚本。
    dev ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
    // React 的内联 `style` 属性（图表尺寸、进度条宽度）需要 'unsafe-inline'；
    // 样式本身不构成脚本执行面，这一项在打包产物里也必须保留。
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    dev
      ? "connect-src 'self' ws://localhost:* http://localhost:* ws://127.0.0.1:* http://127.0.0.1:*"
      : "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'"
  ]
  return directives.join('; ')
}
