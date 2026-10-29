import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { ProxyGroupView } from '../../shared/ipc'
import type { AppContext } from '../bootstrap'
import type { CoreLink } from '../core/link'
import { CoreLink as RealCoreLink } from '../core/link'
import {
  TRAY_ID,
  buildTrayMenu,
  createTray,
  createTrayActions,
  menuSignature,
  readTraySnapshot,
  toMenuTemplate,
  trayStatusLine,
  type TrayActions,
  type TrayMenuItem,
  type TraySnapshot
} from './tray'
import { trayCopy } from './copy'

/** 真实 mihomo `/proxies` 形状（GLOBAL 永远在、排在用户组前面）。 */
function realGroups(): ProxyGroupView[] {
  const raw = JSON.parse(
    readFileSync(path.join(process.cwd(), 'test', 'fixtures', 'proxies.json'), 'utf8')
  ) as {
    proxies: Record<
      string,
      { name: string; type: string; now?: string; fixed?: string; all?: string[]; history?: { delay: number }[] }
    >
  }
  const out: ProxyGroupView[] = []
  for (const entry of Object.values(raw.proxies)) {
    if (!Array.isArray(entry.all)) continue
    const group: ProxyGroupView = {
      name: entry.name,
      type: entry.type,
      now: entry.now ?? '',
      nodes: entry.all.map((name) => ({ name }))
    }
    if (entry.fixed !== undefined && entry.fixed !== '') group.fixed = entry.fixed
    out.push(group)
  }
  return out
}

function snapshot(over: Partial<TraySnapshot> = {}): TraySnapshot {
  return {
    status: 'ready',
    mode: 'rule',
    proxyEnabled: false,
    proxyAvailable: true,
    activeNode: 'HK-01',
    groups: realGroups(),
    ...over
  }
}

function noopActions(over: Partial<TrayActions> = {}): TrayActions {
  return {
    setProxyEnabled: async () => true,
    switchNode: async () => true,
    openWindow: () => {},
    quit: () => {},
    ...over
  }
}

function item(items: readonly TrayMenuItem[], id: string): TrayMenuItem {
  const found = items.find((entry) => entry.id === id)
  if (found === undefined) throw new Error(`菜单里没有 ${id}`)
  return found
}

/** 在指定策略组下找一个节点项；同名节点可能出现在多个组里。 */
function findNodeIn(items: readonly TrayMenuItem[], groupLabel: string, nodeLabel: string): TrayMenuItem {
  const group = item(items, TRAY_ID.switchRoot).submenu?.find((entry) => entry.label === groupLabel)
  const node = group?.submenu?.find((entry) => entry.label === nodeLabel)
  if (node === undefined) throw new Error(`组 ${groupLabel} 里没有节点 ${nodeLabel}`)
  return node
}

/** 某个组里被勾选的节点名。 */
function checkedIn(items: readonly TrayMenuItem[], groupLabel: string): string[] {
  const group = item(items, TRAY_ID.switchRoot).submenu?.find((entry) => entry.label === groupLabel)
  return (group?.submenu ?? []).filter((entry) => entry.checked === true).map((entry) => entry.label ?? '')
}

interface FakeHost {
  apply: ReturnType<typeof vi.fn>
  activate: (() => void) | null
  disposed: boolean
  host: {
    apply(items: readonly TrayMenuItem[], tooltip: string): void
    onActivate(handler: () => void): void
    dispose(): void
  }
}

function fakeHost(): FakeHost {
  const state: FakeHost = {
    apply: vi.fn(),
    activate: null,
    disposed: false,
    host: {
      apply(items, tooltip) {
        state.apply(items, tooltip)
      },
      onActivate(handler) {
        state.activate = handler
      },
      dispose() {
        state.disposed = true
      }
    }
  }
  return state
}

