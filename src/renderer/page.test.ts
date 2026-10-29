import { describe, expect, it } from 'vitest'
import { initialPage } from './page'

describe('initialPage', () => {
  it('默认仪表盘', () => {
    expect(initialPage('')).toBe('dashboard')
    expect(initialPage('?startupStatus=ready')).toBe('dashboard')
  })

  it('五个页面都能指定', () => {
    for (const page of ['dashboard', 'nodes', 'connections', 'settings', 'logs'] as const) {
      expect(initialPage(`?page=${page}`)).toBe(page)
    }
  })

  it('未知值回退到仪表盘：URL 不能决定渲染什么', () => {
    expect(initialPage('?page=admin')).toBe('dashboard')
    expect(initialPage('?page=')).toBe('dashboard')
    // 原型链上的键不能冒充页面名。
    expect(initialPage('?page=constructor')).toBe('dashboard')
    expect(initialPage('?page=__proto__')).toBe('dashboard')
  })
})
