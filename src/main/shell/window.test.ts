import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_WINDOW_SIZE,
  MIN_VISIBLE_EDGE,
  MIN_WINDOW_SIZE,
  TITLE_BAR_HEIGHT,
  createWindowManager,
  defaultWindowRect,
  destroyOnClose,
  resolveWindowBounds,
  type ManagedWindow,
  type WindowRect
} from './window'

/** 主屏 1536×824（任务栏占 40px），副屏放在左侧，坐标系为负。 */
const PRIMARY = { x: 0, y: 0, width: 1536, height: 824 }
const LEFT = { x: -1920, y: 0, width: 1920, height: 1080 }

class FakeWindow implements ManagedWindow {
  destroyed = false
  minimized = false
  visible = true
  maximized = false
  focused = 0
  shown = 0
  restoreCount = 0
  closeCount = 0
  bounds: WindowRect
  /**
   * 无边框窗口的隐藏调整边框：Electron 回报的 bounds 比申请的宽/高多出一些像素。
   * 真实值在 1.25 倍 DPI 下实测为 +1~6px，这里用固定 2×1 模拟。
   */
  inset = { x: 0, y: 0, width: 2, height: 1 }

  constructor(bounds: WindowRect) {
    this.bounds = bounds
  }

  isDestroyed(): boolean {
    return this.destroyed
  }
  isMinimized(): boolean {
    return this.minimized
  }
  isVisible(): boolean {
    return this.visible
  }
  restore(): void {
    this.restoreCount += 1
    this.minimized = false
  }
  show(): void {
    this.shown += 1
    this.visible = true
  }
  focus(): void {
    this.focused += 1
  }
  destroy(): void {
    this.destroyed = true
    this.visible = false
  }
  close(): void {
    this.closeCount += 1
  }
  minimize(): void {
    this.minimized = true
  }
  isMaximized(): boolean {
    return this.maximized
  }
  maximize(): void {
    this.maximized = true
  }
  unmaximize(): void {
    this.maximized = false
  }
  getBounds(): WindowRect {
    return {
      x: this.bounds.x + this.inset.x,
      y: this.bounds.y + this.inset.y,
      width: this.bounds.width + this.inset.width,
      height: this.bounds.height + this.inset.height
    }
  }
  getNormalBounds(): WindowRect {
    return this.getBounds()
  }
}

interface Options {
  saved?: unknown
  displays?: { workArea: WindowRect }[]
}

function harness(options: Options = {}) {
  const created: FakeWindow[] = []
  const saved: WindowRect[] = []
  const manager = createWindowManager<FakeWindow>({
    create: (bounds) => {
      const win = new FakeWindow(bounds)
      created.push(win)
      return win
    },
    loadBounds: async () => options.saved ?? null,
    saveBounds: async (bounds) => {
      saved.push(bounds)
    },
    displays: () => options.displays ?? [{ workArea: PRIMARY }]
  })
  return { manager, created, saved }
}

describe('destroyOnClose', () => {
  it('普通关窗是销毁，不是退出应用', () => {
    expect(destroyOnClose(false)).toBe(true)
  })

  it('真正的退出路径放行关闭，否则 Electron 无法退出', () => {
    expect(destroyOnClose(true)).toBe(false)
  })
})

