import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { copy } from '../copy'
import { CoreCard } from './CoreCard'

const STARTED_AT = new Date(2026, 0, 2, 13, 31, 13).getTime()

describe('CoreCard', () => {
  it('无内核时版本、端口、启动时间都显示破折号', () => {
    const { container } = render(<CoreCard status={null} />)

    expect(screen.getByText(copy.dashboard.core.version('—'))).toBeInTheDocument()
    expect(screen.getByText(copy.dashboard.core.stopped)).toBeInTheDocument()
    expect(screen.getByText(copy.dashboard.core.port('—'))).toBeInTheDocument()
    expect(screen.getByText(copy.dashboard.core.groups('—'))).toBeInTheDocument()
    // 启动于 / 内存占用 / 进程守护 三行
    expect(screen.getAllByText('—')).toHaveLength(3)
    expect(container.textContent).not.toContain('NaN')
  })

  it('运行时显示版本、端口、策略组数与启动时间', () => {
    render(
      <CoreCard
        status={{
          status: 'ready',
          restore: 'none',
          mode: 'rule',
          proxyEnabled: true,
          core: { version: 'v1.19.32', proxyPort: 5566, startedAt: STARTED_AT },
          profile: { nodeCount: 12, groupCount: 3 }
        }}
      />
    )

    expect(screen.getByText('mihomo · v1.19.32')).toBeInTheDocument()
    expect(screen.getByText(copy.dashboard.core.running)).toBeInTheDocument()
    expect(screen.getByText('端口 5566')).toBeInTheDocument()
    expect(screen.getByText('3 个策略组')).toBeInTheDocument()
    expect(screen.getByText('13:31:13')).toBeInTheDocument()
  })

  it('内存与进程守护还没有数据源，即使内核在跑也显示破折号', () => {
    const { container } = render(
      <CoreCard
        status={{
          status: 'ready',
          restore: 'none',
          mode: 'rule',
          proxyEnabled: true,
          core: { version: 'v1.19.32', proxyPort: 5566, startedAt: STARTED_AT },
          profile: { nodeCount: 12, groupCount: 3 }
        }}
      />
    )

    const rows = [...container.querySelectorAll('.core-rows div')]
    const byKey = new Map(rows.map((row) => [row.querySelector('span')?.textContent, row.querySelector('b')?.textContent]))

    expect(byKey.get(copy.dashboard.core.memory)).toBe('—')
    expect(byKey.get(copy.dashboard.core.guard)).toBe('—')
    expect(byKey.get(copy.dashboard.core.startedAt)).toBe('13:31:13')
    // 没有数据的地方不能出现一个看起来像测出来的数字
    expect(container.textContent).not.toMatch(/\d+\s*MB/)
    expect(container.textContent).not.toContain('正常')
  })

  it('内核错误时状态 chip 不说运行中', () => {
    render(
      <CoreCard
        status={{
          status: 'core-error',
          restore: 'none',
          mode: 'rule',
          proxyEnabled: false,
          core: { version: 'v1.19.32', proxyPort: 5566, startedAt: STARTED_AT }
        }}
      />
    )

    expect(screen.getByText(copy.dashboard.core.stopped)).toBeInTheDocument()
  })
})
