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
 *
 * 窗口重建后的首屏**不能**只等下一帧推送：主进程每秒才推送一次，在此之前
 * 三张速率卡和流量图都是空的。这里与 `useConnections` 同一形状——先订阅再补拉
 * `getStats()`，收到过推送后丢弃补拉结果（推送更新）。
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

    let receivedPush = false

    const applyPush = (sample: StatsSample): void => {
      if (!mounted.current) return
      const normalized = normalize(sample)
      if (normalized === null) return
      receivedPush = true
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
    }

    const off = api.onStats(applyPush)

    // 首屏补拉：快照本身就是「最近 60 点 + 当前值」，直接作为起点，不重复追加。
    void api.getStats().then(
      (sample) => {
        if (!mounted.current || receivedPush || sample === null) return
        const normalized = normalize(sample)
        if (normalized === null) return
        setState({
          current: normalized.current,
          history: normalized.history ?? []
        })
      },
      () => {
        // 补拉失败时保留空状态；下一帧推送会自然补齐。
      }
    )

    return () => {
      mounted.current = false
      off()
    }
  }, [])

  return state
}