describe('resolveWindowBounds', () => {
  it('合法记录原样返回', () => {
    const rect: WindowRect = { x: 120, y: 80, width: 1280, height: 800 }
    expect(resolveWindowBounds(rect, [{ workArea: PRIMARY }])).toEqual(rect)
  })

  it('记录来自已拔掉的显示器时返回 null（调用方回落到居中默认）', () => {
    const rect: WindowRect = { x: -1800, y: 200, width: 1280, height: 800 }
    expect(resolveWindowBounds(rect, [{ workArea: PRIMARY }])).toBeNull()
  })

  it('多显示器时只要落在任意一块屏幕上就恢复', () => {
    const rect: WindowRect = { x: -1800, y: 200, width: 1280, height: 800 }
    expect(resolveWindowBounds(rect, [{ workArea: PRIMARY }, { workArea: LEFT }])).toEqual(rect)
  })

  it('标题栏被推到屏幕外时也算够不着', () => {
    // 窗口主体还在屏幕里，但 40px 标题栏整个在屏幕上方：用户无法拖动它。
    const rect: WindowRect = { x: 200, y: -TITLE_BAR_HEIGHT - 10, width: 1280, height: 800 }
    expect(resolveWindowBounds(rect, [{ workArea: PRIMARY }])).toBeNull()
  })

  it('标题栏只剩很小一条时同样拒绝', () => {
    const rect: WindowRect = {
      x: 200,
      y: PRIMARY.height - TITLE_BAR_HEIGHT + 4,
      width: 1280,
      height: 800
    }
    expect(resolveWindowBounds(rect, [{ workArea: PRIMARY }])).toBeNull()
  })

  it('水平方向只剩一条缝时拒绝', () => {
    const rect: WindowRect = {
      x: PRIMARY.width - (MIN_VISIBLE_EDGE - 1),
      y: 100,
      width: 1280,
      height: 800
    }
    expect(resolveWindowBounds(rect, [{ workArea: PRIMARY }])).toBeNull()
  })

  it('小于最小尺寸的记录被抬到最小尺寸', () => {
    const rect: WindowRect = { x: 100, y: 100, width: 640, height: 400 }
    expect(resolveWindowBounds(rect, [{ workArea: PRIMARY }])).toEqual({
      x: 100,
      y: 100,
      width: MIN_WINDOW_SIZE.width,
      height: MIN_WINDOW_SIZE.height
    })
  })

  it('超过工作区的尺寸被压回工作区', () => {
    const rect: WindowRect = { x: 0, y: 0, width: 4000, height: 3000 }
    expect(resolveWindowBounds(rect, [{ workArea: PRIMARY }])).toEqual({
      x: 0,
      y: 0,
      width: PRIMARY.width,
      height: PRIMARY.height
    })
  })

  it.each([
    ['null', null],
    ['字符串', '1280x800'],
    ['缺字段', { x: 0, y: 0, width: 1280 }],
    ['非数字', { x: 0, y: 0, width: '1280', height: 800 }],
    ['NaN', { x: 0, y: 0, width: Number.NaN, height: 800 }],
    ['零宽', { x: 0, y: 0, width: 0, height: 800 }]
  ])('畸形记录（%s）返回 null', (_label, value) => {
    expect(resolveWindowBounds(value, [{ workArea: PRIMARY }])).toBeNull()
  })

  it('拿不到任何显示器时不猜位置', () => {
    expect(resolveWindowBounds({ x: 0, y: 0, width: 1280, height: 800 }, [])).toBeNull()
  })
})

describe('defaultWindowRect', () => {
  it('在主屏工作区内居中，尺寸取 1280×800', () => {
    expect(defaultWindowRect([{ workArea: PRIMARY }])).toEqual({
      x: Math.round((PRIMARY.width - DEFAULT_WINDOW_SIZE.width) / 2),
      y: Math.round((PRIMARY.height - DEFAULT_WINDOW_SIZE.height) / 2),
      width: DEFAULT_WINDOW_SIZE.width,
      height: DEFAULT_WINDOW_SIZE.height
    })
  })

  it('工作区比默认尺寸小时按工作区收缩，仍然居中', () => {
    const small = { x: 0, y: 0, width: 1200, height: 700 }
    expect(defaultWindowRect([{ workArea: small }])).toEqual({
      x: 0,
      y: 0,
      width: 1200,
      height: 700
    })
  })

  it('没有显示器信息时给一个可用的原点矩形', () => {
    expect(defaultWindowRect([])).toEqual({
      x: 0,
      y: 0,
      width: DEFAULT_WINDOW_SIZE.width,
      height: DEFAULT_WINDOW_SIZE.height
    })
  })
})

