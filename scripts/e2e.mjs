#!/usr/bin/env node
import { mkdtemp, rm, readFile, copyFile, mkdir } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import YAML from 'yaml'

/**
 * M1 端到端验收（规格 8.1）：导入配置 → 切节点 → 开系统代理 → 验证出口 → 关代理 → 断言复原。
 *
 * 用真实 `vendor/mihomo.exe`、真实的 HKCU 系统代理（走 `src/main/proxy/win32.ts` 的同一条
 * koffi 路径），全程不碰 `%APPDATA%\aether-proxy`：内核 home 与 profile 都在一个临时目录里。
 *
 * 运行：`npx tsx scripts/e2e.mjs`（或 `npm run e2e`）
 *
 * 退出码：
 *   0  全链路通过，注册表已复原
 *   1  链路本身失败（切节点没生效、经系统代理的请求失败、注册表未复原等）
 *   2  无法验证：非 Windows、没有 curl、或**这台机器当前没有外网**。
 *      这一档必须与 1 分开：「没网」不是通过，也不是链路坏了。
 *   3  还原系统代理失败。单独一档，因为这是本脚本最严重的后果——
 *      它会在用户机器上留下一个指向死端口的系统代理。
 *
 * 安全约定：
 * - 系统代理在任何写操作之前先快照，`finally` 里还原并**回读校验**；校验不过就以 3 退出。
 * - 内核只按 PID 终止（`taskkill /F /PID`），绝不用镜像名——本机还跑着别家的 mihomo.exe。
 * - controller secret 只在内存里，不打印、不写盘。
 */

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const binary = path.join(repoRoot, 'vendor', 'mihomo.exe')
const fixture = path.join(repoRoot, 'test', 'fixtures', 'subscription.yaml')
const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

const EXIT = Object.freeze({ PASS: 0, FAIL: 1, CANNOT_VERIFY: 2, RESTORE_FAILED: 3 })

const HANDSHAKE_TIMEOUT_MS = 15_000
const CURL_TIMEOUT_MS = 15_000
const WATCHDOG_MS = 180_000

/** 「外网可达」探针。可被 `E2E_PROBE_URL` 覆盖，用于演示/自测「没网 → 退出 2」这一档。 */
const PROBE_URL = process.env.E2E_PROBE_URL ?? 'http://www.gstatic.com/generate_204'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 清理阶段是否发生了「还原不可信」。模块级，供 main 返回后的退出码合并。 */
let restoreFailedEver = false

function log(line) {
  console.log(`[e2e] ${line}`)
}

function fail(reason) {
  console.error(`[e2e] 失败：${reason}`)
  return EXIT.FAIL
}

function cannotVerify(reason) {
  console.error(`[e2e] 无法验证：${reason}`)
  return EXIT.CANNOT_VERIFY
}

/** `reg query` 的原文，用于「注册表是否字节级复原」的比对。 */
async function dumpRegistry() {
  const { stdout } = await execFileAsync('reg.exe', ['query', REG_KEY], {
    encoding: 'utf8',
    windowsHide: true
  })
  return stdout.replace(/\r\n/g, '\n').trimEnd()
}

/** 行级差异；用于在失败时指出究竟哪一行变了。 */
function lineDiff(before, after) {
  const left = new Set(before.split('\n').filter(Boolean))
  const right = new Set(after.split('\n').filter(Boolean))
  return [
    ...[...left].filter((line) => !right.has(line)).map((line) => `- ${line}`),
    ...[...right].filter((line) => !left.has(line)).map((line) => `+ ${line}`)
  ]
}

/**
 * 经 HTTP 代理发一个请求。
 *
 * **为什么用 `curl -x` 而不是让 curl 自己读系统代理**：curl 只认环境变量
 * （`http_proxy` 等），从不读 WinINET 的 HKCU 设置，所以它「自动」用系统代理这件事
 * 从不存在。要验证的恰恰是「注册表里那个值能不能把流量送出去」，因此脚本先用应用
 * 自己的读取路径（`win32.ts` 的 `getSystemProxy`）把 registry 里的值读回来，再把这个
 * 读回的值交给 `curl -x`：注册表 → 读值 → 实际出网，三段都真实。
 *
 * @param {string | undefined} proxy `host:port`；为 `null`/`undefined` 时直连（`--noproxy '*'`）
 * @returns {Promise<{ code: number, body: string, stderr: string }>}
 */
