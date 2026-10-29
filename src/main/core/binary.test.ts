import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { resolveMihomoBinary } from './binary'

describe('resolveMihomoBinary', () => {
  it('开发态用仓库 vendor 目录', () => {
    const p = resolveMihomoBinary({ isPackaged: false, resourcesPath: '/res', repoRoot: '/repo' })
    expect(p).toBe(path.join('/repo', 'vendor', 'mihomo.exe'))
  })

  it('打包态用 resources 目录', () => {
    const p = resolveMihomoBinary({ isPackaged: true, resourcesPath: '/res', repoRoot: '/repo' })
    expect(p).toBe(path.join('/res', 'mihomo', 'mihomo.exe'))
  })
})
