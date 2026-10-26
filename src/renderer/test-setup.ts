import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(() => {
  cleanup()
  // 每个用例自行注入 window.aether，避免 mock 跨用例泄漏。
  Reflect.deleteProperty(window, 'aether')
})
