import { useEffect, useRef, useState } from 'react'
import type { ModeSetResult } from '../../shared/ipc'
import type { Mode } from '../../shared/types'
import { copy } from '../copy'

const MODES: { mode: Mode; label: string }[] = [
  { mode: 'rule', label: copy.mode.rule },
  { mode: 'global', label: copy.mode.global },
  { mode: 'direct', label: copy.mode.direct }
]

export interface ModeSwitchProps {
  value: Mode
  onChange?(mode: Mode): void
  setMode?(mode: Mode): Promise<ModeSetResult>
}

/** 规则 / 全局 / 直连；点击先乐观选中，失败回滚并留下一条错误。 */
export function ModeSwitch({ value, onChange, setMode }: ModeSwitchProps) {
  const [selected, setSelected] = useState<Mode>(value)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const confirmed = useRef<Mode>(value)

  useEffect(() => {
    confirmed.current = value
    setSelected(value)
  }, [value])

  async function choose(mode: Mode): Promise<void> {
    if (mode === selected || pending) return
    const previous = confirmed.current
    setSelected(mode)
    setError(null)
    setPending(true)
    try {
      const apply = setMode ?? window.aether?.setMode
      if (apply === undefined) throw new Error('setMode is unavailable')
      const result = await apply(mode)
      if (!result.ok) {
        setSelected(previous)
        setError(copy.modeSwitchFailed)
        return
      }
      confirmed.current = mode
      onChange?.(mode)
    } catch {
      setSelected(previous)
      setError(copy.modeSwitchFailed)
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="mode-switch-shell">
      <div className="mode-switch" role="group" aria-label={copy.mode.label}>
        {MODES.map((option) => (
          <button
            key={option.mode}
            type="button"
            className="mode-switch-option"
            aria-pressed={selected === option.mode}
            onClick={() => {
              void choose(option.mode)
            }}
          >
            {option.label}
          </button>
        ))}
      </div>
      {error !== null && (
        <span className="inline-error" role="alert">
          {error}
        </span>
      )}
    </div>
  )
}
