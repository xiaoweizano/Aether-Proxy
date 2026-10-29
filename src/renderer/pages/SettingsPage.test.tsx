import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type {
  AutostartSetResult,
  AutostartStateView,
  SimpleResult,
  UrlImportResult
} from '../../shared/ipc'
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
  importUrl?: (url: string) => Promise<UrlImportResult>
  restartCore?: () => Promise<SimpleResult>
}

function mount(options: Options = {}) {
  const getAutostart = vi.fn(options.get ?? (async () => options.initial ?? state()))
  const setAutostart = vi.fn(
    options.set ??
      (async (enabled: boolean) => ({ ok: true, state: state({ enabled, persisted: enabled }) }))
  )
  const importConfigFromUrl = vi.fn(
    options.importUrl ?? (async () => ({ ok: true, applied: 'reloaded' }) as const)
  )
  const restartCore = vi.fn(options.restartCore ?? (async () => ({ ok: true }) as const))
  window.aether = makeAether({ getAutostart, setAutostart, importConfigFromUrl, restartCore })
  return { ...render(<SettingsPage />), getAutostart, setAutostart, importConfigFromUrl, restartCore }
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

describe('SettingsPage 订阅导入', () => {
  function urlInput(): HTMLElement {
    return screen.getByPlaceholderText(copy.settings.subscription.placeholder)
  }

  function submit(): HTMLElement {
    return screen.getByRole('button', { name: copy.settings.subscription.action })
  }

  it('地址为空：本地拦下，不惊动主进程，并给出原因', async () => {
    const { importConfigFromUrl } = mount()

    await userEvent.click(submit())

    expect(importConfigFromUrl).not.toHaveBeenCalled()
    expect(await screen.findByText(copy.settings.subscription.empty)).toBeInTheDocument()
  })

  it('只有空白字符也算空', async () => {
    const { importConfigFromUrl } = mount()

    await userEvent.type(urlInput(), '   ')
    await userEvent.click(submit())

    expect(importConfigFromUrl).not.toHaveBeenCalled()
    expect(await screen.findByText(copy.settings.subscription.empty)).toBeInTheDocument()
  })

  it('导入成功且已热重载：地址去掉首尾空白后交给主进程，并明说已生效', async () => {
    const { importConfigFromUrl } = mount()

    await userEvent.type(urlInput(), '  https://example.com/sub?a=1  ')
    await userEvent.click(submit())

    await waitFor(() =>
      expect(importConfigFromUrl).toHaveBeenCalledWith('https://example.com/sub?a=1')
    )
    expect(await screen.findByText(copy.settings.subscription.reloaded)).toBeInTheDocument()
    // 成功文案不能出现「重启」：内核已经接受了新配置，再让用户重启就是说谎。
    expect(screen.queryByText(copy.settings.subscription.restart)).toBeNull()
    // 成功后清空输入框，避免用户以为再点一次会「再应用一次」。
    expect(urlInput()).toHaveValue('')
  })

  it('内核没在跑：说「重启后生效」，并就地给出重启按钮', async () => {
    const restartCore = vi.fn(async () => ({ ok: true }) as const)
    mount({
      importUrl: async () => ({ ok: true, applied: 'pending-restart' }),
      restartCore
    })

    await userEvent.type(urlInput(), 'https://example.com/sub')
    await userEvent.click(submit())

    expect(await screen.findByText(copy.settings.subscription.imported)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: copy.settings.subscription.restart }))
    expect(restartCore).toHaveBeenCalledTimes(1)
    // 重启成功后才是真的生效。
    expect(await screen.findByText(copy.settings.subscription.reloaded)).toBeInTheDocument()
  })

  it('重启失败：原样显示主进程给的原因，不改口说已生效', async () => {
    mount({
      importUrl: async () => ({ ok: true, applied: 'pending-restart' }),
      restartCore: async () => ({ ok: false, message: '配置有误，无法启动内核' })
    })

    await userEvent.type(urlInput(), 'https://example.com/sub')
    await userEvent.click(submit())
    await userEvent.click(screen.getByRole('button', { name: copy.settings.subscription.restart }))

    expect(await screen.findByText('配置有误，无法启动内核')).toBeInTheDocument()
    expect(screen.queryByText(copy.settings.subscription.reloaded)).toBeNull()
  })

  it('内核在跑却拒收：已导入但未生效，原因一起显示', async () => {
    mount({
      importUrl: async () => ({
        ok: true,
        applied: 'reload-failed',
        message: '内核拒绝了新配置（HTTP 400）'
      })
    })

    await userEvent.type(urlInput(), 'https://example.com/sub')
    await userEvent.click(submit())

    expect(
      await screen.findByText(
        `${copy.settings.subscription.reloadFailed}内核拒绝了新配置（HTTP 400）`
      )
    ).toBeInTheDocument()
    expect(screen.queryByText(copy.settings.subscription.reloaded)).toBeNull()
    // 没生效就要给出重启这个出口。
    expect(
      screen.getByRole('button', { name: copy.settings.subscription.restart })
    ).toBeInTheDocument()
  })

  it('主进程拒绝时原样显示它给的原因，不说「已导入」', async () => {
    mount({ importUrl: async () => ({ ok: false, message: '订阅返回 404' }) })

    await userEvent.type(urlInput(), 'https://example.com/sub')
    await userEvent.click(submit())

    expect(await screen.findByText('订阅返回 404')).toBeInTheDocument()
    expect(screen.queryByText(copy.settings.subscription.imported)).toBeNull()
    // 失败时保留输入，用户可以改一处再试。
    expect(urlInput()).toHaveValue('https://example.com/sub')
  })

  it('主进程没给原因时用兜底文案', async () => {
    mount({ importUrl: async () => ({ ok: false, message: '' }) })

    await userEvent.type(urlInput(), 'https://example.com/sub')
    await userEvent.click(submit())

    expect(await screen.findByText(copy.settings.subscription.failed)).toBeInTheDocument()
  })

  it('通道抛错也算失败', async () => {
    mount({
      importUrl: async () => {
        throw new Error('IPC 断了')
      }
    })

    await userEvent.type(urlInput(), 'https://example.com/sub')
    await userEvent.click(submit())

    expect(await screen.findByText(copy.settings.subscription.failed)).toBeInTheDocument()
  })

  it('回车提交与点按钮等价', async () => {
    const { importConfigFromUrl } = mount()

    await userEvent.type(urlInput(), 'https://example.com/sub{Enter}')

    await waitFor(() =>
      expect(importConfigFromUrl).toHaveBeenCalledWith('https://example.com/sub')
    )
  })

  it('导入进行中：按钮禁用且文案变成进行时，连点不会发第二次请求', async () => {
    let release: (() => void) | undefined
    const importConfigFromUrl = vi.fn(
      () =>
        new Promise<UrlImportResult>((resolve) => {
          release = () => resolve({ ok: true, applied: 'reloaded' })
        })
    )
    mount({ importUrl: importConfigFromUrl })

    await userEvent.type(urlInput(), 'https://example.com/sub')
    await userEvent.click(submit())

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: copy.settings.subscription.importing })
      ).toBeDisabled()
    )
    await userEvent.click(
      screen.getByRole('button', { name: copy.settings.subscription.importing })
    )
    expect(importConfigFromUrl).toHaveBeenCalledTimes(1)

    release?.()
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: copy.settings.subscription.action })
      ).toBeEnabled()
    )
  })

  it('重新输入时清掉上一次的成功/失败提示', async () => {
    mount()
    await userEvent.type(urlInput(), 'https://example.com/sub')
    await userEvent.click(submit())
    expect(await screen.findByText(copy.settings.subscription.reloaded)).toBeInTheDocument()

    await userEvent.type(urlInput(), 'h')

    expect(screen.queryByText(copy.settings.subscription.reloaded)).toBeNull()
  })

  it('自启读失败也不会连带锁死导入卡片', async () => {
    mount({
      get: async () => {
        throw new Error('IPC 断了')
      }
    })

    expect(await screen.findByText(copy.settings.autostart.loadFailed)).toBeInTheDocument()
    expect(screen.getByPlaceholderText(copy.settings.subscription.placeholder)).toBeInTheDocument()
  })
})
