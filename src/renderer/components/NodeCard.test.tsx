import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { copy } from '../copy'
import { formatWindow } from '../format'
import { NodeCard } from './NodeCard'

const HOUR = 60 * 60_000

describe('NodeCard', () => {
  it('无数据时节点、健康行与三项统计都是破折号', () => {
    const { container } = render(<NodeCard active={null} mode={null} dialFailures={null} />)

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
        dialFailures={null}
      />
    )

    expect(screen.getByText('HK-01')).toBeInTheDocument()
    expect(screen.getByText('Proxy')).toBeInTheDocument()
    expect(screen.getByText('规则 · TCP')).toBeInTheDocument()
    // 没有计数来源：计数未知；延迟是真实测速，仍然单独成句。
    expect(screen.getByText(copy.dashboard.node.healthUnknown)).toBeInTheDocument()
    expect(screen.getByText(copy.dashboard.node.healthDelay('38ms'))).toBeInTheDocument()
    expect(screen.getByText('01:00:00')).toBeInTheDocument()
    expect(screen.getByText('2.7 MB')).toBeInTheDocument()
  })

  it('没有计数来源（null）时健康行是未知，不是 0 次失败', () => {
    const { container } = render(
      <NodeCard
        active={{ group: 'Proxy', node: 'HK-01', delay: 38 }}
        mode="rule"
        dialFailures={null}
      />
    )

    expect(screen.getByText(copy.dashboard.node.healthUnknown)).toBeInTheDocument()
    expect(container.textContent).not.toContain('次拨号失败')
    expect(container.textContent).not.toContain('0 次')
    expect(container.querySelector('.health-pct')?.textContent).toBe('—')
  })

  it('采集器在线但窗口内零次失败：保持既有未知态，并明说零不等于健康', () => {
    const { container } = render(
      <NodeCard
        active={{ group: 'Proxy', node: 'HK-01', delay: 38 }}
        mode="rule"
        dialFailures={{ recent: 0, windowMs: HOUR }}
      />
    )

    // 窗口长度由 windowMs 推导，值仍是破折号。
    expect(screen.getByText('最近 60 分钟 —')).toBeInTheDocument()
    expect(container.textContent).not.toContain('0 次')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('非零计数显示 N 次拨号失败，且窗口长度由 windowMs 推导', () => {
    const { container, rerender } = render(
      <NodeCard
        active={{ group: 'Proxy', node: 'HK-01' }}
        mode="rule"
        dialFailures={{ recent: 3, windowMs: HOUR }}
      />
    )

    expect(
      screen.getByText(copy.dashboard.node.healthFailures(formatWindow(HOUR), 3))
    ).toBeInTheDocument()
    expect(container.textContent).not.toContain('NaN')

    // 窗口换成 5 分钟，文案必须跟着换：写死的 60 分钟会说谎。
    rerender(
      <NodeCard
        active={{ group: 'Proxy', node: 'HK-01' }}
        mode="rule"
        dialFailures={{ recent: 3, windowMs: 5 * 60_000 }}
      />
    )

    expect(screen.getByText('最近 5 分钟 3 次拨号失败')).toBeInTheDocument()
    expect(container.textContent).not.toContain('60 分钟')
  })

  it('非零计数时延迟仍以同一行尾随，不会顶掉计数', () => {
    render(
      <NodeCard
        active={{ group: 'Proxy', node: 'HK-01', delay: 38 }}
        mode="rule"
        dialFailures={{ recent: 2, windowMs: HOUR }}
      />
    )

    expect(screen.getByText('最近 60 分钟 2 次拨号失败')).toBeInTheDocument()
    expect(screen.getByText('· 最近 38ms')).toBeInTheDocument()
  })

  it('点击失败计数导航到日志页，且只触发一次', async () => {
    const onViewLogs = vi.fn()
    render(
      <NodeCard
        active={{ group: 'Proxy', node: 'HK-01' }}
        mode="rule"
        dialFailures={{ recent: 1, windowMs: HOUR }}
        onViewLogs={onViewLogs}
      />
    )

    const action = screen.getByRole('button', {
      name: copy.dashboard.node.healthFailuresAction(
        copy.dashboard.node.healthFailures('60 分钟', 1)
      )
    })
    await userEvent.click(action)

    expect(onViewLogs).toHaveBeenCalledTimes(1)
  })

  it('畸形的计数不产生 NaN，退回未知态', () => {
    const { container } = render(
      <NodeCard
        active={{ group: 'Proxy', node: 'HK-01', delay: 20 }}
        mode="rule"
        dialFailures={{ recent: Number.NaN, windowMs: Number.NaN }}
      />
    )

    expect(container.textContent).not.toContain('NaN')
    expect(screen.getByText(copy.dashboard.node.healthUnknown)).toBeInTheDocument()
    expect(screen.getByText(copy.dashboard.node.healthDelay('20ms'))).toBeInTheDocument()
  })

  it('没有失败计数来源时健康百分比仍是未知，不凭空算百分比', () => {
    const { container } = render(
      <NodeCard
        active={{ group: 'Proxy', node: 'HK-01', delay: 38 }}
        mode="rule"
        dialFailures={{ recent: 3, windowMs: HOUR }}
      />
    )

    expect(container.querySelector('.health-pct')?.textContent).toBe('—')
    expect(container.textContent).not.toContain('100%')
  })

  it('节点没有延迟数据时健康行不声称任何延迟', () => {
    render(<NodeCard active={{ group: 'Proxy', node: 'HK-01' }} mode="global" dialFailures={null} />)

    expect(screen.getByText(copy.dashboard.node.healthUnknown)).toBeInTheDocument()
  })

  it('刻度条在无计数来源与零计数下都是中性底色，不会用绿色冒充已知健康', () => {
    const { container, rerender } = render(
      <NodeCard active={null} mode="rule" dialFailures={null} />
    )

    expect(container.querySelectorAll('.tick')).toHaveLength(60)
    expect(screen.getByTestId('tick-strip')).toHaveAttribute('aria-hidden', 'true')

    rerender(
      <NodeCard
        active={{ group: 'Proxy', node: 'HK-01', delay: 20 }}
        mode="rule"
        dialFailures={{ recent: 0, windowMs: HOUR }}
      />
    )
    // 采集器在线、零次失败仍不是「每分钟都健康」：整条保持 dim。
    expect(container.querySelector('.ticks.dim')).not.toBeNull()
    expect(screen.getByTestId('tick-strip')).toHaveAttribute('aria-hidden', 'true')
  })

  it('出现失败计数时刻度条仍不逐分钟涂绿：滚动计数没有分钟粒度', () => {
    const { container } = render(
      <NodeCard
        active={{ group: 'Proxy', node: 'HK-01', delay: 20 }}
        mode="rule"
        dialFailures={{ recent: 3, windowMs: HOUR }}
      />
    )

    expect(container.querySelector('.ticks.dim')).not.toBeNull()
    // 整条刻度条没有一格是绿色（没有任何 tick 拿掉 dim 的派生类）。
    expect(container.querySelectorAll('.tick.miss')).toHaveLength(0)
  })

  it('累计流量为 0 时显示真实零值而不是破折号', () => {
    render(
      <NodeCard
        active={{ group: 'Proxy', node: 'HK-01', delay: 20 }}
        mode="rule"
        startedAt={0}
        now={0}
        totals={{ upTotal: 0, downTotal: 0 }}
        dialFailures={null}
      />
    )

    expect(screen.getByText('0 B')).toBeInTheDocument()
    expect(screen.getByText('00:00:00')).toBeInTheDocument()
  })
})
