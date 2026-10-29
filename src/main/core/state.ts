import { readFile, rm } from 'node:fs/promises'
import { writeFileAtomic } from '../config/atomic'

export interface CoreState {
  pid: number
  port: number
  secret: string
  /** 写入这条记录的 Aether 进程；用来区分「活实例的内核」与真正的孤儿。 */
  ownerPid: number
}

/** 旧版本写下的文件没有 ownerPid；读取时保持可选，不能因此判为损坏。 */
export type StoredCoreState = Omit<CoreState, 'ownerPid'> & { ownerPid?: number }

/**
 * 读取结果必须区分「没有文件」「内容损坏」「读失败」：
 * 只有确定损坏的文件才允许删除；EBUSY/EACCES 之类的临时错误不能当成损坏。
 */
export type CoreStateRead =
  | { kind: 'ok'; state: StoredCoreState }
  | { kind: 'missing' }
  | { kind: 'corrupt' }
  | { kind: 'unreadable'; error: unknown }

function isCoreState(value: unknown): value is StoredCoreState {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  const ownerOk =
    v.ownerPid === undefined ||
    (typeof v.ownerPid === 'number' && Number.isInteger(v.ownerPid) && v.ownerPid > 0)
  return (
    typeof v.pid === 'number' &&
    Number.isInteger(v.pid) &&
    typeof v.port === 'number' &&
    Number.isInteger(v.port) &&
    typeof v.secret === 'string' &&
    ownerOk
  )
}

/** 记录本进程启动的内核身份，供下次启动识别孤儿进程。ownerPid 由这里统一写入。 */
export async function writeCoreState(
  file: string,
  state: Omit<CoreState, 'ownerPid'>
): Promise<void> {
  const withOwner: CoreState = { ...state, ownerPid: process.pid }
  await writeFileAtomic(file, JSON.stringify(withOwner, null, 2))
}

export async function inspectCoreState(file: string): Promise<CoreStateRead> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
    return { kind: 'unreadable', error: err }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { kind: 'corrupt' }
  }
  if (!isCoreState(parsed)) return { kind: 'corrupt' }

  const state: StoredCoreState = { pid: parsed.pid, port: parsed.port, secret: parsed.secret }
  if (parsed.ownerPid !== undefined) state.ownerPid = parsed.ownerPid
  return { kind: 'ok', state }
}

export async function readCoreState(file: string): Promise<StoredCoreState | null> {
  const result = await inspectCoreState(file)
  return result.kind === 'ok' ? result.state : null
}

export async function clearCoreState(file: string): Promise<void> {
  await rm(file, { force: true })
}
