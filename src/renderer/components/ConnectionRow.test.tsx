import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ConnectionView } from '../../shared/ipc'
import { copy } from '../copy'
import { formatClock, UNKNOWN } from '../format'
import { makeConnection } from '../test-utils'
import { ConnectionRow } from './ConnectionRow'

const NOW = new Date(2026, 0, 2, 13, 42, 10).getTime()

function cellTexts(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.conn-row > .conn-cell')).map(
    (cell) => cell.textContent ?? ''
  )
}

/** 稳定的渲染计数器：传给行组件，自身不参与显示。 */
function makeCounter(): { onRender: (id: string) => void; count: (id: string) => number } {
  const counts = new Map<string, number>()
  return {
    onRender: (id) => {
      counts.set(id, (counts.get(id) ?? 0) + 1)
    },
    count: (id) => counts.get(id) ?? 0
  }
}

describe('ConnectionRow', () => {
  it('六个单元格齐全，时间用 HH:mm:ss', () => {
    const connection = makeConnection({ startedAt: NOW - 4_000 })
    const { container } = render(<ConnectionRow connection={connection} now={NOW} />)

    expect(cellTexts(container)).toEqual([
      formatClock(connection.startedAt as number),
      'chrome',
      'github.com',
      'Proxy ▸ HK-01',
      '↑2.0 KB ↓4.0 KB',
      '00:00:04'
    ])
  })

  it('process 与 host 都缺失时显示破折号，绝不出现 undefined / NaN', () => {
    const connection = makeConnection({
      startedAt: null,
      process: null,
      host: null,
      destinationIp: null,
      chains: []
    })
    const { container } = render(<ConnectionRow connection={connection} now={NOW} />)

    expect(cellTexts(container)).toEqual([UNKNOWN, UNKNOWN, UNKNOWN, UNKNOWN, '↑2.0 KB ↓4.0 KB', UNKNOWN])
    expect(container.textContent).not.toContain('undefined')
    expect(container.textContent).not.toContain('NaN')
  })

  it('host 缺失时退回目标 IP', () => {
    const connection = makeConnection({ host: null, destinationIp: '1.1.1.1' })
    const { container } = render(<ConnectionRow connection={connection} now={NOW} />)

    expect(cellTexts(container)[2]).toBe('1.1.1.1')
  })

  it('流量为真实零时写 0 B，不写破折号', () => {
    const connection = makeConnection({ upload: 0, download: 0 })
    const { container } = render(<ConnectionRow connection={connection} now={NOW} />)

    expect(cellTexts(container)[4]).toBe('↑0 B ↓0 B')
  })

  it('已反转的 chains 首尾两段：Proxy ▸ … ▸ HK', () => {
    const connection = makeConnection({ chains: ['Proxy', 'Auto', 'HK'] })
    const { container } = render(<ConnectionRow connection={connection} now={NOW} />)

    expect(cellTexts(container)[3]).toBe('Proxy ▸ … ▸ HK')
  })

  it('单段直出不加分隔符', () => {
    const connection = makeConnection({ chains: ['DIRECT'] })
    const { container } = render(<ConnectionRow connection={connection} now={NOW} />)

    expect(cellTexts(container)[3]).toBe('DIRECT')
  })

  it('已结束行带 ended 类与空心圆点', () => {
    const connection = makeConnection({ ended: true, endedAt: NOW })
    const { container } = render(<ConnectionRow connection={connection} now={NOW} />)

    expect(container.querySelector('.conn-row.ended')).not.toBeNull()
    expect(container.querySelector('.conn-dot.ended')).not.toBeNull()
  })

  it('被拒绝行带 rejected 类与红色系标记', () => {
    const connection = makeConnection({ chains: ['Proxy', 'REJECT'] })
    const { container } = render(<ConnectionRow connection={connection} now={NOW} />)

    expect(container.querySelector('.conn-row.rejected')).not.toBeNull()
    expect(container.querySelector('.conn-dot.rejected')).not.toBeNull()
  })

  it('既结束又被拒绝时同时保留两种标记', () => {
    const connection = makeConnection({ chains: ['REJECT-DROP'], ended: true, endedAt: NOW })
    const { container } = render(<ConnectionRow connection={connection} now={NOW} />)

    expect(container.querySelector('.conn-row.ended.rejected')).not.toBeNull()
    expect(container.querySelector('.conn-dot.ended.rejected')).not.toBeNull()
  })

  it('已结束行时长冻结在 endedAt，now 前进不重渲染', () => {
    const connection = makeConnection({ startedAt: NOW - 4_000, ended: true, endedAt: NOW })
    const counter = makeCounter()
    const { rerender } = render(
      <ConnectionRow connection={connection} now={NOW} onRender={counter.onRender} />
    )

    expect(screen.getByText('00:00:04')).toBeInTheDocument()

    rerender(
      <ConnectionRow connection={connection} now={NOW + 30_000} onRender={counter.onRender} />
    )

    expect(screen.getByText('00:00:04')).toBeInTheDocument()
    expect(counter.count(connection.id)).toBe(1)
  })

  it('活跃行时长随时钟推进，时间前进会重渲染', () => {
    const connection = makeConnection({ startedAt: NOW - 4_000 })
    const counter = makeCounter()
    const { rerender } = render(
      <ConnectionRow connection={connection} now={NOW} onRender={counter.onRender} />
    )

    rerender(
      <ConnectionRow connection={connection} now={NOW + 2_000} onRender={counter.onRender} />
    )

    expect(screen.getByText('00:00:06')).toBeInTheDocument()
    expect(counter.count(connection.id)).toBe(2)
  })

  it('自身字段不变时不重渲染，即使快照给了新的对象与 chains 副本', () => {
    const connection = makeConnection({ startedAt: NOW - 4_000 })
    const counter = makeCounter()
    const { rerender } = render(
      <ConnectionRow connection={connection} now={NOW} onRender={counter.onRender} />
    )

    const copyOfConnection: ConnectionView = { ...connection, chains: [...connection.chains] }
    rerender(<ConnectionRow connection={copyOfConnection} now={NOW} onRender={counter.onRender} />)

    expect(counter.count(connection.id)).toBe(1)
  })

  it('自身字段变化时只重渲染这一行', () => {
    const connection = makeConnection({ startedAt: NOW - 4_000 })
    const counter = makeCounter()
    const { rerender } = render(
      <ConnectionRow connection={connection} now={NOW} onRender={counter.onRender} />
    )

    rerender(
      <ConnectionRow
        connection={{ ...connection, upload: connection.upload + 1 }}
        now={NOW}
        onRender={counter.onRender}
      />
    )

    expect(counter.count(connection.id)).toBe(2)
  })

  it('行容器带 role=row、单元格带 role=cell', () => {
    const connection = makeConnection()
    render(<ConnectionRow connection={connection} now={NOW} />)

    expect(screen.getByRole('row')).toBeInTheDocument()
    expect(screen.getAllByRole('cell')).toHaveLength(6)
    // 状态点只做视觉标记，不进入无障碍名称。
    expect(screen.getByRole('row').textContent).not.toContain(copy.connections.ended)
  })
})
