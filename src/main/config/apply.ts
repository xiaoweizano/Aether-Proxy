export interface ApplyDeps {
  /** 写入 runtime.yaml.next，返回其路径。 */
  writeNext(config: unknown): Promise<string>
  validate(nextPath: string): Promise<{ ok: boolean; output: string }>
  /** prev <- runtime，next -> runtime。 */
  promote(nextPath: string): Promise<void>
  rollback(): Promise<void>
  reload(): Promise<{ ok: boolean; status: number }>
}

/**
 * 配置变更只有在“写好下一版 → 校验通过 → 晋升为 runtime”之后才触发热重载。
 * 校验失败时 runtime 保持不变；重载失败则回滚到上一版。
 */
export async function applyConfig(
  config: unknown,
  deps: ApplyDeps
): Promise<{ ok: boolean; reason?: 'invalid' | 'reload' }> {
  const nextPath = await deps.writeNext(config)

  const validation = await deps.validate(nextPath)
  if (!validation.ok) return { ok: false, reason: 'invalid' }

  await deps.promote(nextPath)

  const reload = await deps.reload()
  if (!reload.ok) {
    await deps.rollback()
    return { ok: false, reason: 'reload' }
  }

  return { ok: true }
}
