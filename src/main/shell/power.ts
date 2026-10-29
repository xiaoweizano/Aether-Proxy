/**
 * 关机与会话结束的清理模型。
 *
 * 与 `tray.ts` / `autostart.ts` 同一形状：**纯模型 + 薄适配器**。真正碰 Electron
 * 的只有注入进来的 `ShutdownActions` 与事件订阅，由 `src/main/index.ts` 接线；
 * Vitest 里没有 Electron，注入假体即可覆盖全部判定。
 *
 * 为什么不能直接等 `stopAll()`：关机时最怕的不是内核多跑几秒，而是**系统代理还
 * 指着一个没人监听的端口**——下次开机整台机器没有网络。所以这里的顺序是硬要求：
 *
 * 1. 取消待触发的自动重启（同步，必须在任何 await 之前）——否则一个恰好在关机
 *    途中到点的退避定时器会把内核重新拉起来，与还原代理抢时序；
 * 2. **await 系统代理还原**——koffi 写注册表是毫秒级的，这是唯一必须落地的一步；
 * 3. 请求终止内核但**不 await**——`CoreSupervisor.stop()` 会等最多 3 秒 SIGTERM
 *    宽限期，关机等不起。OS 会回收子进程；即便内核残留，没有系统代理指向它也无害。
 *
 * 反过来若把三步串在一个 `await stopAll()` 后面、再套一个竞速超时，内核慢下来时
 * 超时会先到，代理还原就被放弃了——正是本任务要消灭的那种失败。
 *
 * 这两个事件里**不得**弹对话框：关机期间没有用户可交互。本模块因此不引用任何
 * 对话框/通知 API。
 */

/** 关机路径的动作表。由 `AppContext.shutdown` 提供，测试注入假体。 */
export interface ShutdownActions {
  /**
   * 取消尚未触发的内核自动重启。同步，且必须在 `restoreProxy` 之前调用。
   * 抛错不能挡住后面的步骤（关机只能尽力而为）。
   */
  cancelRestarts(): void
  /**
   * 还原系统代理。关机路径上唯一必须 await 的动作；抛错/超时都只记日志。
   */
  restoreProxy(): Promise<void>
  /**
   * 请求终止内核。刻意**不返回 Promise**：宽限期不能拖住关机。
   * 注入一个永不落定的 Promise（`() => new Promise(() => {})`）也是合法的 void，
   * 处理器绝不会等它。
   */
  stopKernel(): void
}

export interface ShutdownHandlerOptions {
  /**
   * 代理还原的上限。超时后记一条「关机还原超时」并继续走内核请求：
   * 关机路径不能挂住，宁可留下一条可诊断的日志。
   */
  timeoutMs?: number
  /** 日志出口；缺省写 stderr。测试注入收集器断言文案。 */
  log?: (message: string, error?: unknown) => void
}

/** 2.5 秒：Electron 在 session-end 之后不会等太久（账本 Ruling 已定）。 */
export const SHUTDOWN_TIMEOUT_MS = 2500

export const shutdownLog = {
  /** 系统代理没在时限内还原：下次开机可能没有网络，日志要能一眼定位。 */
  restoreTimeout: '[aether] 关机还原超时：系统代理可能未还原',
  restoreFailed: '[aether] 关机还原系统代理失败',
  stopFailed: '[aether] 关机请求终止内核失败',
  cancelFailed: '[aether] 关机取消自动重启失败'
} as const

function defaultLog(message: string, error?: unknown): void {
  if (error === undefined) console.error(message)
  else console.error(message, error)
}

/**
 * 只给代理还原加上限。`cancelRestarts` / `stopKernel` 都是同步调用，本身不可能挂住，
 * 所以整条处理器的上界就等于这一个上限。
 */
function withTimeout(task: Promise<void>, timeoutMs: number, onTimeout: () => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout()
      reject(new Error('shutdown restore timeout'))
    }, timeoutMs)
    task.then(
      () => {
        clearTimeout(timer)
        resolve()
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

/**
 * 生成幂等的关机处理器。
 *
 * 返回值可以调用多次（Windows 会先后送 `query-session-end` 与 `session-end`，
 * 生产环境还会同时挂 `powerMonitor` 的 shutdown）：只有第一次真正执行，
 * 后面的调用拿到同一个 Promise。处理器**永不拒绝**——事件回调里没人接 rejection，
 * 关机路径的失败只能是日志。
 */
export function createShutdownHandler(
  actions: ShutdownActions,
  options: ShutdownHandlerOptions = {}
): () => Promise<void> {
  const timeoutMs = options.timeoutMs ?? SHUTDOWN_TIMEOUT_MS
  const log = options.log ?? defaultLog
  let running: Promise<void> | null = null

  const run = async (): Promise<void> => {
    // 第一步：取消自动重启。同步、且在任何 await 之前。
    try {
      actions.cancelRestarts()
    } catch (err) {
      log(shutdownLog.cancelFailed, err)
    }

    // 第二步：还原系统代理，这是唯一必须等到的动作。
    let restore: Promise<void>
    try {
      // 直接调用（而不是包一层 then）有两个理由：顺序对调用方是同步可见的，
      // 且同步抛错也落进这里的 catch，而不是变成一次未处理的拒绝。
      restore = Promise.resolve(actions.restoreProxy())
    } catch (err) {
      log(shutdownLog.restoreFailed, err)
      restore = Promise.resolve()
    }
    try {
      await withTimeout(restore, timeoutMs, () => { log(shutdownLog.restoreTimeout) })
    } catch (err) {
      // 超时已经在上面记过；这里只补失败原因，超时那条不重复刷屏。
      if (!(err instanceof Error) || err.message !== 'shutdown restore timeout') {
        log(shutdownLog.restoreFailed, err)
      }
    }

    // 第三步：请求终止内核，不等它。内核慢不该让代理还原白等。
    try {
      actions.stopKernel()
    } catch (err) {
      log(shutdownLog.stopFailed, err)
    }
  }

  return () => {
    running ??= run()
    return running
  }
}
