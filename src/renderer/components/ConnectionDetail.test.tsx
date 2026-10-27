import { render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { copy } from '../copy'
import { formatClock, UNKNOWN } from '../format'
import { makeConnection } from '../test-utils'
import { ConnectionDetail, CONNECTION_DETAIL_HEIGHT } from './ConnectionDetail'

const NOW = new Date(2026, 0, 2, 13, 42, 10).getTime()

describe('ConnectionDetail', () => {
  it('四个分组齐全：链路、规则、进程、数据', () => {
    render(<ConnectionDetail connection={makeConnection()} />)

    expect(screen.getByText(copy.connections.detail.chain)).toBeInTheDocument()
    expect(screen.getByText(copy.connections.detail.rule)).toBeInTheDocument()
    expect(screen.getByText(copy.connections.detail.process)).toBeInTheDocument()
    expect(screen.getByText(copy.connections.detail.data)).toBeInTheDocument()
  })

  it('完整链路不省略中间层：Proxy ▸ Auto ▸ HK-01', () => {
    render(
      <ConnectionDetail connection={makeConnection({ chains: ['Proxy', 'Auto', 'HK-01'] })} />
    )

    expect(screen.getByText('Proxy ▸ Auto ▸ HK-01')).toBeInTheDocument()
    expect(screen.queryByText('Proxy ▸ … ▸ HK-01')).toBeNull()
  })

  it('命中规则拼成 DomainSuffix(github.com)', () => {
    render(<ConnectionDetail connection={makeConnection()} />)

    expect(screen.getByText('DomainSuffix(github.com)')).toBeInTheDocument()
  })

  it('数据组显示上下行、起止时间、协议与目标地址', () => {
    const connection = makeConnection({ startedAt: NOW - 4_000, ended: true, endedAt: NOW })
    render(<ConnectionDetail connection={connection} />)

    expect(screen.getByText('↑2.0 KB ↓4.0 KB')).toBeInTheDocument()
    expect(
      screen.getByText(
        `${copy.connections.detail.start} ${formatClock(NOW - 4_000)} · ${copy.connections.detail.end} ${formatClock(NOW)}`
      )
    ).toBeInTheDocument()
    expect(screen.getByText('tcp · 140.82.112.3:443')).toBeInTheDocument()
  })

  it('字段缺失时四组都显示破折号，绝不出现 undefined / NaN', () => {
    const connection = makeConnection({
      chains: [],
      rule: null,
      rulePayload: null,
      process: null,
      processPath: null,
      network: null,
      destinationIp: null,
      destinationPort: null,
      startedAt: null,
      endedAt: null,
      upload: 0,
      download: 0
    })
    const { container } = render(<ConnectionDetail connection={connection} />)

    const text = container.textContent ?? ''
    expect(text).not.toContain('undefined')
    expect(text).not.toContain('NaN')
    // 链路、规则、进程名、进程路径各一个独立的破折号。
    expect(screen.getAllByText(UNKNOWN)).toHaveLength(4)
    // 起止时间与「协议 · 目标」各自拼成一行，整体是破折号而不是空串。
    expect(
      screen.getByText(
        `${copy.connections.detail.start} ${UNKNOWN} · ${copy.connections.detail.end} ${UNKNOWN}`
      )
    ).toBeInTheDocument()
    expect(screen.getByText(`${UNKNOWN} · ${UNKNOWN}`)).toBeInTheDocument()
    // 流量为零是真实值，不写成破折号。
    expect(screen.getByText('↑0 B ↓0 B')).toBeInTheDocument()
  })

  it('活跃连接的结束时间是未知，不编造结束时刻', () => {
    const connection = makeConnection({ ended: false, endedAt: null })
    render(<ConnectionDetail connection={connection} />)

    expect(
      screen.getByText(
        `${copy.connections.detail.start} ${formatClock(connection.startedAt as number)} · ${copy.connections.detail.end} ${UNKNOWN}`
      )
    ).toBeInTheDocument()
  })

  it('详情高度常量与 tokens.css 的 --conn-detail-height 一致', () => {
    const tokensPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'styles',
      'tokens.css'
    )
    const tokens = readFileSync(tokensPath, 'utf8')
    const match = tokens.match(/--conn-detail-height:\s*(\d+)px/)

    expect(match?.[1]).toBe(String(CONNECTION_DETAIL_HEIGHT))
  })
})
