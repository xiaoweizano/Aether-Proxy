import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { ConnectionView, ConnectionsSnapshot } from '../../shared/ipc'
import { copy } from '../copy'
import { formatClock, UNKNOWN } from '../format'
import { makeAether, makeConnection } from '../test-utils'
import { ConnectionsPage } from './ConnectionsPage'

const RENDERER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function readRendererFile(...parts: string[]): string {
  return readFileSync(path.join(RENDERER_DIR, ...parts), 'utf8')
}

function tokenPx(tokens: string, name: string): number {
  const match = tokens.match(new RegExp(`--${name}:\\s*(\\d+)px`))
  if (match?.[1] === undefined) throw new Error(`缺少 token --${name}`)
  return Number(match[1])
}

const NOW = new Date(2026, 0, 2, 13, 42, 10).getTime()

function snapshotOf(items: ConnectionView[], at = NOW): ConnectionsSnapshot {
  return { items, memory: null, at }
}

function mountPage(items: ConnectionView[], at = NOW) {
  window.aether = makeAether({
    getConnections: vi.fn(async () => snapshotOf(items, at))
  })
  return render(<ConnectionsPage />)
}

function bodyRows(container: HTMLElement): Element[] {
  return Array.from(container.querySelectorAll('.conn-row'))
}

