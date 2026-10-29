import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  ensureAutostartAtStartup,
  readAutostart,
  setAutostart,
  type AutostartHost
} from './autostart'
import { autostartCopy } from './copy'

interface Harness {
  file: string
  host: AutostartHost
  setLoginItem: ReturnType<typeof vi.fn>
  getLoginItem: ReturnType<typeof vi.fn>
}

/**
 * 假想的 Windows 启动项：`setLoginItem` 改它、`getLoginItem` 读它。
 * 测试可以单独替换任一方法的实现来模拟抛错或「写了但没生效」。
 */
async function harness(
  options: { packaged?: boolean; systemOpenAtLogin?: boolean } = {}
): Promise<Harness> {
  const dir = await mkdtemp(path.join(tmpdir(), 'aether-autostart-'))
  const file = path.join(dir, 'settings.json')
  const registry = { openAtLogin: options.systemOpenAtLogin ?? false }
  const setLoginItem = vi.fn((openAtLogin: boolean) => {
    registry.openAtLogin = openAtLogin
  })
  const getLoginItem = vi.fn(() => registry.openAtLogin)
  const host: AutostartHost = {
    isPackaged: options.packaged ?? true,
    setLoginItem,
    getLoginItem
  }
  return { file, host, setLoginItem, getLoginItem }
}

async function writeSettingsFile(file: string, value: unknown): Promise<void> {
  await writeFile(file, JSON.stringify(value), 'utf8')
}

describe('readAutostart', () => {
  it('设置文件里没有 autostart 键时默认启用', async () => {
    // 首次安装后 `ensureAutostartAtStartup` 已按默认注册过启动项。
    const h = await harness({ systemOpenAtLogin: true })
    await writeSettingsFile(h.file, { proxyEnabled: false })

    expect(await readAutostart(h.host, h.file)).toEqual({
      enabled: true,
      persisted: true,
      appliesToSystem: true,
      systemDiffers: false
    })
  })

  it('打包态读系统实际值，而不是持久化意向', async () => {
    const h = await harness({ systemOpenAtLogin: false })
    await writeSettingsFile(h.file, { proxyEnabled: false, autostart: true })

    const state = await readAutostart(h.host, h.file)
    expect(state.enabled).toBe(false)
    expect(state.persisted).toBe(true)
    // 系统值与持久化值不一致：界面必须按系统值显示并提示。
    expect(state.systemDiffers).toBe(true)
    expect(h.setLoginItem).not.toHaveBeenCalled()
  })

  it('开发态不读注册表，显示持久化意向并标注不作用于系统', async () => {
    const h = await harness({ packaged: false })
    await writeSettingsFile(h.file, { proxyEnabled: false, autostart: false })

    expect(await readAutostart(h.host, h.file)).toEqual({
      enabled: false,
      persisted: false,
      appliesToSystem: false,
      systemDiffers: false
    })
    expect(h.getLoginItem).not.toHaveBeenCalled()
  })

  it('读取系统值抛错时回到持久化意向，并说明显示的不是系统状态', async () => {
    const h = await harness()
    h.getLoginItem.mockImplementation(() => {
      throw new Error('拒绝访问')
    })
    await writeSettingsFile(h.file, { proxyEnabled: false, autostart: true })

    const state = await readAutostart(h.host, h.file)
    expect(state.enabled).toBe(true)
    expect(state.error).toBe(autostartCopy.readFailed)
  })
})

