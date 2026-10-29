import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { AutostartSetResult, AutostartStateView } from '../../shared/ipc'
import { copy } from '../copy'
import { makeAether } from '../test-utils'
import { SettingsPage } from './SettingsPage'

/** 打包态、系统与持久化一致的基线。 */
function state(over: Partial<AutostartStateView> = {}): AutostartStateView {
  return {
    enabled: true,
    persisted: true,
    appliesToSystem: true,
    systemDiffers: false,
    ...over
  }
}

interface Options {
  initial?: AutostartStateView
  set?: (enabled: boolean) => Promise<AutostartSetResult>
  get?: () => Promise<AutostartStateView>
}

function mount(options: Options = {}) {
  const getAutostart = vi.fn(options.get ?? (async () => options.initial ?? state()))
  const setAutostart = vi.fn(
    options.set ??
      (async (enabled: boolean) => ({ ok: true, state: state({ enabled, persisted: enabled }) }))
  )
  window.aether = makeAether({ getAutostart, setAutostart })
  return { ...render(<SettingsPage />), getAutostart, setAutostart }
}

function toggle(): HTMLElement {
  return screen.getByRole('switch', { name: copy.settings.autostart.label })
}

describe('SettingsPage 开机自启', () => {
  it('默认启用：开关为开启，且不显示关闭警告', async () => {
    mount()

    await waitFor(() => expect(toggle()).toHaveAttribute('aria-checked', 'true'))
    expect(screen.queryByText(copy.settings.autostart.warning)).toBeNull()
  })

  it('首屏回「已关闭」时同屏显示警告文案（不是 tooltip）', async () => {
    mount({ initial: state({ enabled: false, persisted: false }) })

    expect(await screen.findByText(copy.settings.autostart.warning)).toBeInTheDocument()
    expect(toggle()).toHaveAttribute('aria-checked', 'false')
    // 警告不能只是 title：可见文本里必须有原句。
    expect(screen.getByText(copy.settings.autostart.warning).tagName).toBe('P')
  })

  it('关闭开关后出现警告，开关位置来自主进程返回的状态', async () => {
    const { setAutostart } = mount()

    await waitFor(() => expect(toggle()).toHaveAttribute('aria-checked', 'true'))
    await userEvent.click(toggle())

    expect(setAutostart).toHaveBeenCalledWith(false)
    expect(await screen.findByText(copy.settings.autostart.warning)).toBeInTheDocument()
    expect(toggle()).toHaveAttribute('aria-checked', 'false')
  })

  it('再次开启后警告消失', async () => {
    mount({ initial: state({ enabled: false, persisted: false }) })
    await screen.findByText(copy.settings.autostart.warning)

    await userEvent.click(toggle())

    await waitFor(() =>
      expect(screen.queryByText(copy.settings.autostart.warning)).toBeNull()
    )
    expect(toggle()).toHaveAttribute('aria-checked', 'true')
  })

  it('切换失败时开关弹回真实状态，并显示错误', async () => {
    const { setAutostart } = mount({
      set: async () => ({ ok: false, state: state({ enabled: true, persisted: true }) })
    })

    await waitFor(() => expect(toggle()).toHaveAttribute('aria-checked', 'true'))
    await userEvent.click(toggle())

    expect(setAutostart).toHaveBeenCalledWith(false)
    // 主进程回的是真实状态：开关不能停在用户点击后的样子。
    await waitFor(() => expect(toggle()).toHaveAttribute('aria-checked', 'true'))
    expect(screen.getByRole('alert')).toHaveTextContent(copy.settings.autostart.changeFailed)
    expect(screen.queryByText(copy.settings.autostart.warning)).toBeNull()
  })

  it('切换抛错时重新读真实状态，不假装成功', async () => {
    const get = vi
      .fn<() => Promise<AutostartStateView>>()
      .mockResolvedValueOnce(state({ enabled: true }))
      .mockResolvedValueOnce(state({ enabled: true, persisted: true }))
    mount({
      get,
      set: async () => {
        throw new Error('通道断开')
      }
    })

    await waitFor(() => expect(toggle()).toHaveAttribute('aria-checked', 'true'))
    await userEvent.click(toggle())

    await waitFor(() => expect(get).toHaveBeenCalledTimes(2))
    expect(toggle()).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('alert')).toHaveTextContent(copy.settings.autostart.changeFailed)
  })

  it('开发态：开关照常工作，但同屏说明「仅打包版生效」', async () => {
    // 主进程在开发态回 `appliesToSystem: false`：设置照常保存，但不写注册表。
    const { setAutostart } = mount({
      initial: state({ enabled: true, persisted: true, appliesToSystem: false }),
      set: async (enabled) => ({
        ok: true,
        state: state({ enabled, persisted: enabled, appliesToSystem: false })
      })
    })

    expect(await screen.findByText(copy.settings.autostart.devOnly)).toBeInTheDocument()
    await userEvent.click(toggle())

    expect(setAutostart).toHaveBeenCalledWith(false)
    expect(await screen.findByText(copy.settings.autostart.warning)).toBeInTheDocument()
    expect(screen.getByText(copy.settings.autostart.devOnly)).toBeInTheDocument()
  })

  it('系统值与持久化值不一致：以系统为准并说明不一致', async () => {
    mount({
      initial: state({ enabled: false, persisted: true, systemDiffers: true })
    })

    expect(
      await screen.findByText(copy.settings.autostart.systemDiffers(false))
    ).toBeInTheDocument()
    expect(toggle()).toHaveAttribute('aria-checked', 'false')
    // 系统是关的，所以关闭警告也必须在场。
    expect(screen.getByText(copy.settings.autostart.warning)).toBeInTheDocument()
  })

  it('读取失败时显示错误，不画一个假开关', async () => {
    mount({
      get: async () => {
        throw new Error('拒绝访问')
      }
    })

    expect(await screen.findByRole('alert')).toHaveTextContent(
      copy.settings.autostart.loadFailed
    )
    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('主进程带回的读取错误原样显示（显示的是上次保存的设置）', async () => {
    mount({ initial: state({ enabled: true, error: '无法读取系统的开机启动项' }) })

    expect(await screen.findByText('无法读取系统的开机启动项')).toBeInTheDocument()
  })

  it('开关不会因为连续点击发出两次请求', async () => {
    let release: (() => void) | undefined
    const setAutostart = vi.fn(
      async (enabled: boolean) =>
        new Promise<AutostartSetResult>((resolve) => {
          release = () => resolve({ ok: true, state: state({ enabled, persisted: enabled }) })
        })
    )
    mount({ set: setAutostart })

    await waitFor(() => expect(toggle()).toHaveAttribute('aria-checked', 'true'))
    await userEvent.click(toggle())
    await userEvent.click(toggle())

    expect(setAutostart).toHaveBeenCalledTimes(1)
    release?.()
    await waitFor(() => expect(toggle()).toBeEnabled())
  })
})
