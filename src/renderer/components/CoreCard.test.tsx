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
    // 启动于 / 进程守护 两行
    expect(screen.getAllByText('—')).toHaveLength(2)
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
    expect(screen.getByText(copy.dashboard.core.guardOk)).toBeInTheDocument()
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
