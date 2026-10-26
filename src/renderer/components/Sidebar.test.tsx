import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { copy } from '../copy'
import { readyStatus } from '../test-utils'
import { Sidebar } from './Sidebar'

function dotClass(container: HTMLElement): string | undefined {
  return container.querySelector('.sidebar-meta-dot')?.className
}

describe('Sidebar', () => {
  it('ready 时版本点是绿色（与顶栏同色，低一级）', () => {
    const { container } = render(<Sidebar status={readyStatus} />)
    expect(dotClass(container)).toContain('ready')
    expect(dotClass(container)).not.toContain('idle')
  })

  it('core-error 时版本点转红', () => {
    const { container } = render(<Sidebar status={{ ...readyStatus, status: 'core-error' }} />)
    expect(dotClass(container)).toContain('error')
  })

  it.each(['no-config', 'config-error', 'in-use'] as const)(
    '%s 时版本点变淡，不再显示绿色',
    (status) => {
      const { container } = render(<Sidebar status={{ ...readyStatus, status }} />)
      expect(dotClass(container)).toContain('idle')
      expect(dotClass(container)).not.toContain('ready')
    }
  )

  it('状态尚未加载时也是灰点', () => {
    const { container } = render(<Sidebar status={null} />)
    expect(dotClass(container)).toContain('idle')
  })

  it('侧栏仍显示版本号', () => {
    const { getByText } = render(<Sidebar status={readyStatus} />)
    expect(getByText(copy.version)).toBeInTheDocument()
  })
})
