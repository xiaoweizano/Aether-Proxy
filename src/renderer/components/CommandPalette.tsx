import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent
} from 'react'
import type { AppStatusView, ProxyGroupView } from '../../shared/ipc'
import { copy } from '../copy'
import { useCommands, type PaletteCommand } from '../hooks/useCommands'
import type { Page } from '../page'

export interface CommandPaletteProps {
  /** App 的 `useProxies` 轮询结果；面板不自己开轮询器。 */
  groups: ProxyGroupView[]
  status: AppStatusView | null
  onNavigate(page: Page): void
  onRefresh?(): void
}

/** `Ctrl+K`，macOS 上是 `⌘K`；`Shift` / `Alt` 同时按下视为别的快捷键，不抢。 */
function isPaletteShortcut(event: globalThis.KeyboardEvent | KeyboardEvent): boolean {
  if (!(event.ctrlKey || event.metaKey)) return false
  if (event.altKey || event.shiftKey) return false
  return event.key.toLowerCase() === 'k'
}

/**
 * 命令面板：节点搜索 + 固定动作集，全程键盘可操作。
 *
 * 输入框用 combobox + listbox 的 activedescendant 模式：焦点始终留在输入框，
 * 高亮是纯状态，因此 Tab 的陷阱只需要看输入框自己。打开前记住焦点，
 * 关闭（Esc / 遮罩 / 执行）后还回去；执行动作前先关闭，面板不等待任何请求。
 */
export function CommandPalette({
  groups,
  status,
  onNavigate,
  onRefresh
}: CommandPaletteProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const optionRefs = useRef<(HTMLDivElement | null)[]>([])
  const baseId = useId()
  const commands = useCommands({ groups, status, onNavigate, onRefresh })

  const filter = query.trim().toLowerCase()
  const visible = useMemo(
    () =>
      filter === ''
        ? commands
        : commands.filter((command) => command.title.toLowerCase().includes(filter)),
    [commands, filter]
  )

  const grouped = useMemo(() => {
    let index = 0
    const groupsOfCommands = [
      {
        key: 'action',
        label: copy.palette.actionsLabel,
        items: visible
          .filter((command) => command.kind === 'action')
          .map((command) => ({ command, index: index++ }))
      },
      {
        key: 'node',
        label: copy.palette.nodesLabel,
        items: visible
          .filter((command) => command.kind === 'node')
          .map((command) => ({ command, index: index++ }))
      }
    ]
    return groupsOfCommands.filter((group) => group.items.length > 0)
  }, [visible])

  const optionId = (index: number): string => `${baseId}-option-${index}`

  const close = useCallback(() => {
    setOpen(false)
    const previous = previousFocus.current
    previousFocus.current = null
    if (previous !== null && previous.isConnected) previous.focus()
  }, [])

  // 关闭状态只接 Ctrl+K：别的按键原样放行，下层页面的快捷键不受影响。
  useEffect(() => {
    if (open) return undefined
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.defaultPrevented || !isPaletteShortcut(event)) return
      event.preventDefault()
      const focused = document.activeElement
      previousFocus.current = focused instanceof HTMLElement ? focused : null
      setQuery('')
      setActiveIndex(0)
      setOpen(true)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  // 打开时聚焦输入框；Esc 在 window 捕获阶段处理并截断，避免连接页等
  // 下层页面同时响应同一次 Esc（例如清空搜索）。
  useEffect(() => {
    if (!open) return undefined
    inputRef.current?.focus()
    inputRef.current?.select()
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      close()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open, close])

  // 轮询可能缩短列表：高亮索引不能停在越界的位置。
  useEffect(() => {
    if (activeIndex < visible.length) return
    setActiveIndex(visible.length === 0 ? 0 : visible.length - 1)
  }, [activeIndex, visible.length])

  // 键盘移动后把高亮项滚进视口；jsdom 没有布局实现，pad 成可选调用。
  useEffect(() => {
    if (!open) return
    optionRefs.current[activeIndex]?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex, open])

  const execute = useCallback(
    (command: PaletteCommand | undefined): void => {
      if (command === undefined) return
      close()
      try {
        // 动作失败一律静默：面板关闭后由各页面自己的状态或错误行汇报。
        void Promise.resolve(command.run()).catch(() => {})
      } catch {
        // 同步抛错同样吞掉，键位操作不能把异常冒到 window。
      }
    },
    [close]
  )

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Tab') {
      // 焦点陷阱：面板里唯一可聚焦的是输入框，Tab / Shift+Tab 都留在原地。
      event.preventDefault()
      const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])'
      )
      const items = focusables === undefined ? [] : Array.from(focusables)
      if (items.length <= 1) {
        inputRef.current?.focus()
        return
      }
      const current = items.indexOf(document.activeElement as HTMLElement)
      const next = event.shiftKey
        ? current <= 0
          ? items.length - 1
          : current - 1
        : current === -1 || current === items.length - 1
          ? 0
          : current + 1
      items[next]?.focus()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (visible.length === 0) return
      event.preventDefault()
      setActiveIndex((previous) =>
        event.key === 'ArrowDown'
          ? Math.min(visible.length - 1, previous + 1)
          : Math.max(0, previous - 1)
      )
      return
    }
    if (event.key === 'Enter') {
      if (event.repeat) return
      event.preventDefault()
      execute(visible[activeIndex])
    }
  }

  if (!open) return null

  const active = visible[activeIndex]

  return (
    <div
      className="palette-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label={copy.palette.label}
        ref={dialogRef}
      >
        <input
          ref={inputRef}
          className="palette-input"
          type="text"
          role="combobox"
          aria-label={copy.palette.inputLabel}
          aria-expanded={visible.length > 0}
          aria-controls={`${baseId}-list`}
          aria-autocomplete="list"
          aria-activedescendant={active === undefined ? undefined : optionId(activeIndex)}
          placeholder={copy.palette.placeholder}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setActiveIndex(0)
          }}
          onKeyDown={onInputKeyDown}
        />
        <div
          className="palette-list"
          id={`${baseId}-list`}
          role="listbox"
          aria-label={copy.palette.listLabel}
        >
          {visible.length === 0 ? (
            <p className="palette-empty" role="presentation">
              {copy.palette.empty}
            </p>
          ) : (
            grouped.map((group) => (
              <div className="palette-group" role="group" aria-label={group.label} key={group.key}>
                <div className="palette-group-label" aria-hidden="true">
                  {group.label}
                </div>
                {group.items.map(({ command, index }) => (
                  <div
                    key={command.id}
                    ref={(node) => {
                      optionRefs.current[index] = node
                    }}
                    id={optionId(index)}
                    className="palette-option"
                    role="option"
                    aria-selected={index === activeIndex}
                    onMouseEnter={() => {
                      setActiveIndex(index)
                    }}
                    onClick={() => {
                      execute(command)
                    }}
                  >
                    <span className="palette-option-title">{command.title}</span>
                    {command.detail !== undefined && (
                      <span className="palette-option-detail">{command.detail}</span>
                    )}
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
