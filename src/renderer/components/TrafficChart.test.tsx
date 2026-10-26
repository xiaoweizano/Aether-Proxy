import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { copy } from '../copy'
import { TrafficChart } from './TrafficChart'

function pointCount(d: string | null): number {
  if (d === null || d.trim() === '') return 0
  return (d.match(/[ML]/g) ?? []).length
}

describe('TrafficChart', () => {
  it('空历史只画基线，路径为零点且不含 NaN', () => {
    const { container } = render(<TrafficChart history={[]} />)

    expect(screen.getByTestId('chart-baseline')).toBeInTheDocument()
    expect(screen.queryByTestId('down-line')).toBeNull()
    expect(screen.queryByTestId('up-line')).toBeNull()
    expect(container.textContent).not.toContain('NaN')
    expect(container.innerHTML).not.toContain('NaN')
    expect(screen.getByText(copy.dashboard.chart.idleNote)).toBeInTheDocument()
  })

  it('未连接内核时空图改为提示启动内核', () => {
    render(<TrafficChart history={[]} connected={false} />)

    expect(screen.getByText(copy.dashboard.chart.offlineNote)).toBeInTheDocument()
    expect(screen.queryByText(copy.dashboard.chart.idleNote)).toBeNull()
  })

  it('每条折线的点数等于样本数', () => {
    const history = [
      { up: 0, down: 0 },
      { up: 1024, down: 2048 },
      { up: 512, down: 4096 },
      { up: 0, down: 1024 },
      { up: 256, down: 0 }
    ]
    render(<TrafficChart history={history} />)

    expect(pointCount(screen.getByTestId('down-line').getAttribute('d'))).toBe(history.length)
    expect(pointCount(screen.getByTestId('up-line').getAttribute('d'))).toBe(history.length)
    expect(screen.queryByTestId('chart-baseline')).toBeNull()
  })

  it('单点历史也能画出合法路径', () => {
    render(<TrafficChart history={[{ up: 10, down: 20 }]} />)
    const d = screen.getByTestId('down-line').getAttribute('d')
    expect(d).not.toContain('NaN')
    expect(pointCount(d)).toBe(1)
  })

  it('大量样本时也不产生 NaN', () => {
    const history = Array.from({ length: 60 }, (_, index) => ({
      up: index * 1000,
      down: (59 - index) * 1000
    }))
    const { container } = render(<TrafficChart history={history} />)

    expect(container.innerHTML).not.toContain('NaN')
    expect(pointCount(screen.getByTestId('down-line').getAttribute('d'))).toBe(60)
  })

  it('两条线共用纵轴，上行不会因为峰值小而被拉满', () => {
    render(
      <TrafficChart
        history={[
          { up: 100, down: 10_000 },
          { up: 100, down: 20_000 }
        ]}
      />
    )

    const down = screen.getByTestId('down-line').getAttribute('d') ?? ''
    const up = screen.getByTestId('up-line').getAttribute('d') ?? ''
    // 下载峰值贴顶（y 接近 TOP_PADDING=10），上传远低于它
    const lastDownY = Number(/L[\d.]+,([\d.]+)$/.exec(down)?.[1])
    const lastUpY = Number(/L[\d.]+,([\d.]+)$/.exec(up)?.[1])
    expect(lastDownY).toBeCloseTo(10, 1)
    expect(lastUpY).toBeGreaterThan(lastDownY + 100)
  })

  it('超过 60 个样本时只画最近 60 个', () => {
    const history = Array.from({ length: 90 }, (_, index) => ({ up: index, down: index * 2 }))
    render(<TrafficChart history={history} />)

    // 组件内部裁剪，契约不依赖调用方
    expect(pointCount(screen.getByTestId('down-line').getAttribute('d'))).toBe(60)
  })

  it('有数据时显示峰值与平均 chip', () => {
    render(
      <TrafficChart
        history={[
          { up: 0, down: 1024 * 1024 },
          { up: 0, down: 1024 * 1024 * 2 }
        ]}
      />
    )

    // chip 明确是下载口径：纵轴峰值是上下行共用的，标签不能说成「最高」
    expect(screen.getByText(`${copy.dashboard.chart.peak} 2.00 MB/s`)).toBeInTheDocument()
    expect(screen.getByText(`${copy.dashboard.chart.average} 1.50 MB/s`)).toBeInTheDocument()
  })
})
