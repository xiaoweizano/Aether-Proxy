import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { copy } from '../copy'
import { StatCards } from './StatCards'

const NO_CONNECTIONS = { active: null, total: null, retainMs: null }

describe('StatCards', () => {
  it('空闲时下载与上传显示 0.00 MB/s；没有采集器时连接数显示破折号并说明原因', () => {
    const { container } = render(
      <StatCards
        current={{ up: 0, down: 0, upTotal: 0, downTotal: 0 }}
        {...NO_CONNECTIONS}
      />
    )

    expect(screen.getAllByText('0.00')).toHaveLength(2)
    expect(screen.getAllByText('MB/s')).toHaveLength(2)
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.getByText(copy.dashboard.stats.connectionsFootUnknown)).toBeInTheDocument()
    expect(container.textContent).not.toContain('NaN')
  })

  it('有速率时按 MB/s 显示两位小数，页脚是累计流量', () => {
    render(
      <StatCards
        current={{
          up: 1024 * 1024 * 0.5,
          down: 1024 * 1024 * 1.5,
          upTotal: 739.7 * 1024,
          downTotal: 2 * 1024 * 1024
        }}
        {...NO_CONNECTIONS}
      />
    )

    expect(screen.getByText('1.50')).toBeInTheDocument()
    expect(screen.getByText('0.50')).toBeInTheDocument()
    expect(screen.getByText('累计 2.0 MB')).toBeInTheDocument()
    expect(screen.getByText('累计 739.7 KB')).toBeInTheDocument()
  })

  it('连接数来自活跃行，页脚条数含保留期内的已结束行、窗口由 retainMs 推导', () => {
    render(
      <StatCards current={null} active={2} total={5} retainMs={60_000} />
    )

    expect(screen.getByText('2')).toBeInTheDocument()
    expect(
      screen.getByText(copy.dashboard.stats.connectionsFoot(5, '1 分钟'))
    ).toBeInTheDocument()
  })

  it('采集器在线且零条连接时显示测得的 0，而不是破折号', () => {
    render(<StatCards current={null} active={0} total={0} retainMs={30_000} />)

    expect(screen.getByText('0')).toBeInTheDocument()
    expect(
      screen.getByText(copy.dashboard.stats.connectionsFoot(0, '30 秒'))
    ).toBeInTheDocument()
  })

  it('没有推送时速率是破折号而不是 0.00，累计也是破折号', () => {
    const { container } = render(<StatCards current={null} {...NO_CONNECTIONS} />)

    // 下载 + 上传 + 活跃连接
    expect(screen.getAllByText('—')).toHaveLength(3)
    expect(screen.queryAllByText('0.00')).toHaveLength(0)
    expect(screen.getAllByText('累计 —')).toHaveLength(2)
    expect(container.textContent).not.toContain('NaN')
  })

  it('有推送但速率为 0 时显示测得的零值', () => {
    render(
      <StatCards
        current={{ up: 0, down: 0, upTotal: 0, downTotal: 0 }}
        {...NO_CONNECTIONS}
      />
    )

    expect(screen.getAllByText('0.00')).toHaveLength(2)
    expect(screen.getAllByText('累计 0 B')).toHaveLength(2)
  })
})