describe('setAutostart', () => {
  it('打包态关闭：写系统启动项、回读确认、落盘 false', async () => {
    const h = await harness({ systemOpenAtLogin: true })

    const result = await setAutostart(h.host, h.file, false)

    expect(result.ok).toBe(true)
    expect(h.setLoginItem).toHaveBeenCalledWith(false)
    expect(result.state).toMatchObject({
      enabled: false,
      persisted: false,
      appliesToSystem: true,
      systemDiffers: false
    })
    const written = JSON.parse(await readFile(h.file, 'utf8')) as Record<string, unknown>
    expect(written.autostart).toBe(false)
  })

  it('关闭后设置文件保留其它字段', async () => {
    const h = await harness({ systemOpenAtLogin: true })
    await writeSettingsFile(h.file, {
      proxyEnabled: true,
      windowBounds: { x: 1, y: 2, width: 1280, height: 800 }
    })

    await setAutostart(h.host, h.file, false)

    const written = JSON.parse(await readFile(h.file, 'utf8')) as Record<string, unknown>
    expect(written).toEqual({
      proxyEnabled: true,
      windowBounds: { x: 1, y: 2, width: 1280, height: 800 },
      autostart: false
    })
  })

  it('setLoginItemSettings 抛错：开关回到真实状态并给出错误，不落盘', async () => {
    const h = await harness({ systemOpenAtLogin: true })
    h.setLoginItem.mockImplementation(() => {
      throw new Error('拒绝访问')
    })

    const result = await setAutostart(h.host, h.file, false)

    expect(result.ok).toBe(false)
    // 系统仍开着：开关不能显示成已关闭。
    expect(result.state.enabled).toBe(true)
    expect(result.state.error).toBe(autostartCopy.systemFailed)
    await expect(readFile(h.file, 'utf8')).rejects.toThrow()
  })

  it('写了但回读不反映改动：也算失败，绝不说谎', async () => {
    const h = await harness({ systemOpenAtLogin: true })
    // 写入不抛错，但系统没接受（组策略 / 杀软）。
    h.setLoginItem.mockImplementation(() => {})

    const result = await setAutostart(h.host, h.file, false)

    expect(result.ok).toBe(false)
    expect(result.state.enabled).toBe(true)
    expect(result.state.error).toBe(autostartCopy.notApplied)
    await expect(readFile(h.file, 'utf8')).rejects.toThrow()
  })

  it('回读抛错：同样算失败', async () => {
    const h = await harness({ systemOpenAtLogin: true })
    h.getLoginItem.mockImplementation(() => {
      throw new Error('拒绝访问')
    })

    const result = await setAutostart(h.host, h.file, false)

    expect(result.ok).toBe(false)
    expect(result.state.error).toBe(autostartCopy.verifyFailed)
  })

  it('开发态：绝不调用 setLoginItemSettings，但意向照常落盘', async () => {
    const h = await harness({ packaged: false })

    const result = await setAutostart(h.host, h.file, false)

    expect(result.ok).toBe(true)
    expect(h.setLoginItem).not.toHaveBeenCalled()
    expect(h.getLoginItem).not.toHaveBeenCalled()
    expect(result.state).toMatchObject({
      enabled: false,
      persisted: false,
      appliesToSystem: false,
      systemDiffers: false
    })
    expect(JSON.parse(await readFile(h.file, 'utf8'))).toMatchObject({ autostart: false })
  })

  it('开发态关闭后再开启，意向往返', async () => {
    const h = await harness({ packaged: false })
    await setAutostart(h.host, h.file, false)
    const result = await setAutostart(h.host, h.file, true)
    expect(result.state.enabled).toBe(true)
    expect(h.setLoginItem).not.toHaveBeenCalled()
  })
})

describe('ensureAutostartAtStartup', () => {
  it('首次启动（设置文件不存在）按默认启用注册并记下', async () => {
    const h = await harness()

    expect(await ensureAutostartAtStartup(h.host, h.file)).toBe('registered')
    expect(h.setLoginItem).toHaveBeenCalledWith(true)
    expect(JSON.parse(await readFile(h.file, 'utf8'))).toMatchObject({ autostart: true })
  })

  it('开发态跳过，不碰注册表', async () => {
    const h = await harness({ packaged: false })
    expect(await ensureAutostartAtStartup(h.host, h.file)).toBe('skipped')
    expect(h.setLoginItem).not.toHaveBeenCalled()
  })

  it('用户显式关过：启动时不再偷偷注册', async () => {
    const h = await harness()
    await writeSettingsFile(h.file, { proxyEnabled: false, autostart: false })

    expect(await ensureAutostartAtStartup(h.host, h.file)).toBe('skipped')
    expect(h.setLoginItem).not.toHaveBeenCalled()
  })

  it('用户显式开过：只认系统实际值，启动时不重写注册表', async () => {
    const h = await harness({ systemOpenAtLogin: false })
    await writeSettingsFile(h.file, { proxyEnabled: false, autostart: true })

    expect(await ensureAutostartAtStartup(h.host, h.file)).toBe('skipped')
    expect(h.setLoginItem).not.toHaveBeenCalled()
  })

  it('注册没被系统接受时报告失败', async () => {
    const h = await harness()
    h.setLoginItem.mockImplementation(() => {})

    expect(await ensureAutostartAtStartup(h.host, h.file)).toBe('failed')
  })

  it('注册抛错时不落盘，下次启动还能再试', async () => {
    const h = await harness()
    h.setLoginItem.mockImplementation(() => {
      throw new Error('拒绝访问')
    })

    expect(await ensureAutostartAtStartup(h.host, h.file)).toBe('failed')
    await expect(readFile(h.file, 'utf8')).rejects.toThrow()
  })
})
