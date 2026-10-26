import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { copy } from '../copy'
import { NodeCard } from './NodeCard'

describe('NodeCard', () => {
  it('无数据时节点、健康行与三项统计都是破折号', () => {
    const { container } = render(<NodeCard active={null} mode={null} />)

    expect(screen.getByText(copy.dashboard.node.label)).toBeInTheDocument()
    // 节点名 + 副行 + 会话时长 + 已用流量 + 工作模式 + 健康百分比
    expect(screen.getAllByText('—')).toHaveLength(6)
    expect(screen.getByText(copy.dashboard.node.noSession)).toBeInTheDocument()
    expect(container.textContent).not.toContain('NaN')
  })

  it('有数据时显示节点名、策略组、延迟与会话统计', () => {
    render(
      <NodeCard
        active={{ group: 'Proxy', node: 'HK-01', delay: 38 }}
        mode="rule"
        startedAt={0}
        now={3600 * 1000}
        totals={{ upTotal: 1024 * 1024, downTotal: 1024 * 1024 * 1.7 }}
      />
    )

    expect(screen.getByText('HK-01')).toBeInTheDocument()
    expect(screen.getByText('Proxy')).toBeInTheDocument()
    expect(screen.getByText('规则 · TCP')).toBeInTheDocument()
    expect(screen.getByText(copy.dashboard.node.health('38ms'))).toBeInTheDocument()
    expect(screen.getByText('01:00:00')).toBeInTheDocument()
    expect(screen.getByText('2.7 MB')).toBeInTheDocument()
  })

  it('节点没有延迟数据时健康行显示破折号延迟', () => {
    render(<NodeCard active={{ group: 'Proxy', node: 'HK-01' }} mode="global" />)

    expect(screen.getByText(copy.dashboard.node.health('—'))).toBeInTheDocument()
  })

  it('60 格刻度条在无数据时变暗', () => {
    const { container, rerender } = render(<NodeCard active={null} mode="rule" />)

    expect(container.querySelector('.ticks.dim')).not.toBeNull()
    expect(container.querySelectorAll('.tick')).toHaveLength(60)

    rerender(<NodeCard active={{ group: 'Proxy', node: 'HK-01', delay: 20 }} mode="rule" />)
    expect(container.querySelector('.ticks.dim')).toBeNull()
    expect(screen.getByTestId('tick-strip')).toHaveAttribute('aria-hidden', 'true')
  })

  it('累计流量为 0 时显示真实零值而不是破折号', () => {
    render(
      <NodeCard
        active={{ group: 'Proxy', node: 'HK-01', delay: 20 }}
        mode="rule"
        startedAt={0}
        now={0}
        totals={{ upTotal: 0, downTotal: 0 }}
      />
    )

    expect(screen.getByText('0 B')).toBeInTheDocument()
    expect(screen.getByText('00:00:00')).toBeInTheDocument()
  })
})
