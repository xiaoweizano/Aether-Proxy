import { readFile, rm } from 'node:fs/promises'
import { writeFileAtomic } from '../config/atomic'

export interface CoreState {
  pid: number
  port: number
  secret: string
}

function isCoreState(value: unknown): value is CoreState {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.pid === 'number' &&
    Number.isInteger(v.pid) &&
    typeof v.port === 'number' &&
    Number.isInteger(v.port) &&
    typeof v.secret === 'string'
  )
}

/** 记录本进程启动的内核身份，供下次启动识别孤儿进程（本计划只提供契约）。 */
export async function writeCoreState(file: string, state: CoreState): Promise<void> {
  await writeFileAtomic(file, JSON.stringify(state, null, 2))
}

export async function readCoreState(file: string): Promise<CoreState | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    return isCoreState(parsed) ? { pid: parsed.pid, port: parsed.port, secret: parsed.secret } : null
  } catch {
    return null
  }
}

export async function clearCoreState(file: string): Promise<void> {
  await rm(file, { force: true })
}
