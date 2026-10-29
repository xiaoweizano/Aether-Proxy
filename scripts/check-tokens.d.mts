export interface TokenBaseline {
  version: number
  note?: string
  /** 相对于 root（CLI 下是仓库根）的文件路径 → 裸值 → 允许出现的次数。 */
  files: Record<string, Record<string, number>>
}

export interface CheckOptions {
  baseline?: TokenBaseline
  /** 基线路径的相对基准，默认为 process.cwd()。 */
  root?: string
}

export declare function checkTokens(dir: string, options?: CheckOptions): string[]

export declare function buildBaseline(dir: string, options?: { root?: string }): TokenBaseline

export declare function loadBaseline(file: string): TokenBaseline

export declare function staleBaselineEntries(
  dir: string,
  baseline: TokenBaseline,
  options?: { root?: string }
): string[]
