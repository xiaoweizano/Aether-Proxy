import { describe, expect, it } from 'vitest'
import { buildCsp } from './csp'

function directives(csp: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const part of csp.split(';')) {
    const [name, ...rest] = part.trim().split(/\s+/)
    if (name !== undefined) out.set(name, rest.join(' '))
  }
  return out
}

describe('buildCsp', () => {
  it('打包态：脚本只允许自身来源，没有 inline / eval', () => {
    const csp = directives(buildCsp())
    expect(csp.get('script-src')).toBe("'self'")
    expect(buildCsp()).not.toContain('unsafe-eval')
  })

  it('默认拒绝一切，只逐项放开', () => {
    const csp = directives(buildCsp())
    expect(csp.get('default-src')).toBe("'none'")
    expect(csp.get('object-src')).toBe("'none'")
    expect(csp.get('base-uri')).toBe("'none'")
    expect(csp.get('form-action')).toBe("'none'")
  })

  it('渲染层不直连网络：打包态 connect-src 不含任何主机', () => {
    const csp = directives(buildCsp())
    expect(csp.get('connect-src')).toBe("'self'")
    expect(csp.get('connect-src')).not.toContain('ws:')
  })

  it('内联样式必须放行：图表尺寸与进度条走 style 属性', () => {
    expect(directives(buildCsp()).get('style-src')).toBe("'self' 'unsafe-inline'")
  })

  it('开发态为 Vite HMR 放开内联脚本与本地 ws', () => {
    const dev = directives(buildCsp({ dev: true }))
    expect(dev.get('script-src')).toBe("'self' 'unsafe-inline'")
    expect(dev.get('connect-src')).toContain('ws://localhost:*')
  })

  it('不含 <meta> 会被忽略的 frame-ancestors', () => {
    expect(buildCsp()).not.toContain('frame-ancestors')
  })
})