describe('createWindowManager', () => {
  it('首次 show 创建窗口，使用居中默认尺寸', async () => {
    const { manager, created } = harness()
    await manager.show()

    expect(created).toHaveLength(1)
    expect(created[0]?.bounds).toEqual(defaultWindowRect([{ workArea: PRIMARY }]))
    expect(manager.current()).toBe(created[0])
  })

  it('窗口还在时 show 只聚焦，不重建', async () => {
    const { manager, created } = harness()
    await manager.show()
    const win = created[0]!
    win.minimized = true
    win.visible = false
    // 创建时的那一次聚焦不算：只比较第二次 show 产生的动作。
    const focusedAfterCreate = win.focused

    await manager.show()

    expect(created).toHaveLength(1)
    expect(win.restoreCount).toBe(1)
    expect(win.shown).toBe(1)
    expect(win.focused).toBe(focusedAfterCreate + 1)
  })

  it('窗口销毁后 show 重建，并恢复持久化的位置与尺寸', async () => {
    const saved: WindowRect = { x: 200, y: 120, width: 1200, height: 760 }
    const { manager, created } = harness({ saved })

    await manager.show()
    created[0]!.destroy()
    manager.forget(created[0]!)

    await manager.show()

    expect(created).toHaveLength(2)
    expect(created[1]?.bounds).toEqual(saved)
  })

  it('并发两次 show（双击托盘）只创建一个窗口', async () => {
    const { manager, created } = harness()

    await Promise.all([manager.show(), manager.show()])

    expect(created).toHaveLength(1)
  })

  it('创建途中再次 show 也只有一个窗口', async () => {
    const { manager, created } = harness()
    const first = manager.show()
    const second = manager.show()
    await Promise.all([first, second])
    await manager.show()

    expect(created).toHaveLength(1)
  })

  it('越界记录回落到居中默认，而不是把窗口恢复到看不见的地方', async () => {
    const { manager, created } = harness({
      saved: { x: 9000, y: 9000, width: 1280, height: 800 }
    })

    await manager.show()

    expect(created[0]?.bounds).toEqual(defaultWindowRect([{ workArea: PRIMARY }]))
  })

  it('读取持久化失败时仍然开窗', async () => {
    const created: FakeWindow[] = []
    const manager = createWindowManager<FakeWindow>({
      create: (bounds) => {
        const win = new FakeWindow(bounds)
        created.push(win)
        return win
      },
      loadBounds: async () => {
        throw new Error('settings.json 损坏')
      },
      saveBounds: async () => {},
      displays: () => [{ workArea: PRIMARY }]
    })

    await manager.show()

    expect(created).toHaveLength(1)
  })

  it('close 只关闭窗口，不触碰任何退出路径', async () => {
    const { manager, created } = harness()
    await manager.show()
    const win = created[0]!

    manager.close()

    // 管理器把关闭委派给窗口对象（生产环境由 index.ts 的 close 处理器改成 destroy），
    // 它本身没有任何「退出应用」的依赖。
    expect(win.closeCount).toBe(1)
    expect(manager.current()).toBe(win)
  })

  it('forget 只清掉被销毁的那一个窗口', async () => {
    const { manager, created } = harness()
    await manager.show()
    const win = created[0]!
    const other = new FakeWindow(win.bounds)

    manager.forget(other)
    expect(manager.current()).toBe(win)

    manager.forget(win)
    expect(manager.current()).toBeNull()
  })

  it('persistCurrent 把窗口几何写回，并吞掉落盘错误', async () => {
    const saved: WindowRect[] = []
    const errors: unknown[] = []
    const manager = createWindowManager<FakeWindow>({
      create: (bounds) => new FakeWindow(bounds),
      loadBounds: async () => null,
      saveBounds: async (bounds) => {
        saved.push(bounds)
        throw new Error('磁盘满了')
      },
      displays: () => [{ workArea: PRIMARY }],
      onError: (err) => errors.push(err)
    })
    await manager.show()

    await expect(manager.persistCurrent()).resolves.toBeUndefined()
    // 用户没动过窗口：写回的是申请值（居中默认），不是 Electron 汇报的膨胀值。
    expect(saved).toEqual([defaultWindowRect([{ workArea: PRIMARY }])])
    expect(errors).toHaveLength(1)
  })

  it('用户移动过窗口后，persistCurrent 写的是新位置', async () => {
    const saved: WindowRect[] = []
    const created: FakeWindow[] = []
    const manager = createWindowManager<FakeWindow>({
      create: (bounds) => {
        const win = new FakeWindow(bounds)
        created.push(win)
        return win
      },
      loadBounds: async () => null,
      saveBounds: async (bounds) => {
        saved.push(bounds)
      },
      displays: () => [{ workArea: PRIMARY }]
    })
    await manager.show()
    const win = created[0]!
    win.bounds = { x: 42, y: 64, width: 1200, height: 720 }

    await manager.persistCurrent()

    // 回报值 = 用户拖到的位置 + 隐藏边框；存盘必须把那层边框减回去。
    expect(saved).toEqual([{ x: 42, y: 64, width: 1200, height: 720 }])
  })

  it('保存的值重新喂回 create 时矩形不再变大（无边框窗口不逐次膨胀）', async () => {
    const saved: WindowRect[] = []
    const created: FakeWindow[] = []
    let stored: unknown = null
    const make = () =>
      createWindowManager<FakeWindow>({
        create: (bounds) => {
          const win = new FakeWindow(bounds)
          created.push(win)
          return win
        },
        loadBounds: async () => stored,
        saveBounds: async (bounds) => {
          saved.push(bounds)
          stored = bounds
        },
        displays: () => [{ workArea: PRIMARY }]
      })

    const first = make()
    await first.show()
    await first.persistCurrent()
    created[0]!.destroy()
    first.forget(created[0]!)

    // 重建三次，每次「关窗存盘 → 再打开」：尺寸必须始终等于最初申请的 1280×800。
    for (let i = 0; i < 3; i += 1) {
      const next = make()
      await next.show()
      expect(created.at(-1)!.bounds).toEqual({
        x: Math.round((PRIMARY.width - 1280) / 2),
        y: Math.round((PRIMARY.height - 800) / 2),
        width: 1280,
        height: 800
      })
      await next.persistCurrent()
      next.forget(created.at(-1)!)
    }
    expect(saved.every((rect) => rect.width === 1280 && rect.height === 800)).toBe(true)
  })

  it('窗口已销毁时控制动作全部是空操作', async () => {
    const { manager, created } = harness()
    await manager.show()
    created[0]!.destroy()

    expect(() => {
      manager.minimize()
      manager.toggleMaximize()
      manager.close()
    }).not.toThrow()
    expect(manager.isMaximized()).toBe(false)
  })

  it('toggleMaximize 在最大化与还原之间切换', async () => {
    const { manager, created } = harness()
    await manager.show()
    const win = created[0]!

    manager.toggleMaximize()
    expect(win.isMaximized()).toBe(true)
    expect(manager.isMaximized()).toBe(true)

    manager.toggleMaximize()
    expect(win.isMaximized()).toBe(false)
    expect(manager.isMaximized()).toBe(false)
  })

  it('minimize 最小化当前窗口', async () => {
    const { manager, created } = harness()
    await manager.show()

    manager.minimize()

    expect(created[0]?.isMinimized()).toBe(true)
  })
})

