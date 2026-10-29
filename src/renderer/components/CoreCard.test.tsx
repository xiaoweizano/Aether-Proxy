import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { copy } from '../copy'
import { formatBytes } from '../format'
import { CoreCard } from './CoreCard'

const STARTED_AT = new Date(2026, 0, 2, 13, 31, 13).getTime()

const READY = {
  status: 'ready' as const,
  restore: 'none' as const,
  mode: 'rule' as const,
  proxyEnabled: true,
  core: { version: 'v1.19.32', proxyPort: 5566, startedAt: STARTED_AT },
  profile: { nodeCount: 12, groupCount: 3 }
}

describe('CoreCard', () => {
  it('无内核时版本、端口、启动时间都显示破折号', () => {
    const { container } = render(<CoreCard status={null} memory={null} />)

    expect(screen.getByText(copy.dashboard.core.version('—'))).toBeInTheDocument()
    expect(screen.getByText(copy.dashboard.core.stopped)).toBeInTheDocument()
    expect(screen.getByText(copy.dashboard.core.port('—'))).toBeInTheDocument()
    expect(screen.getByText(copy.dashboard.core.groups('—'))).toBeInTheDocument()
    // 启动于 / 内存占用 / 进程守护 三行
    expect(screen.getAllByText('—')).toHaveLength(3)
    expect(container.textContent).not.toContain('NaN')
  })

  it('运行时显示版本、端口、策略组数与启动时间', () => {
    render(<CoreCard status={READY} memory={null} />)

    expect(screen.getByText('mihomo · v1.19.32')).toBeInTheDocument()
    expect(screen.getByText(copy.dashboard.core.running)).toBeInTheDocument()
    expect(screen.getByText('端口 5566')).toBeInTheDocument()
    expect(screen.getByText('3 个策略组')).toBeInTheDocument()
    expect(screen.getByText('13:31:13')).toBeInTheDocument()
  })

  it('内存占用用快照里的字节数格式化，不缺少数据时不再显示破折号', () => {
    const { container } = render(<CoreCard status={READY} memory={24_944_640} />)

    const rows = [...container.querySelectorAll('.core-rows div')]
    const byKey = new Map(rows.map((row) => [row.querySelector('span')?.textContent, row.querySelector('b')?.textContent]))

    // 实测 /connections 的 memory 是字节：24,944,640 B ≈ 23.8 MB。
    expect(byKey.get(copy.dashboard.core.memory)).toBe(formatBytes(24_944_640))
    expect(byKey.get(copy.dashboard.core.memory)).toBe('23.8 MB')
    // 进程守护仍然没有数据源。
    expect(byKey.get(copy.dashboard.core.guard)).toBe('—')
    expect(byKey.get(copy.dashboard.core.startedAt)).toBe('13:31:13')
  })

  it('内核错误时状态 chip 不说运行中', () => {
    render(
      <CoreCard
        status={{
          ...READY,
          status: 'core-error',
          core: { version: 'v1.19.32', proxyPort: 5566, startedAt: STARTED_AT }
        }}
        memory={null}
      />
    )

    expect(screen.getByText(copy.dashboard.core.stopped)).toBeInTheDocument()
  })
})
