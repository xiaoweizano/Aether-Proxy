import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import { buildCsp } from './src/shared/csp'

/** 占位符；HTML 里出现它说明替换漏了，产物就是坏的。 */
const PLACEHOLDER = '%AETHER_CSP%'

/**
 * 把渲染层的 CSP 写进 `index.html` 的占位符。
 *
 * 为什么不写死在 HTML 里：开发态要放开 Vite HMR 的内联脚本与 ws 连接，打包态不能放。
 * 策略只有一份（`src/shared/csp.ts`），这里只按当前命令选变体。
 *
 * 为什么还要 `closeBundle`：electron-vite 的打包流程不使用 `transformIndexHtml` 的返回值
 * （dev server 会用），产物里会原样留下占位符。因此构建结束后对产物再做一次同样的替换，
 * 开发与打包两条路径共用同一个 `buildCsp`。
 */
function cspPlugin(): Plugin {
  let dev = false
  let outDir = ''
  return {
    name: 'aether-csp',
    configResolved(config) {
      dev = config.command === 'serve'
      outDir = path.resolve(config.root, config.build.outDir)
    },
    transformIndexHtml(html) {
      return html.replace(PLACEHOLDER, buildCsp({ dev }))
    },
    async closeBundle() {
      if (dev) return
      const file = path.join(outDir, 'index.html')
      const html = await readFile(file, 'utf8').catch(() => null)
      if (html === null || !html.includes(PLACEHOLDER)) return
      await writeFile(file, html.replace(PLACEHOLDER, buildCsp({ dev: false })), 'utf8')
    }
  }
}

export default defineConfig({
  main: { build: { rollupOptions: { input: 'src/main/index.ts' } } },
  preload: {
    build: {
      rollupOptions: {
        input: 'src/preload/index.ts',
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    plugins: [cspPlugin()],
    build: { rollupOptions: { input: 'src/renderer/index.html' } }
  }
})
