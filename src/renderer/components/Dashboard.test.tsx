import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { copy } from '../copy'
import { readyStatus } from '../test-utils'
import { Dashboard } from './Dashboard'

const STATUS = {
  ...readyStatus,
  core: { version: 'v1.19.32', proxyPort: 5566, startedAt: new Date(2026, 0, 2, 13, 31, 13).getTime() },
  profile: { nodeCount: 12, groupCount: 3 }
}

const HOUR = 60 * 60_000

describe('Dashboard', () => {
  it('四块卡片齐全，无数据时不出现 NaN', () => {
    const { container } = render(
      <Dashboard status={null} active={null} current={null} history={[]} dialFailures={null} />
    )

    expect(screen.getByText(copy.dashboard.node.label)).toBeInTheDocument()
    expect(screen.getByText(copy.dashboard.core.label)).toBeInTheDocument()
    expect(screen.getByText(copy.dashboard.stats.down)).toBeInTheDocument()
    expect(screen.getByText(copy.dashboard.stats.up)).toBeInTheDocument()
    expect(screen.getByText(copy.dashboard.stats.connections)).toBeInTheDocument()
    expect(screen.getByText(copy.dashboard.chart.title)).toBeInTheDocument()
    expect(container.textContent).not.toContain('NaN')
  })

  it('有数据时把节点、内核与速率一起渲染出来', () => {
    render(
      <Dashboard
        status={STATUS}
        active={{ group: 'Proxy', node: 'HK-01', delay: 38 }}
        current={{ up: 0, down: 0, upTotal: 2048, downTotal: 4096 }}
        history={[{ up: 0, down: 0 }]}
        dialFailures={null}
      />
    )

    expect(screen.getByText('HK-01')).toBeInTheDocument()
    expect(screen.getByText('mihomo · v1.19.32')).toBeInTheDocument()
    expect(screen.getByText('端口 5566')).toBeInTheDocument()
    // 两个速率 + 累计流量，均已按格式规则输出
    expect(screen.getAllByText('0.00')).toHaveLength(2)
    expect(screen.getByText('累计 4.0 KB')).toBeInTheDocument()
    expect(screen.getByText('累计 2.0 KB')).toBeInTheDocument()
    // hero 的「已用流量」是上下行之和
    expect(screen.getByText('6.0 KB')).toBeInTheDocument()
  })

  it('hero 占两列、流量图跨满三列', () => {
    const { container } = render(
      <Dashboard status={STATUS} active={null} current={null} history={[]} dialFailures={null} />
    )

    expect(container.querySelector('.card.hero')).not.toBeNull()
    expect(container.querySelector('.card.chart')).not.toBeNull()
    expect(container.querySelectorAll('.card.stat')).toHaveLength(3)
  })

  it('没有计数来源时健康行仍是未知，不出现 0 次失败', () => {
    const { container } = render(
      <Dashboard
        status={STATUS}
        active={{ group: 'Proxy', node: 'HK-01', delay: 38 }}
        current={null}
        history={[]}
        dialFailures={null}
      />
    )

    expect(screen.getByText(copy.dashboard.node.healthUnknown)).toBeInTheDocument()
    expect(container.textContent).not.toContain('次拨号失败')
  })

  it('有失败计数时把 N 与由 windowMs 推导的窗口渲染到 hero 上', () => {
    render(
      <Dashboard
        status={STATUS}
        active={{ group: 'Proxy', node: 'HK-01', delay: 38 }}
        current={null}
        history={[]}
        dialFailures={{ recent: 3, windowMs: HOUR }}
      />
    )

    expect(screen.getByText(copy.dashboard.node.healthFailures('60 分钟', 3))).toBeInTheDocument()
  })

  it('点击失败计数调用 onViewLogs', async () => {
    const onViewLogs = vi.fn()
    render(
      <Dashboard
        status={STATUS}
        active={{ group: 'Proxy', node: 'HK-01' }}
        current={null}
        history={[]}
        dialFailures={{ recent: 1, windowMs: HOUR }}
        onViewLogs={onViewLogs}
      />
    )

    await userEvent.click(
      screen.getByRole('button', {
        name: copy.dashboard.node.healthFailuresAction(
          copy.dashboard.node.healthFailures('60 分钟', 1)
        )
      })
    )

    expect(onViewLogs).toHaveBeenCalledTimes(1)
  })
})