describe('ConnectionsPage', () => {
  it('空列表保留六列列头并显示「暂无连接」', async () => {
    const { container } = mountPage([])

    expect(await screen.findByText(copy.connections.empty)).toBeInTheDocument()
    expect(screen.getAllByRole('columnheader')).toHaveLength(6)
    for (const label of Object.values(copy.connections.columns)) {
      expect(screen.getByRole('columnheader', { name: label })).toBeInTheDocument()
    }
    expect(screen.getByText(copy.connections.count(0))).toBeInTheDocument()
    expect(screen.getByText(copy.connections.window)).toBeInTheDocument()
    expect(bodyRows(container)).toHaveLength(0)
  })

  it('渲染六列内容：时间、进程、域名、出站、流量、时长', async () => {
    const connection = makeConnection({ startedAt: NOW - 4_000 })
    const { container } = mountPage([connection])

    expect(await screen.findByText('chrome')).toBeInTheDocument()
    const cells = Array.from(bodyRows(container)[0]?.querySelectorAll('.conn-cell') ?? []).map(
      (cell) => cell.textContent ?? ''
    )
    expect(cells).toEqual([
      formatClock(connection.startedAt as number),
      'chrome',
      'github.com',
      'Proxy ▸ HK-01',
      '↑2.0 KB ↓4.0 KB',
      '00:00:04'
    ])
  })

  it('process / host 缺失时显示破折号，绝不出现 undefined 或 NaN', async () => {
    const connection = makeConnection({
      startedAt: null,
      process: null,
      host: null,
      destinationIp: null,
      chains: []
    })
    const { container } = mountPage([connection])

    expect(await screen.findByText(copy.connections.count(1))).toBeInTheDocument()
    const text = bodyRows(container)[0]?.textContent ?? ''
    expect(text).toContain(UNKNOWN)
    expect(text).not.toContain('undefined')
    expect(text).not.toContain('NaN')
    expect(screen.getAllByText(UNKNOWN).length).toBeGreaterThanOrEqual(4)
  })

  it('已反转的 chains 显示为 Proxy ▸ … ▸ HK；单段显示 DIRECT', async () => {
    mountPage([
      makeConnection({ id: 'nested', process: 'nested', chains: ['Proxy', 'Auto', 'HK'] }),
      makeConnection({ id: 'direct', process: 'direct', chains: ['DIRECT'] })
    ])

    expect(await screen.findByText('Proxy ▸ … ▸ HK')).toBeInTheDocument()
    expect(screen.getByText('DIRECT')).toBeInTheDocument()
  })

  it('「只看活跃」隐藏已结束行，关闭后恢复', async () => {
    const active = makeConnection({ id: 'active', process: 'active-proc' })
    const ended = makeConnection({
      id: 'ended',
      process: 'ended-proc',
      ended: true,
      endedAt: NOW
    })
    const { container } = mountPage([active, ended])

    expect(await screen.findByText('ended-proc')).toBeInTheDocument()
    expect(container.querySelector('.conn-row.ended')).not.toBeNull()

    const toggle = screen.getByRole('button', { name: copy.connections.activeOnly })
    await userEvent.click(toggle)

    expect(screen.queryByText('ended-proc')).toBeNull()
    expect(screen.getByText('active-proc')).toBeInTheDocument()
    expect(toggle).toHaveAttribute('aria-pressed', 'true')

    await userEvent.click(toggle)

    expect(await screen.findByText('ended-proc')).toBeInTheDocument()
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
  })

  it('搜索不区分大小写，匹配域名与进程名', async () => {
    mountPage([
      makeConnection({ id: 'a', process: 'chrome', host: 'github.com' }),
      makeConnection({ id: 'b', process: 'Code', host: 'api.anthropic.com' })
    ])

    expect(await screen.findByText('chrome')).toBeInTheDocument()
    const search = screen.getByRole('searchbox', { name: copy.connections.searchLabel })

    await userEvent.type(search, 'GITHUB')
    expect(screen.getByText('chrome')).toBeInTheDocument()
    expect(screen.queryByText('Code')).toBeNull()

    await userEvent.clear(search)
    await userEvent.type(search, 'cOdE')
    expect(screen.getByText('Code')).toBeInTheDocument()
    expect(screen.queryByText('chrome')).toBeNull()
  })

  it('没有匹配项时显示「没有匹配的连接」，列头仍在', async () => {
    mountPage([makeConnection({ id: 'a', process: 'chrome', host: 'github.com' })])

    expect(await screen.findByText('chrome')).toBeInTheDocument()
    await userEvent.type(
      screen.getByRole('searchbox', { name: copy.connections.searchLabel }),
      'no-such-host'
    )

    expect(screen.getByText(copy.connections.noMatches)).toBeInTheDocument()
    expect(screen.getAllByRole('columnheader')).toHaveLength(6)
  })

  it('默认按建立时间倒序，点时间列头切换方向', async () => {
    const older = makeConnection({ id: 'older', process: 'older-proc', startedAt: NOW - 5_000 })
    const newer = makeConnection({ id: 'newer', process: 'newer-proc', startedAt: NOW - 1_000 })
    const { container } = mountPage([older, newer])

    expect(await screen.findByText('newer-proc')).toBeInTheDocument()
    expect(bodyRows(container)[0]?.textContent).toContain('newer-proc')

    const timeHeader = screen.getByRole('columnheader', { name: copy.connections.columns.time })
    expect(timeHeader).toHaveAttribute('aria-sort', 'descending')

    await userEvent.click(screen.getByRole('button', { name: copy.connections.columns.time }))

    expect(bodyRows(container)[0]?.textContent).toContain('older-proc')
    expect(timeHeader).toHaveAttribute('aria-sort', 'ascending')
  })

  it('建立时刻相同的连接在两次快照之间保持相对顺序', async () => {
    const first = makeConnection({ id: 'same-1', process: 'first-proc', startedAt: NOW })
    const second = makeConnection({ id: 'same-2', process: 'second-proc', startedAt: NOW })
    let push: ((next: ConnectionsSnapshot) => void) | undefined
    window.aether = makeAether({
      getConnections: vi.fn(async () => snapshotOf([first, second])),
      onConnections: (cb) => {
        push = cb
        return () => {}
      }
    })
    const { container } = render(<ConnectionsPage />)

    expect(await screen.findByText('first-proc')).toBeInTheDocument()
    const ids = (): (string | null)[] =>
      bodyRows(container).map((row) => row.getAttribute('data-connection-id'))
    expect(ids()).toEqual(['same-1', 'same-2'])

    // 下一帧给每条连接新的对象与 chains 副本，但顺序不变。
    act(() => {
      push?.(
        snapshotOf(
          [
            { ...first, chains: [...first.chains] },
            { ...second, chains: [...second.chains] }
          ],
          NOW + 500
        )
      )
    })

    expect(ids()).toEqual(['same-1', 'same-2'])
  })

  it('被拒绝的连接带 red-family 标记', async () => {
    const { container } = mountPage([
      makeConnection({ id: 'reject', process: 'blocked', chains: ['Proxy', 'REJECT'] })
    ])

    expect(await screen.findByText('blocked')).toBeInTheDocument()
    expect(container.querySelector('.conn-row.rejected')).not.toBeNull()
    expect(container.querySelector('.conn-dot.rejected')).not.toBeNull()
  })

  it('2000 条时只挂载视口附近的行', async () => {
    const items = Array.from({ length: 2000 }, (_, index) =>
      makeConnection({
        id: `c${index}`,
        process: `proc-${index}`,
        host: `host-${index}.example.com`,
        startedAt: NOW - index * 1_000
      })
    )
    const { container } = mountPage(items)

    expect(await screen.findByText(copy.connections.count(2000))).toBeInTheDocument()
    const table = screen.getByRole('table', { name: copy.connections.label })
    expect(table).toHaveAttribute('aria-rowcount', '2001')
    expect(table).toHaveAttribute('aria-colcount', '6')
    const rows = bodyRows(container)
    const viewportRows = Math.ceil(600 / 28)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.length).toBeLessThanOrEqual(viewportRows + 2)
    expect(rows.length).toBeLessThan(100)
  })

  it('收到新推送后更新列表', async () => {
    let push: ((next: ConnectionsSnapshot) => void) | undefined
    window.aether = makeAether({
      getConnections: vi.fn(async () => snapshotOf([])),
      onConnections: (cb) => {
        push = cb
        return () => {}
      }
    })
    render(<ConnectionsPage />)

    expect(await screen.findByText(copy.connections.empty)).toBeInTheDocument()

    act(() => {
      push?.(snapshotOf([makeConnection({ id: 'pushed', process: 'pushed-proc' })]))
    })

    expect(await screen.findByText('pushed-proc')).toBeInTheDocument()
    expect(screen.queryByText(copy.connections.empty)).toBeNull()
  })
})

