import { useEffect, useRef, useState } from 'react'
import type { StatsSample } from '../../shared/ipc'

/** 与主进程环形缓冲同一个长度：一分钟、每秒一个点。 */
export const MAX_SAMPLES = 60

/** 图表与速率卡共用的当前值；只有这四个字段，避免把上游原文带进渲染层。 */
export interface StatsCurrent {
  up: number
  down: number
  upTotal: number
  downTotal: number
}

export interface TrafficSample {
  up: number
  down: number
}

export interface StatsState {
  current: StatsCurrent | null
  history: TrafficSample[]
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/**
 * 逐字段校验：推送里任何一个数字非法就整条丢弃，否则 `NaN` 会顺着图表路径渲染出去。
 * `history` 同样过滤，不信任上游数组的内部一致性。
 */
function normalize(sample: StatsSample): { current: StatsCurrent; history: TrafficSample[] | null } | null {
  const { up, down, upTotal, downTotal } = sample
  if (!isCount(up) || !isCount(down) || !isCount(upTotal) || !isCount(downTotal)) return null
  let history: TrafficSample[] | null = null
  if (Array.isArray(sample.history)) {
    history = sample.history
      .filter((entry) => isCount(entry?.up) && isCount(entry?.down))
      .map((entry) => ({ up: entry.up, down: entry.down }))
      .slice(-MAX_SAMPLES)
  }
  return { current: { up, down, upTotal, downTotal }, history }
}

function sameSample(a: TrafficSample, b: TrafficSample): boolean {
  return a.up === b.up && a.down === b.down
}

/**
 * 追加一个样本。主进程的 `history` 已经包含本条，只有当它确实以本条结尾时才跳过追加；
 * 没有 `history` 时一律追加——连续两个相同的空闲样本是两个点，不是一个。
 */
function appendSample(
  history: TrafficSample[],
  sample: TrafficSample,
  fromPayload: boolean
): TrafficSample[] {
  const last = history.at(-1)
  const alreadyThere = fromPayload && last !== undefined && sameSample(last, sample)
  const next = alreadyThere ? history : [...history, sample]
  return next.slice(-MAX_SAMPLES)
}
/**
 * 订阅主进程的流量推送，维护最近 60 个样本。
 *
 * 主进程每次推送都带完整 `history`；以它为起点可以填补窗口重建后的空档，
 * 且当 `history` 的最后一条就是本样本时不会重复追加。
 */
export function useStats(): StatsState {
  const [state, setState] = useState<StatsState>({ current: null, history: [] })
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    const api = window.aether
    if (api === undefined) {
      return () => {
        mounted.current = false
      }
    }

    const off = api.onStats((sample) => {
      if (!mounted.current) return
      const normalized = normalize(sample)
      if (normalized === null) return
      setState((previous) => {
        const fromPayload = normalized.history !== null
        const base = normalized.history ?? previous.history
        return {
          current: normalized.current,
          history: appendSample(
            base,
            { up: normalized.current.up, down: normalized.current.down },
            fromPayload
          )
        }
      })
    })

    return () => {
      mounted.current = false
      off()
    }
  }, [])

  return state
}