describe('index.ts 的窗口接线', () => {
  const source = readFileSync(path.join(process.cwd(), 'src', 'main', 'index.ts'), 'utf8')

  it('窗口是全无边框的：frame: false，标题栏由渲染层绘制', () => {
    expect(source).toMatch(/frame:\s*false/)
  })

  it('window-all-closed 不再退出应用（常驻代理）', () => {
    const handler = /app\.on\(\s*'window-all-closed'[\s\S]*?\n\}\)/.exec(source)
    expect(handler).not.toBeNull()
    // 注释里会解释「为什么不能调 app.quit」，所以要先把注释去掉再断言代码。
    const code = handler![0].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    expect(code).not.toContain('app.quit')
  })

  it('最小尺寸仍然生效，且取自 MIN_WINDOW_SIZE', () => {
    expect(source).toMatch(/minWidth:\s*MIN_WINDOW_SIZE\.width/)
    expect(source).toMatch(/minHeight:\s*MIN_WINDOW_SIZE\.height/)
  })

  it('close 事件先 preventDefault 再 destroy，并用 quitting 放行真正的退出', () => {
    expect(source).toMatch(/on\(\s*'close'[\s\S]*?destroyOnClose\(\s*quitting\s*\)/)
    expect(source).toMatch(/event\.preventDefault\(\)[\s\S]*?win\.destroy\(\)/)
  })

  it('窗口重建走 windowManager.show()，而不是残留的 createWindow 直接调用', () => {
    expect(source).toMatch(/windowManager\.show\(\)/)
    expect(source).not.toMatch(/\bcreateWindow\(/)
  })
})
