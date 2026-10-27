import { render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { ConnectionView } from '../../shared/ipc'
import { copy } from '../copy'
import { formatClock, UNKNOWN } from '../format'
import { makeConnection } from '../test-utils'
import { ConnectionRow, CONNECTION_ROW_HEIGHT } from './ConnectionRow'

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

  it('行容器带 role=row、单元格带 role=gridcell', () => {
    const connection = makeConnection()
    render(<ConnectionRow connection={connection} now={NOW} rowIndex={2} />)

    const row = screen.getByRole('row')
    expect(row).toHaveAttribute('aria-rowindex', '2')
    expect(row).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getAllByRole('gridcell')).toHaveLength(6)
  })

  it('展开与选中状态通过 aria 暴露给辅助技术', () => {
    const connection = makeConnection()
    const { rerender } = render(
      <ConnectionRow connection={connection} now={NOW} selected expanded rowIndex={2} />
    )

    const row = screen.getByRole('row')
    expect(row).toHaveAttribute('aria-selected', 'true')
    expect(row).toHaveAttribute('aria-expanded', 'true')

    rerender(<ConnectionRow connection={connection} now={NOW} rowIndex={2} />)

    expect(screen.getByRole('row')).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByRole('row')).toHaveAttribute('aria-expanded', 'false')
  })

  it('已结束 / 被拒绝状态有屏幕阅读器可读文本，不依赖 title', () => {
    const ended = makeConnection({ ended: true, endedAt: NOW })
    const { rerender } = render(<ConnectionRow connection={ended} now={NOW} />)

    expect(screen.getByText(copy.connections.ended)).toHaveClass('conn-sr-only')
    expect(screen.queryByTitle(copy.connections.ended)).toBeNull()

    rerender(<ConnectionRow connection={makeConnection({ chains: ['REJECT'] })} now={NOW} />)

    expect(screen.getByText(copy.connections.rejected)).toHaveClass('conn-sr-only')

    rerender(
      <ConnectionRow
        connection={makeConnection({ chains: ['REJECT-DROP'], ended: true, endedAt: NOW })}
        now={NOW}
      />
    )

    expect(screen.getByText(copy.connections.ended)).toHaveClass('conn-sr-only')
    expect(screen.getByText(copy.connections.rejected)).toHaveClass('conn-sr-only')
  })

  it('行高常量与 tokens.css 的 --conn-row-height 一致', () => {
    const tokensPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'styles',
      'tokens.css'
    )
    const tokens = readFileSync(tokensPath, 'utf8')
    const match = tokens.match(/--conn-row-height:\s*(\d+)px/)

    expect(match?.[1]).toBe(String(CONNECTION_ROW_HEIGHT))
  })
})