describe('ConnectionsPage layout', () => {
  it('1024px 最小窗口下域名列吸收剩余宽度，不裁列', () => {
    const css = readRendererFile('styles', 'app.css')
    const tokens = readRendererFile('styles', 'tokens.css')
    const grid = css.match(/\.conn-grid\s*\{[^}]*\}/)?.[0] ?? ''

    expect(grid).toContain('grid-template-columns')
    expect(grid).toContain('minmax(0, 1fr)')
    expect(grid).not.toContain('minmax(var(--conn-col-host)')

    const fixed =
      tokenPx(tokens, 'conn-col-time') +
      tokenPx(tokens, 'conn-col-process') +
      tokenPx(tokens, 'conn-col-outbound') +
      tokenPx(tokens, 'conn-col-traffic') +
      tokenPx(tokens, 'conn-col-duration')
    const gap = tokenPx(tokens, 'space-3')
    const rowPadding = 2 * tokenPx(tokens, 'space-3')
    const mainPadding = 2 * tokenPx(tokens, 'space-6')
    const sidebarMatch = css.match(/\.shell\s*\{[^}]*grid-template-columns:\s*(\d+)px/)
    expect(sidebarMatch?.[1]).toBeDefined()
    const sidebar = Number(sidebarMatch?.[1])

    // BrowserWindow minWidth = 1024（产品决定，不抬高）；减去侧栏、主区留白、
    // 表格边框与行留白后，域名列必须仍为正数，才不会被裁掉。
    const windowWidth = 1024
    const tableBorder = 2
    const hostTrack =
      windowWidth - sidebar - mainPadding - tableBorder - rowPadding - 5 * gap - fixed

    expect(hostTrack).toBeGreaterThan(0)
  })

  it('表头行与表体行共用 conn-grid 这一份网格定义', async () => {
    const { container } = mountPage([makeConnection()])

    expect(await screen.findByText('chrome')).toBeInTheDocument()
    expect(container.querySelector('.conn-head-row')).toHaveClass('conn-grid')
    expect(container.querySelector('.conn-row')).toHaveClass('conn-grid')
  })
})