async function curl(proxy, url) {
  const args = ['-sS', '--max-time', String(CURL_TIMEOUT_MS / 1000)]
  if (proxy === null || proxy === undefined) args.push('--noproxy', '*')
  else args.push('-x', proxy.startsWith('http://') ? proxy : `http://${proxy}`)
  args.push(url, '-w', '\n%{http_code}')
  try {
    const { stdout } = await execFileAsync('curl', args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: CURL_TIMEOUT_MS + 5_000,
      maxBuffer: 4 * 1024 * 1024
    })
    const split = stdout.lastIndexOf('\n')
    return { code: Number(stdout.slice(split + 1).trim()), body: stdout.slice(0, split), stderr: '' }
  } catch (error) {
    return {
      code: 0,
      body: typeof error.stdout === 'string' ? error.stdout : '',
      stderr: typeof error.stderr === 'string' ? error.stderr : String(error.message)
    }
  }
}

/** 起一个只监听 127.0.0.1 的 HTTP 服务，返回端口与关闭函数。 */
function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler)
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address !== 'object') {
        server.close(() => reject(new Error('无法取得监听端口')))
        return
      }
      resolve({
        port: address.port,
        close: () => closeServer(server)
      })
    })
  })
}

/**
 * 关闭 HTTP 服务。
 *
 * 直接 `server.close()` 会一直等到所有连接结束——mihomo 的 keep-alive 连接在我方
 * 关掉内核后仍可能挂在服务端，实测会让进程卡到看门狗（180s）才退出。
 * 因此先强制断开所有连接，再关监听。
 * @param {import('node:http').Server} server
 */
function closeServer(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.()
    server.close(() => resolve())
  })
}

/** 按 PID 强杀。只用 PID，绝不 taskkill /IM mihomo.exe（会误伤用户自己的内核）。 */
async function taskkillPid(pid) {
  try {
    await execFileAsync('taskkill', ['/F', '/PID', String(pid)], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5_000
    })
    return true
  } catch (error) {
    // 进程已退出时 taskkill 返回非 0，这不是失败。
    const text = `${error.stdout ?? ''}${error.stderr ?? ''}`
    return /not found|没有找到|PID/.test(text) || error.code === 128
  }
}

