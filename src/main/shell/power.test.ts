import { describe, expect, it, vi } from 'vitest'
import {
  SHUTDOWN_TIMEOUT_MS,
  createShutdownHandler,
  shutdownLog,
  type ShutdownActions
} from './power'

/**
 * 记录动作调用顺序的假动作表。默认全部立即成功；单测按需替换某一项，
 * 以模拟「内核停不下来」「还原抛错」等关机期间的真实劣化。
 */
interface Harness {
  actions: ShutdownActions
  order: string[]
  cancelRestarts: ReturnType<typeof vi.fn>
  restoreProxy: ReturnType<typeof vi.fn>
  stopKernel: ReturnType<typeof vi.fn>
  logs: string[]
}

function harness(over: Partial<ShutdownActions> = {}): Harness {
  const order: string[] = []
  const logs: string[] = []
  const cancelRestarts = vi.fn(() => { order.push('cancel') })
  const restoreProxy = vi.fn(async () => { order.push('restore') })
  const stopKernel = vi.fn(() => { order.push('stop-kernel') })
  const actions: ShutdownActions = {
    cancelRestarts,
    restoreProxy,
    stopKernel,
    ...over
  }
  return { actions, order, cancelRestarts, restoreProxy, stopKernel, logs }
}

function handlerFor(h: Harness, timeoutMs = 50) {
  return createShutdownHandler(h.actions, {
    timeoutMs,
    log: (message, error) => {
      h.logs.push(error === undefined ? message : `${message} ${String(error)}`)
    }
  })
}

describe('createShutdownHandler', () => {
  it('按顺序执行：取消重启 → 还原代理 → 请求终止内核', async () => {
    const h = harness()
    await handlerFor(h)()

    // 顺序是硬要求：取消重启必须最先（否则定时器会在还原途中拉起内核），
    // 内核终止必须最后（它不可靠，不能挡在代理还原前面）。
    expect(h.order).toEqual(['cancel', 'restore', 'stop-kernel'])
    expect(h.cancelRestarts).toHaveBeenCalledTimes(1)
    expect(h.restoreProxy).toHaveBeenCalledTimes(1)
    expect(h.stopKernel).toHaveBeenCalledTimes(1)
    expect(h.logs).toEqual([])
  })

  it('内核停不下来时仍然等到了代理还原，且处理器正常结束', async () => {
    // 注入一个永不落定的 stop：如果处理器误把它当作可等待的动作，这里会挂死。
    const h = harness({
      stopKernel: () => {
        h.order.push('stop-kernel')
        return new Promise<void>(() => {}) as unknown as void
      }
    })
    // 连带让还原也慢一点：证明「慢还原」是被等的，而不是靠竞速侥幸通过。
    let finishRestore!: () => void
    h.actions.restoreProxy = () =>
      new Promise<void>((resolve) => {
        finishRestore = () => { h.order.push('restore'); resolve() }
      })

    const run = handlerFor(h)()
    // 此时还原还没完成：内核停止必须尚未被请求（严格顺序，不是并发）。
    expect(h.order).toEqual(['cancel'])

    finishRestore()
    await expect(run).resolves.toBeUndefined()
    expect(h.order).toEqual(['cancel', 'restore', 'stop-kernel'])
  })

  it('两个事件都触发时只执行一次（第二个是 no-op）', async () => {
    const h = harness()
    const handler = handlerFor(h)

    // Windows 会先送 query-session-end 再送 session-end；生产环境还挂着
    // powerMonitor 的 shutdown。任意多次调用都只能有一次副作用。
    const first = handler()
    const second = handler()
    await Promise.all([first, second])
    // 事件回调可能在第一次还没结束时再次触发：等它落定后再来一次。
    await handler()

    expect(h.cancelRestarts).toHaveBeenCalledTimes(1)
    expect(h.restoreProxy).toHaveBeenCalledTimes(1)
    expect(h.stopKernel).toHaveBeenCalledTimes(1)
    expect(first).toBe(second)
  })

  it('代理还原抛错不会阻止内核终止请求，也不会让处理器拒绝', async () => {
    const boom = new Error('注册表写入被拒绝')
    const h = harness({ restoreProxy: async () => { throw boom } })

    await expect(handlerFor(h)()).resolves.toBeUndefined()

    expect(h.order).toEqual(['cancel', 'stop-kernel'])
    expect(h.logs.some((line) => line.startsWith(shutdownLog.restoreFailed))).toBe(true)
  })

  it('同步抛错的代理还原同样被归一成日志，后续步骤照常执行', async () => {
    const h = harness({
      restoreProxy: (() => { throw new Error('同步失败') }) as unknown as ShutdownActions['restoreProxy']
    })

    await expect(handlerFor(h)()).resolves.toBeUndefined()

    expect(h.order).toEqual(['cancel', 'stop-kernel'])
    expect(h.logs.some((line) => line.startsWith(shutdownLog.restoreFailed))).toBe(true)
  })

  it('代理还原超时：记一条「关机还原超时」，仍然请求终止内核并返回', async () => {
    const h = harness({ restoreProxy: () => new Promise<void>(() => {}) })

    const started = Date.now()
    await expect(handlerFor(h, 30)()).resolves.toBeUndefined()

    // 超时上限真的生效了：不会把关机挂在一个永不落定的还原上。
    expect(Date.now() - started).toBeLessThan(SHUTDOWN_TIMEOUT_MS)
    expect(h.logs).toContain(shutdownLog.restoreTimeout)
    // 内核仍然要被请求终止：代理还原失败不是放弃内核的理由。
    expect(h.order).toEqual(['cancel', 'stop-kernel'])
  })

  it('超时之后迟到的还原完成不会让处理器二次执行或重复记日志', async () => {
    let finishRestore!: () => void
    const h = harness({
      restoreProxy: () =>
        new Promise<void>((resolve) => {
          finishRestore = resolve
        })
    })

    await handlerFor(h, 20)()
    expect(h.logs).toEqual([shutdownLog.restoreTimeout])

    finishRestore()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(h.stopKernel).toHaveBeenCalledTimes(1)
    expect(h.logs).toEqual([shutdownLog.restoreTimeout])
  })

  it('取消重启抛错时仍然继续还原代理', async () => {
    const h = harness({ cancelRestarts: () => { throw new Error('取消失败') } })

    await expect(handlerFor(h)()).resolves.toBeUndefined()

    expect(h.order).toEqual(['restore', 'stop-kernel'])
    expect(h.logs.some((line) => line.startsWith(shutdownLog.cancelFailed))).toBe(true)
  })

  it('内核终止请求同步抛错时处理器不拒绝', async () => {
    const h = harness({ stopKernel: () => { throw new Error('spawn 已失效') } })

    await expect(handlerFor(h)()).resolves.toBeUndefined()

    expect(h.order).toEqual(['cancel', 'restore'])
    expect(h.logs.some((line) => line.startsWith(shutdownLog.stopFailed))).toBe(true)
  })
})

describe('关机路径不碰对话框', () => {
  it('power.ts 不引用任何对话框 / 通知 API', async () => {
    const { readFile } = await import('node:fs/promises')
    const path = await import('node:path')
    const source = await readFile(
      path.join(process.cwd(), 'src', 'main', 'shell', 'power.ts'),
      'utf8'
    )
    // 关机期间没有用户可交互：showMessageBox / showErrorBox / Notification 一律禁止。
    expect(source).not.toMatch(/\bdialog\b/)
    expect(source).not.toMatch(/showMessageBox|showErrorBox|Notification/)
    expect(source).not.toMatch(/from\s+['"]electron['"]/)
  })
})
