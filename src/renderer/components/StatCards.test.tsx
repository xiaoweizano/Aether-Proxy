import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { copy } from '../copy'
import { StatCards } from './StatCards'

describe('StatCards', () => {
  it('空闲时下载与上传显示 0.00 MB/s，连接数显示破折号', () => {
    const { container } = render(
      <StatCards current={{ up: 0, down: 0, upTotal: 0, downTotal: 0 }} />
    )

    expect(screen.getAllByText('0.00')).toHaveLength(2)
    expect(screen.getAllByText('MB/s')).toHaveLength(2)
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.getByText(copy.dashboard.stats.connectionsFoot)).toBeInTheDocument()
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
      />
    )

    expect(screen.getByText('1.50')).toBeInTheDocument()
    expect(screen.getByText('0.50')).toBeInTheDocument()
    expect(screen.getByText('累计 2.0 MB')).toBeInTheDocument()
    expect(screen.getByText('累计 739.7 KB')).toBeInTheDocument()
  })

  it('没有推送时速率仍是真实的 0.00，累计显示破折号', () => {
    render(<StatCards current={null} />)

    expect(screen.getAllByText('0.00')).toHaveLength(2)
    expect(screen.getAllByText('累计 —')).toHaveLength(2)
  })
})
