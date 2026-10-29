export interface RestartPolicy {
  maxAttempts: number
  windowMs: number
  delaysMs: number[]
}

export const DEFAULT_POLICY: RestartPolicy = {
  maxAttempts: 3,
  windowMs: 10 * 60_000,
  delaysMs: [1000, 2000, 4000]
}

export function nextRestart(
  attempts: number[],
  now: number,
  policy: RestartPolicy = DEFAULT_POLICY
): { delayMs: number } | null {
  const recent = attempts.filter((t) => now - t < policy.windowMs)
  if (recent.length >= policy.maxAttempts) return null
  const idx = Math.min(recent.length, policy.delaysMs.length - 1)
  return { delayMs: policy.delaysMs[idx] ?? policy.delaysMs[policy.delaysMs.length - 1]! }
}