describe('托盘菜单模型', () => {
  it('顺序与设计文档一致：状态行、分隔线、系统代理、切换节点、打开主窗口、退出', () => {
    const items = buildTrayMenu(snapshot(), noopActions())
    expect(items.map((entry) => entry.type)).toEqual([
      'normal',
      'separator',
      'checkbox',
      'submenu',
      'normal',
      'normal'
    ])
    expect(items.map((entry) => entry.label)).toEqual([
      'HK-01 · 规则',
      undefined,
      '系统代理',
      '切换节点',
      '打开主窗口',
      '退出'
    ])
    expect(items.map((entry) => entry.id)).toEqual([
      TRAY_ID.status,
      TRAY_ID.separator,
      TRAY_ID.proxy,
      TRAY_ID.switchRoot,
      TRAY_ID.openWindow,
      TRAY_ID.quit
    ])
  })

  it('状态行是只读的：禁用态，且没有点击处理器', () => {
    const status = item(buildTrayMenu(snapshot(), noopActions()), TRAY_ID.status)
    expect(status.enabled).toBe(false)
    expect(status.click).toBeUndefined()
  })

  it('状态行的模式部分跟随当前模式', () => {
    for (const [mode, text] of [
      ['rule', '规则'],
      ['global', '全局'],
      ['direct', '直连']
    ] as const) {
      expect(item(buildTrayMenu(snapshot({ mode }), noopActions()), TRAY_ID.status).label).toBe(
        `HK-01 · ${text}`
      )
    }
  })

  it('内核没在运行：状态行说事实，不编造节点名', () => {
    const cases = [
      ['no-config', '没有配置'],
      ['config-error', '配置有误'],
      ['core-error', '内核未运行'],
      ['in-use', '另一个实例运行中'],
      ['reconnecting', '内核重连中']
    ] as const
    for (const [status, text] of cases) {
      const line = trayStatusLine({ status, mode: 'rule', activeNode: null })
      expect(line).toBe(`${text} · 规则`)
    }
  })

  it('ready 但没有可用节点：用破折号，不冒充一个节点', () => {
    expect(trayStatusLine({ status: 'ready', mode: 'direct', activeNode: null })).toBe('— · 直连')
  })

  it('系统代理的勾选态来自实际状态，不是上一次动作', () => {
    const off = item(buildTrayMenu(snapshot({ proxyEnabled: false }), noopActions()), TRAY_ID.proxy)
    const on = item(buildTrayMenu(snapshot({ proxyEnabled: true }), noopActions()), TRAY_ID.proxy)
    expect(off.checked).toBe(false)
    expect(on.checked).toBe(true)
  })

  it('内核没起来时不能开启系统代理，但已经开着时必须还能关', () => {
    const unavailable = item(
      buildTrayMenu(snapshot({ proxyAvailable: false, proxyEnabled: false }), noopActions()),
      TRAY_ID.proxy
    )
    expect(unavailable.enabled).toBe(false)
    const stillOn = item(
      buildTrayMenu(snapshot({ proxyAvailable: false, proxyEnabled: true }), noopActions()),
      TRAY_ID.proxy
    )
    expect(stillOn.enabled).toBe(true)
  })

  it('点击系统代理请求的是「取反后的目标状态」', () => {
    const calls: boolean[] = []
    const actions = noopActions({
      setProxyEnabled: async (enabled) => {
        calls.push(enabled)
        return true
      }
    })
    void item(buildTrayMenu(snapshot({ proxyEnabled: true }), actions), TRAY_ID.proxy).click?.()
    void item(buildTrayMenu(snapshot({ proxyEnabled: false }), actions), TRAY_ID.proxy).click?.()
    expect(calls).toEqual([false, true])
  })

  it('GLOBAL 不出现在「切换节点」子菜单里', () => {
    const items = buildTrayMenu(snapshot(), noopActions())
    const root = item(items, TRAY_ID.switchRoot)
    expect(root.submenu?.map((entry) => entry.label)).toEqual(['Auto', 'Proxy'])
    expect(JSON.stringify(root.submenu)).not.toContain('GLOBAL')
  })

  it('子菜单是「策略组 → 节点」两级', () => {
    const root = item(buildTrayMenu(snapshot(), noopActions()), TRAY_ID.switchRoot)
    const proxy = root.submenu?.find((entry) => entry.label === 'Proxy')
    expect(proxy?.type).toBe('submenu')
    expect(proxy?.submenu?.map((entry) => entry.label)).toEqual(['HK-01', 'US-01', 'Auto', 'DIRECT'])
  })

  it('手选组（Selector）的勾跟随 now', () => {
    const groups = realGroups().map((group) =>
      group.name === 'Proxy' ? { ...group, now: 'US-01' } : group
    )
    const items = buildTrayMenu(snapshot({ groups, activeNode: 'US-01' }), noopActions())
    expect(checkedIn(items, 'Proxy')).toEqual(['US-01'])
    expect(checkedIn(items, 'Auto')).toEqual(['DIRECT'])
  })

  it('自动组（URLTest）的勾跟随 fixed：内核只写 fixed、不改 now', () => {
    const groups = realGroups().map((group) =>
      group.name === 'Auto' ? { ...group, now: 'DIRECT', fixed: 'HK-01' } : group
    )
    const items = buildTrayMenu(snapshot({ groups }), noopActions())
    // now 是 DIRECT，但 fixed 才是内核真正采纳的选择。
    expect(checkedIn(items, 'Auto')).toEqual(['HK-01'])
  })

  it('自动组没有 fixed 时退回 now（内核的自动结果）', () => {
    const groups = realGroups().map((group) =>
      group.name === 'Auto' ? { ...group, now: 'US-01' } : group
    )
    const items = buildTrayMenu(snapshot({ groups }), noopActions())
    expect(checkedIn(items, 'Auto')).toEqual(['US-01'])
  })

  it('fixed 是空串时按「没有钉选」处理，不画一个叫空串的选中项', () => {
    const groups = realGroups().map((group) =>
      group.name === 'Auto' ? { ...group, now: 'DIRECT', fixed: '' } : group
    )
    const items = buildTrayMenu(snapshot({ groups }), noopActions())
    expect(checkedIn(items, 'Auto')).toEqual(['DIRECT'])
  })

  it('点节点带上组名与节点名，交给同一套 switchNode', () => {
    const calls: [string, string][] = []
    const actions = noopActions({
      switchNode: async (group, node) => {
        calls.push([group, node])
        return true
      }
    })
    const items = buildTrayMenu(snapshot(), actions)
    void findNodeIn(items, 'Proxy', 'US-01').click?.()
    void findNodeIn(items, 'Auto', 'US-01').click?.()
    expect(calls).toEqual([
      ['Proxy', 'US-01'],
      ['Auto', 'US-01']
    ])
  })

  it('没有可切换的组时：子菜单给一条禁用说明，而不是空菜单', () => {
    const items = buildTrayMenu(snapshot({ groups: [] }), noopActions())
    const root = item(items, TRAY_ID.switchRoot)
    expect(root.enabled).toBe(false)
    expect(root.submenu).toHaveLength(1)
    expect(root.submenu?.[0]?.label).toBe('没有可切换的节点')
    expect(root.submenu?.[0]?.enabled).toBe(false)
  })

  it('只有 GLOBAL 时同样算「没有可切换的组」', () => {
    const groups = realGroups().filter((group) => group.name === 'GLOBAL')
    const root = item(buildTrayMenu(snapshot({ groups }), noopActions()), TRAY_ID.switchRoot)
    expect(root.enabled).toBe(false)
  })

  it('打开主窗口与退出各自调用注入的动作', () => {
    const openWindow = vi.fn()
    const quit = vi.fn()
    const items = buildTrayMenu(snapshot(), noopActions({ openWindow, quit }))
    item(items, TRAY_ID.openWindow).click?.()
    item(items, TRAY_ID.quit).click?.()
    expect(openWindow).toHaveBeenCalledTimes(1)
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('菜单里不含速率：签名在有延迟数据时保持不变', () => {
    const withDelay = realGroups().map((group) => ({
      ...group,
      nodes: group.nodes.map((node) => ({ ...node, delay: 42 }))
    }))
    const plain = buildTrayMenu(snapshot(), noopActions())
    const delayed = buildTrayMenu(snapshot({ groups: withDelay }), noopActions())
    expect(menuSignature(delayed)).toBe(menuSignature(plain))
  })
})

describe('托盘装配层：只在状态变化时重建', () => {
  async function make(deps: {
    snapshots?: TraySnapshot[]
    actions?: Partial<TrayActions>
    error?: (err: unknown) => void
  }): Promise<{
    tray: ReturnType<typeof createTray>
    host: FakeHost
    snapshots: TraySnapshot[]
    actions: TrayActions
    reads: () => number
  }> {
    const queue = deps.snapshots ?? [snapshot()]
    let reads = 0
    const host = fakeHost()
    const base = noopActions(deps.actions)
    const actions: TrayActions = {
      ...base,
      setProxyEnabled: vi.fn(base.setProxyEnabled),
      switchNode: vi.fn(base.switchNode)
    }
    const tray = createTray({
      host: host.host,
      actions,
      readSnapshot: async () => {
        const next = queue[Math.min(reads, queue.length - 1)]
        reads += 1
        if (next === undefined) throw new Error('没有快照')
        return next
      },
      ...(deps.error === undefined ? {} : { onError: deps.error })
    })
    return { tray, host, snapshots: queue, actions, reads: () => reads }
  }

  it('首次刷新会应用一份菜单，并带上悬浮提示', async () => {
    const { tray, host } = await make({})
    await tray.refresh()
    expect(host.apply).toHaveBeenCalledTimes(1)
    expect(tray.buildCount()).toBe(1)
    expect(host.apply.mock.calls[0]?.[1]).toBe('Aether · HK-01 · 规则')
  })

  it('状态没变：重复刷新不重建（速率每秒变化不会触发重建）', async () => {
    const { tray, host } = await make({})
    await tray.refresh()
    await tray.refresh()
    await tray.refresh()
    expect(tray.buildCount()).toBe(1)
    expect(host.apply).toHaveBeenCalledTimes(1)
  })

  it('速率变化（快照里没有速率字段，但每轮延迟都在变）不触发重建', async () => {
    const base = realGroups()
    const tick = (delays: number): TraySnapshot =>
      snapshot({
        groups: base.map((group) => ({
          ...group,
          nodes: group.nodes.map((node) => ({ ...node, delay: delays }))
        }))
      })
    const { tray, host } = await make({ snapshots: [tick(10), tick(20), tick(30), tick(40)] })
    await tray.refresh()
    await tray.refresh()
    await tray.refresh()
    expect(tray.buildCount()).toBe(1)
    expect(host.apply).toHaveBeenCalledTimes(1)
  })

  it('代理开关变化会重建', async () => {
    const { tray, host } = await make({
      snapshots: [snapshot({ proxyEnabled: false }), snapshot({ proxyEnabled: true })]
    })
    await tray.refresh()
    await tray.refresh()
    expect(tray.buildCount()).toBe(2)
    expect(host.apply).toHaveBeenCalledTimes(2)
  })

  it('模式变化会重建', async () => {
    const { tray } = await make({
      snapshots: [snapshot({ mode: 'rule' }), snapshot({ mode: 'global' })]
    })
    await tray.refresh()
    await tray.refresh()
    expect(tray.buildCount()).toBe(2)
  })

  it('节点变化会重建', async () => {
    const groups = realGroups().map((group) =>
      group.name === 'Proxy' ? { ...group, now: 'US-01' } : group
    )
    const { tray } = await make({
      snapshots: [snapshot(), snapshot({ groups, activeNode: 'US-01' })]
    })
    await tray.refresh()
    await tray.refresh()
    expect(tray.buildCount()).toBe(2)
  })

  it('快照读取失败：保留上一份菜单，不画空壳，也不吞掉错误', async () => {
    const errors: unknown[] = []
    const host = fakeHost()
    let fail = false
    const tray = createTray({
      host: host.host,
      actions: noopActions(),
      readSnapshot: async () => {
        if (fail) throw new Error('内核不可达')
        return snapshot()
      },
      onError: (err) => errors.push(err)
    })
    await tray.refresh()
    fail = true
    await tray.refresh()
    expect(tray.buildCount()).toBe(1)
    expect(host.apply).toHaveBeenCalledTimes(1)
    expect(errors).toHaveLength(1)
  })

  it('并发刷新串行执行，不会重复应用同一份菜单', async () => {
    const { tray, host } = await make({})
    await Promise.all([tray.refresh(), tray.refresh(), tray.refresh()])
    expect(host.apply).toHaveBeenCalledTimes(1)
  })

  it('读取途中到达的刷新会在读完后补读一轮，不会停在「动作前」的状态', async () => {
    // 场景：一次读取正在等内核响应，用户此时点了托盘开关；动作完成后请求刷新。
    // 若并进那次在途读取，菜单就会画成动作之前的状态。
    const gate: { release?: () => void } = {}
    const snapshots = [snapshot({ proxyEnabled: false }), snapshot({ proxyEnabled: true })]
    let reads = 0
    const host = fakeHost()
    const tray = createTray({
      host: host.host,
      actions: noopActions(),
      readSnapshot: async () => {
        const index = Math.min(reads, snapshots.length - 1)
        reads += 1
        if (index === 0) {
          await new Promise<void>((resolve) => {
            gate.release = resolve
          })
        }
        return snapshots[index] as TraySnapshot
      }
    })
    const first = tray.refresh()
    // 让刷新真正跑起来并卡在第一次读取上。
    await new Promise((resolve) => setTimeout(resolve, 0))
    // 第一次读取还卡着，此时再来一次刷新。
    const second = tray.refresh()
    gate.release?.()
    await first
    await second
    expect(reads).toBe(2)
    const last = host.apply.mock.calls.at(-1)?.[0] as readonly TrayMenuItem[]
    expect(item(last, TRAY_ID.proxy).checked).toBe(true)
  })

  it('动作失败且状态没变：仍然强制重画，把 Electron 自己翻过去的勾纠正回来', async () => {
    // Electron 在调用 click 前会把复选框自动取反；失败时真实状态不变，
    // 签名与上一份相同。不强制重画就会留下一个「点了但没生效」的勾。
    let enabled = false
    const host = fakeHost()
    const tray = createTray({
      host: host.host,
      // 动作失败：不改 enabled，返回 false。
      actions: noopActions({ setProxyEnabled: async () => false }),
      readSnapshot: async () => snapshot({ proxyEnabled: enabled })
    })
    await tray.refresh()
    expect(tray.buildCount()).toBe(1)
    const first = host.apply.mock.calls[0]?.[0] as readonly TrayMenuItem[]
    expect(item(first, TRAY_ID.proxy).checked).toBe(false)
    // Electron 会先把 checked 翻成 true，再调用 click；这里模拟这个过程。
    enabled = false
    await item(first, TRAY_ID.proxy).click?.()
    expect(tray.buildCount()).toBe(2)
    const second = host.apply.mock.calls[1]?.[0] as readonly TrayMenuItem[]
    expect(item(second, TRAY_ID.proxy).checked).toBe(false)
  })

  it('动作成功、状态改变：正常重建一次（不因为强制重画多画一份）', async () => {
    let enabled = false
    const host = fakeHost()
    const tray = createTray({
      host: host.host,
      actions: noopActions({
        setProxyEnabled: async (next) => {
          enabled = next
          return true
        }
      }),
      readSnapshot: async () => snapshot({ proxyEnabled: enabled })
    })
    await tray.refresh()
    const first = host.apply.mock.calls[0]?.[0] as readonly TrayMenuItem[]
    await item(first, TRAY_ID.proxy).click?.()
    expect(tray.buildCount()).toBe(2)
    expect(host.apply).toHaveBeenCalledTimes(2)
    const second = host.apply.mock.calls[1]?.[0] as readonly TrayMenuItem[]
    expect(item(second, TRAY_ID.proxy).checked).toBe(true)
  })

  it('托盘左键触发打开主窗口', async () => {
    const openWindow = vi.fn()
    const host = fakeHost()
    createTray({
      host: host.host,
      actions: noopActions({ openWindow }),
      readSnapshot: async () => snapshot()
    })
    expect(host.activate).not.toBeNull()
    host.activate?.()
    expect(openWindow).toHaveBeenCalledTimes(1)
  })

  it('动作执行完会重新读快照：勾选态跟上实际状态', async () => {
    // 第一次读到「关」，动作之后读到「开」：勾必须跟到真实状态。
    const { tray, host } = await make({
      snapshots: [snapshot({ proxyEnabled: false }), snapshot({ proxyEnabled: true })]
    })
    await tray.refresh()
    expect(tray.buildCount()).toBe(1)
    const first = host.apply.mock.calls[0]?.[0] as readonly TrayMenuItem[]
    await item(first, TRAY_ID.proxy).click?.()
    expect(tray.buildCount()).toBe(2)
    const second = host.apply.mock.calls[1]?.[0] as readonly TrayMenuItem[]
    expect(item(second, TRAY_ID.proxy).checked).toBe(true)
  })

  it('dispose 之后不再应用菜单，并销毁托盘对象', async () => {
    const { tray, host } = await make({})
    tray.dispose()
    expect(host.disposed).toBe(true)
    await tray.refresh()
    expect(host.apply).not.toHaveBeenCalled()
  })
})

describe('托盘动作：与 IPC 同一套底层操作', () => {
  function context(over: {
    proxyServer?: string | null
    proxyEnabled?: boolean
    link?: CoreLink | null
    enable?: () => Promise<void>
    disable?: () => Promise<void>
  } = {}): {
    ctx: AppContext
    enable: ReturnType<typeof vi.fn>
    disable: ReturnType<typeof vi.fn>
    writes: { proxyEnabled: boolean }[]
    actions: TrayActions
  } {
    const enable = vi.fn(over.enable ?? (async () => {}))
    const disable = vi.fn(over.disable ?? (async () => {}))
    const ctx = {
      proxyServer: over.proxyServer === undefined ? '127.0.0.1:7891' : over.proxyServer,
      proxyEnabled: over.proxyEnabled ?? false,
      controller: { enable, disable },
      link: over.link ?? null,
      startupStatus: 'ready'
    } as unknown as AppContext
    const writes: { proxyEnabled: boolean }[] = []
    const actions = createTrayActions({
      ctx,
      // 用注入的持久化：测试不碰真实文件，同时断言「落盘的是动作之后的状态」。
      settingsFile: path.join(process.cwd(), 'test-tmp', 'settings.json'),
      writeSettingsFn: async (_file, settings) => {
        writes.push(settings)
      },
      openWindow: () => {},
      quit: () => {}
    })
    return { ctx, enable, disable, writes, actions }
  }

  it('开启成功：写入系统代理，实际状态改成 true 并落盘', async () => {
    const { ctx, enable, writes, actions } = context()
    expect(await actions.setProxyEnabled(true)).toBe(true)
    expect(enable).toHaveBeenCalledWith('127.0.0.1:7891')
    expect(ctx.proxyEnabled).toBe(true)
    expect(writes).toEqual([{ proxyEnabled: true }])
  })

  it('开启失败：勾选态保持关闭（proxyEnabled 不变），也不落盘', async () => {
    const { ctx, enable, writes, actions } = context({
      enable: async () => {
        throw new Error('注册表写入失败')
      }
    })
    expect(await actions.setProxyEnabled(true)).toBe(false)
    expect(enable).toHaveBeenCalledTimes(1)
    expect(ctx.proxyEnabled).toBe(false)
    expect(writes).toEqual([])
    // 失败后菜单按实际状态重建：没有勾。
    expect(
      item(buildTrayMenu(snapshot({ proxyEnabled: ctx.proxyEnabled }), actions), TRAY_ID.proxy).checked
    ).toBe(false)
  })

  it('内核没起来：开启直接失败，不去写一个死端口', async () => {
    const { ctx, enable, actions } = context({ proxyServer: null })
    expect(await actions.setProxyEnabled(true)).toBe(false)
    expect(enable).not.toHaveBeenCalled()
    expect(ctx.proxyEnabled).toBe(false)
  })

  it('关闭失败：不假装已关闭，也不落盘', async () => {
    const { ctx, writes, actions } = context({
      proxyEnabled: true,
      disable: async () => {
        throw new Error('还原失败')
      }
    })
    expect(await actions.setProxyEnabled(false)).toBe(false)
    expect(ctx.proxyEnabled).toBe(true)
    expect(writes).toEqual([])
  })

  it('关闭成功：proxyEnabled 变成 false 并落盘', async () => {
    const { ctx, disable, writes, actions } = context({ proxyEnabled: true })
    expect(await actions.setProxyEnabled(false)).toBe(true)
    expect(disable).toHaveBeenCalledTimes(1)
    expect(ctx.proxyEnabled).toBe(false)
    expect(writes).toEqual([{ proxyEnabled: false }])
  })

  it('切换节点走 CoreLink.switchNode；内核不在时直接失败', async () => {
    const calls: string[] = []
    const fn = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${String(input)} ${String(init?.body ?? '')}`)
      return { ok: true, status: 204, json: async () => ({}) } as Response
    }) as unknown as typeof fetch
    const link = new RealCoreLink('http://127.0.0.1:9090', 'top-secret', fn)
    const { actions } = context({ link })
    expect(await actions.switchNode('Proxy', 'US-01')).toBe(true)
    expect(calls).toEqual(['PUT http://127.0.0.1:9090/proxies/Proxy {"name":"US-01"}'])

    const withoutLink = context({ link: null }).actions
    expect(await withoutLink.switchNode('Proxy', 'US-01')).toBe(false)
  })

  it('切换节点失败（内核拒绝）如实返回 false', async () => {
    const fn = (async () =>
      ({ ok: false, status: 400, json: async () => ({}) }) as Response) as unknown as typeof fetch
    const link = new RealCoreLink('http://127.0.0.1:9090', 'secret', fn)
    const { actions } = context({ link })
    expect(await actions.switchNode('Proxy', '不存在的节点')).toBe(false)
  })

  it('退出调用注入的 quit（生产实现是 app.quit，走 before-quit 的 stopAll）', () => {
    const quit = vi.fn()
    const actions = createTrayActions({
      ctx: context().ctx,
      settingsFile: path.join(process.cwd(), 'test-tmp', 'settings.json'),
      openWindow: () => {},
      quit
    })
    actions.quit()
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('托盘文案都在 copy.ts 里，不散落在菜单模型里', () => {
    expect(trayCopy.quit).toBe('退出')
    expect(trayCopy.proxy).toBe('系统代理')
    expect(trayCopy.switchNode).toBe('切换节点')
    expect(trayCopy.openWindow).toBe('打开主窗口')
  })
})

describe('菜单模型 → Electron 模板', () => {
  it('字段一一对应，子菜单递归；点击处理器包成同步回调', async () => {
    const calls: string[] = []
    const actions = noopActions({
      openWindow: () => calls.push('open'),
      quit: () => calls.push('quit')
    })
    const template = toMenuTemplate(buildTrayMenu(snapshot(), actions))
    expect(template.map((entry) => entry.type)).toEqual([
      'normal',
      'separator',
      'checkbox',
      'submenu',
      'normal',
      'normal'
    ])
    const proxy = template.find((entry) => entry.id === TRAY_ID.proxy)
    expect(proxy?.checked).toBe(false)
    expect(proxy?.enabled).toBe(true)

    const switchRoot = template.find((entry) => entry.id === TRAY_ID.switchRoot)
    expect(switchRoot?.submenu?.map((entry) => entry.label)).toEqual(['Auto', 'Proxy'])
    // 状态行仍然是禁用态。
    expect(template.find((entry) => entry.id === TRAY_ID.status)?.enabled).toBe(false)

    template.find((entry) => entry.id === TRAY_ID.openWindow)?.click?.()
    template.find((entry) => entry.id === TRAY_ID.quit)?.click?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls).toEqual(['open', 'quit'])
  })

  it('异步动作抛错交给 onError，不会变成 unhandledRejection', async () => {
    const errors: unknown[] = []
    const template = toMenuTemplate(
      buildTrayMenu(
        snapshot(),
        noopActions({
          setProxyEnabled: async () => {
            throw new Error('动作失败')
          }
        })
      ),
      (err) => errors.push(err)
    )
    const proxy = template.find((entry) => entry.id === TRAY_ID.proxy)
    expect(() => proxy?.click?.()).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(errors).toHaveLength(1)
  })
})

describe('从 AppContext 读快照', () => {
  function ctxFor(over: {
    status?: AppContext['startupStatus']
    mode?: AppContext['mode']
    proxyEnabled?: boolean
    proxyServer?: string | null
    proxies?: unknown
    proxiesThrows?: boolean
  }): AppContext {
    const link =
      over.proxies === undefined && over.proxiesThrows !== true
        ? null
        : new RealCoreLink('http://127.0.0.1:9090', 'top-secret', (async () => {
            if (over.proxiesThrows === true) throw new Error('内核不可达')
            return {
              ok: true,
              status: 200,
              json: async () => over.proxies
            } as Response
          }) as unknown as typeof fetch)
    return {
      startupStatus: over.status ?? 'ready',
      mode: over.mode ?? 'rule',
      proxyEnabled: over.proxyEnabled ?? false,
      proxyServer: over.proxyServer === undefined ? '127.0.0.1:7891' : over.proxyServer,
      link
    } as unknown as AppContext
  }

  it('ready：状态行取当前节点（GLOBAL 不参与），分组经过 toProxyGroups 规范化', async () => {
    const proxies = JSON.parse(
      readFileSync(path.join(process.cwd(), 'test', 'fixtures', 'proxies.json'), 'utf8')
    ) as unknown
    const snap = await readTraySnapshot(ctxFor({ proxies }))
    expect(snap.status).toBe('ready')
    expect(snap.activeNode).toBe('HK-01')
    expect(snap.groups.map((group) => group.name)).toContain('GLOBAL')
    expect(snap.proxyAvailable).toBe(true)
    expect(snap.proxyEnabled).toBe(false)
  })

  it('非 ready：不给节点，交给状态文案', async () => {
    const snap = await readTraySnapshot(ctxFor({ status: 'core-error', proxyServer: null }))
    expect(snap.activeNode).toBeNull()
    expect(snap.groups).toEqual([])
    expect(snap.proxyAvailable).toBe(false)
    expect(trayStatusLine(snap)).toBe('内核未运行 · 规则')
  })

  it('内核不可达：分组为空，不伪造上一轮的节点', async () => {
    const snap = await readTraySnapshot(ctxFor({ proxiesThrows: true }))
    expect(snap.groups).toEqual([])
    expect(snap.activeNode).toBeNull()
    // link 存在但请求失败：状态仍是 ready，状态行用破折号。
    expect(trayStatusLine(snap)).toBe('— · 规则')
  })

  it('没有 link（内核未运行）：不请求，分组为空', async () => {
    const snap = await readTraySnapshot(ctxFor({}))
    expect(snap.groups).toEqual([])
    expect(snap.activeNode).toBeNull()
  })

  it('快照里没有 secret：对象可以被序列化而不泄漏', async () => {
    const proxies = JSON.parse(
      readFileSync(path.join(process.cwd(), 'test', 'fixtures', 'proxies.json'), 'utf8')
    ) as unknown
    const snap = await readTraySnapshot(ctxFor({ proxies }))
    expect(JSON.stringify(snap)).not.toContain('top-secret')
    expect(JSON.stringify(snap)).not.toContain('9090')
  })
})