async function main() {
  if (process.platform !== 'win32') {
    return cannotVerify(`只支持 Windows（当前 ${process.platform}）。`)
  }

  // 外网可用性先于任何代理写操作判定：没网就立刻退出 2，绝不先改注册表。
  const direct = await curl(null, PROBE_URL)
  if (direct.code !== 204) {
    return cannotVerify(
      `直连 ${PROBE_URL} 返回 ${direct.code === 0 ? `不可达（${direct.stderr.trim() || 'curl 无输出'}）` : direct.code}；` +
        '没有外网时无法证明「经系统代理能出网」。'
    )
  }
  log('外网可达（直连 204），开始端到端链路')

  const { loadWindowsProxy } = await import('../src/main/proxy/win32.ts')
  const { mergeConfig } = await import('../src/main/config/merge.ts')
  const { writeRuntime } = await import('../src/main/config/runtime.ts')
  const { ensureGeodata, verifyGeodata } = await import('../src/main/config/geodata.ts')
  const { importFromFile } = await import('../src/main/config/import.ts')
  const { allocatePort } = await import('../src/main/core/ports.ts')
  const { newSecret } = await import('../src/main/core/secret.ts')

  const pp = loadWindowsProxy()

  // ── 快照：任何写操作之前的系统代理状态（结构化 + 注册表原文） ────────────────
  const snapshot = await pp.getSystemProxy()
  const rawSnapshot = await dumpRegistry()
  log(
    `系统代理快照：enabled=${snapshot.enabled} server=${snapshot.server ?? '（无）'} ` +
      `autoConfigUrl=${snapshot.autoConfigUrl ?? '（无）'} autoDetect=${snapshot.autoDetect}`
  )

  let kernelPid = null
  let cleanupDone = false
  const servers = []
  let tempDir = null

  /**
   * 幂等清理：还原代理（并回读校验）→ 按 PID 杀内核 → 关本地服务 → 删临时目录。
   * 顺序固定：先让用户的流量回到原路，再拆我们自己那条路。
   * 不改 `exitCode`；由调用方合并（`finally` 里也要再调一次）。
   */
  async function cleanup() {
    if (cleanupDone) return !restoreFailedEver
    cleanupDone = true

    try {
      await pp.restore(snapshot)
      const after = await pp.getSystemProxy()
      const rawAfter = await dumpRegistry()
      const stateSame = JSON.stringify(after) === JSON.stringify(snapshot)
      const diff = stateSame ? [] : lineDiff(rawSnapshot, rawAfter)
      // Windows 在广播后可能删除显式的 AutoDetect=0（已在 proxy-check 中实测）。
      // 只容忍这一种差异，其余任何差异都算「没复原」。
      const onlyAutoDetect = diff.every((line) => / AutoDetect /.test(line))
      log(`系统代理已还原：状态一致=${stateSame}${diff.length === 0 ? '，注册表原文一致' : ''}`)
      if (!stateSame) {
        console.error('[e2e] 注册表差异：\n' + diff.join('\n'))
        console.error('[e2e] 还原后状态与快照不符，这是严重的：系统代理可能停在测试端口上。')
        restoreFailedEver = true
      } else if (diff.length > 0 && !onlyAutoDetect) {
        console.error('[e2e] 注册表原文存在非 AutoDetect 差异：\n' + diff.join('\n'))
        console.error('[e2e] 还原不可信。')
        restoreFailedEver = true
      } else if (diff.length > 0) {
        log('注册表原文差异仅限 AutoDetect（Windows 广播后删除显式 0 的已知行为），不算异常。')
      }
    } catch (error) {
      console.error(
        '[e2e] 还原系统代理失败：',
        error instanceof Error ? error.message : error,
        '\n[e2e] 请立即手动确认 HKCU\\...\\Internet Settings 的 ProxyEnable/ProxyServer。'
      )
      restoreFailedEver = true
    }

    if (kernelPid !== null) {
      const killed = await taskkillPid(kernelPid)
      log(killed ? `内核已按 PID ${kernelPid} 终止` : `内核 PID ${kernelPid} 终止失败（可能已退出）`)
      kernelPid = null
    }
    for (const server of servers) await server.close().catch(() => {})
    if (tempDir !== null) await rm(tempDir, { recursive: true, force: true }).catch(() => {})
    return !restoreFailedEver
  }

  const watchdog = setTimeout(() => {
    console.error('[e2e] 超过 180 秒未结束，执行清理后退出。')
    void cleanup().then(() => process.exit(EXIT.FAIL))
  }, WATCHDOG_MS)
  // 不让看门狗单独拖住进程：主流程结束时它会随进程一起消失。
  watchdog.unref?.()

  try {
    // ── 1. 导入配置（真实 import 路径）+ 临时 profile ─────────────────────────
    tempDir = await mkdtemp(path.join(tmpdir(), 'aether-e2e-'))
    const profileDir = path.join(tempDir, 'profile')
    await mkdir(profileDir, { recursive: true })
    await importFromFile(profileDir, fixture)
    const upstream = YAML.parse(await readFile(path.join(profileDir, 'upstream.yaml'), 'utf8'))
    log(`配置已导入临时 profile：${profileDir}`)

    // 本地「上游节点」：一个最低限度的 HTTP 代理解析器。所有走到节点的流量都打到这里
    // 并计数，用来证明「规则 → 策略组 → 节点」真的把请求交给了选中的节点。
    // 它不代替 curl 去取源站：请求体原样返回一个固定响应即可，判断依据是「上游收到没有」。
    // 必须同时处理两类请求：mihomo 的 http 出站对 http:// 目标通常发 CONNECT 隧道，
    // 只回普通请求会让它一直等到超时（实测错误：dial ... context deadline exceeded）。
    const upstreamHits = { count: 0 }
    /** CONNECT 隧道里的裸 socket 不在 `closeAllConnections` 的管辖范围内，得自己记着。 */
    const tunnels = new Set()
    const upstreamServer = http.createServer((req, res) => {
      upstreamHits.count += 1
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('e2e-upstream-ok')
    })
    upstreamServer.on('connect', (req, socket) => {
      upstreamHits.count += 1
      tunnels.add(socket)
      socket.once('close', () => tunnels.delete(socket))
      socket.on('error', () => socket.destroy())
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      // 本地上游只用来证明「流量确实交给了这个节点」，不需要真的转发目标内容：
      // 回完隧道建立响应后再给一个固定 200，curl 侧就能拿到可判定的结果。
      socket.write(
        'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 15\r\nConnection: close\r\n\r\ne2e-upstream-ok'
      )
      socket.end()
    })
    const upstreamProxy = await new Promise((resolve, reject) => {
      upstreamServer.once('error', reject)
      upstreamServer.listen(0, '127.0.0.1', () => {
        resolve({
          port: upstreamServer.address().port,
          close: async () => {
            for (const socket of tunnels) socket.destroy()
            tunnels.clear()
            await closeServer(upstreamServer)
          }
        })
      })
    })
    servers.push(upstreamProxy)

    // 本地 provider：fixture 的 url-test 组用 `use: [prov-a]`，而 fixture 里的 prov-a
    // 指向 127.0.0.1:9（不可达）。实测：provider 拉取失败时 mihomo 对**所有**经代理的
    // 请求返回 502，链路验证会假失败。所以这里提供一个真实的本地 provider。
    // 节点名叫 E2E-A / E2E-B，避免与 fixture 里已有的 HK-01 重名。
    const provider = await listen((req, res) => {
      res.writeHead(200, { 'content-type': 'text/yaml' })
      res.end(
        [
          'proxies:',
          `  - { name: E2E-A, type: http, server: 127.0.0.1, port: ${upstreamProxy.port} }`,
          `  - { name: E2E-B, type: http, server: 127.0.0.1, port: ${upstreamProxy.port} }`,
          ''
        ].join('\n')
      )
    })
    servers.push(provider)

    const mixedPort = await allocatePort()
    const controllerPort = await allocatePort()
    const secret = newSecret()

    const merged = mergeConfig(
      upstream,
      {
        'proxy-providers': {
          'prov-a': { type: 'http', url: `http://127.0.0.1:${provider.port}/prov.yaml`, interval: 3600 }
        },
        'proxy-groups': [
          // 只有名字相同的组会被替换。provider 里的节点不能直接写进 `proxies`（-t 会报
          // "not found"），select 组必须用 `use` 引用 provider。
          { name: 'Proxy', type: 'select', use: ['prov-a'], proxies: ['HK-01'] }
        ],
        rules: { prepend: ['DOMAIN-SUFFIX,e2e.test,Proxy'] }
      },
      { mixedPort, controllerPort, secret }
    )
    const runtimePath = await writeRuntime(profileDir, merged)

    await ensureGeodata(profileDir, path.join(repoRoot, 'vendor', 'geodata'))
    const geodata = await verifyGeodata(profileDir, path.join(repoRoot, 'vendor', 'geodata'))
    if (!geodata.ok) throw new Error(`geodata 未就绪：${geodata.missing.join(', ')}`)
    log('geodata 校验通过')

    const { execFileSync } = await import('node:child_process')
    const testOutput = execFileSync(binary, ['-t', '-d', profileDir, '-f', runtimePath], {
      encoding: 'utf8'
    })
    if (!/test is successful|配置测试成功/i.test(testOutput)) {
      throw new Error(`mihomo -t 未报告成功：${testOutput.trim()}`)
    }
    log('mihomo -t 通过')

    // ── 2. 启动内核并等 /version 握手 ─────────────────────────────────────────
    const { spawn } = await import('node:child_process')
    const child = spawn(binary, ['-d', profileDir, '-f', runtimePath], {
      windowsHide: true,
      stdio: 'ignore'
    })
    kernelPid = child.pid ?? null
    if (kernelPid === null) throw new Error('内核 spawn 后没有 PID')
    log(`内核已启动，pid ${kernelPid}，mixed ${mixedPort}，controller ${controllerPort}`)

    const api = (controllerPath, options = {}) =>
      fetch(`http://127.0.0.1:${controllerPort}${controllerPath}`, {
        ...options,
        headers: { authorization: `Bearer ${secret}`, ...(options.headers ?? {}) },
        signal: AbortSignal.timeout(10_000)
      })

    const handshakeStart = Date.now()
    let version = null
    while (Date.now() - handshakeStart < HANDSHAKE_TIMEOUT_MS) {
      try {
        const res = await api('/version')
        if (res.ok) {
          version = await res.json()
          break
        }
      } catch {
        // 内核还没起来：继续等。
      }
      await sleep(200)
    }
    if (version === null) throw new Error(`内核 ${HANDSHAKE_TIMEOUT_MS / 1000}s 内未握手`)
    log(`内核握手成功：${version.version}（${Date.now() - handshakeStart} ms）`)

    // ── 3. 切节点：Select 组改 `now`，URLTest 组只改 `fixed` ──────────────────
    const put = await api('/proxies/Proxy', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'E2E-B' })
    })
    if (put.status !== 204) throw new Error(`PUT /proxies/Proxy 返回 ${put.status}，期望 204`)

    let proxies = await (await api('/proxies')).json()
    const selected = proxies.proxies?.Proxy
    if (selected?.now !== 'E2E-B') {
      throw new Error(`切节点未生效：Proxy.now = ${JSON.stringify(selected?.now)}，期望 E2E-B`)
    }
    log('Select 组切换生效：Proxy.now = E2E-B')

    // URLTest 组：响应同样是 204，但 `PUT` 只写 `fixed`，`now` 由健康测试决定。
    // 本地 provider 的两个节点都指向本地上游，所以这里只断言 `fixed`，不假装 `now` 会变。
    const autoPut = await api('/proxies/Auto', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'E2E-A' })
    })
    if (autoPut.status !== 204) throw new Error(`PUT /proxies/Auto 返回 ${autoPut.status}，期望 204`)
    await sleep(300)
    proxies = await (await api('/proxies')).json()
    const auto = proxies.proxies?.Auto
    if (auto?.fixed !== 'E2E-A') {
      throw new Error(`自动组的 fixed 未生效：${JSON.stringify(auto?.fixed)}，期望 E2E-A`)
    }
    log(
      `URLTest 组切换：204，fixed = E2E-A（now = ${JSON.stringify(auto.now)}，由健康测试决定，未被 PUT 改写）`
    )

    // ── 4. 开系统代理（与应用同一条 koffi 路径），回读确认 ─────────────────────
    const server = `127.0.0.1:${mixedPort}`
    await pp.setSystemProxy({ server, bypass: ['localhost', '127.0.0.0/8', '::1', '<local>'] })
    const during = await pp.getSystemProxy()
    if (!during.enabled || during.server !== server) {
      throw new Error(`系统代理未生效：enabled=${during.enabled} server=${during.server ?? '（无）'}`)
    }
    log(`系统代理已开启：${during.server}（ProxyEnable=1）`)

    // ── 5. 用「读回来的系统代理值」验证出网 ──────────────────────────────────
    // 先用本地域名验证完整链路：系统代理 → mixed port → 规则 → Proxy 组 → E2E-B → 本地上游。
    const chain = await curl(during.server, 'http://e2e.test/')
    if (chain.code !== 200 || !chain.body.includes('e2e-upstream-ok')) {
      throw new Error(
        `经系统代理访问 e2e.test 失败：HTTP ${chain.code}，body=${JSON.stringify(chain.body.slice(0, 120))}`
      )
    }
    if (upstreamHits.count < 1) {
      throw new Error('本地上游没有收到请求：规则/策略组/节点未把流量交给选中的节点')
    }
    log(`链路命中：e2e.test → E2E-B → 本地上游（上游收到 ${upstreamHits.count} 个请求）`)

    // 再访问真实外网：这一跳走规则 MATCH,DIRECT，证明 mixed port 能把流量送出本机。
    const outside = await curl(during.server, PROBE_URL)
    if (outside.code !== 204) {
      throw new Error(
        `经系统代理访问外网返回 ${outside.code === 0 ? `不可达（${outside.stderr.trim()}）` : outside.code}，期望 204`
      )
    }
    log('经系统代理访问外网：204（curl -x 使用从注册表读回的 ProxyServer 值）')

    // ── 6. 关系统代理，回到快照 ──────────────────────────────────────────────
    await pp.clearSystemProxy()
    const cleared = await pp.getSystemProxy()
    if (cleared.enabled) throw new Error('clearSystemProxy 之后 ProxyEnable 仍为 1')
    log('系统代理已关闭（ProxyEnable=0），开始还原快照并比对注册表')

    const restoredOk = await cleanup()
    if (!restoredOk) return EXIT.RESTORE_FAILED

    // ── 7. 还原后再做一次出网确认：原来的路还能走 ─────────────────────────────
    const reverted = await curl(null, PROBE_URL)
    if (reverted.code !== 204) {
      log(`提示：还原后直连返回 ${reverted.code}（可能是瞬时网络问题，不影响注册表复原结论）`)
    } else {
      log('还原后直连仍为 204')
    }

    log('端到端链路全部通过')
    return EXIT.PASS
  } catch (error) {
    console.error('[e2e] 失败：', error instanceof Error ? error.message : error)
    return EXIT.FAIL
  } finally {
    clearTimeout(watchdog)
    await cleanup()
  }
}

const code = await main()
// 清理阶段的「还原不可信」压过链路结果：退出 3 比退出 0/1 更能提醒人去看注册表。
process.exitCode = restoreFailedEver ? EXIT.RESTORE_FAILED : code
