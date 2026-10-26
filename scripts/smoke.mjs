import { mkdtemp, copyFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawn } from 'node:child_process'
import YAML from 'yaml'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const binary = path.join(repoRoot, 'vendor', 'mihomo.exe')
const fixture = path.join(repoRoot, 'test', 'fixtures', 'subscription.yaml')
const upstream = YAML.parse(await readFile(fixture, 'utf8'))

const profileDir = await mkdtemp(path.join(tmpdir(), 'aether-smoke-'))
await copyFile(fixture, path.join(profileDir, 'upstream.yaml'))

// 复用编译后的合并逻辑：用 tsx 直接导入 TS 源码
const { mergeConfig } = await import('../src/main/config/merge.ts')
const { writeRuntime } = await import('../src/main/config/runtime.ts')
const { ensureGeodata, verifyGeodata } = await import('../src/main/config/geodata.ts')
const { allocatePort } = await import('../src/main/core/ports.ts')
const { newSecret } = await import('../src/main/core/secret.ts')

await ensureGeodata(profileDir, path.join(repoRoot, 'vendor', 'geodata'))
const geodata = await verifyGeodata(profileDir, path.join(repoRoot, 'vendor', 'geodata'))
if (!geodata.ok) throw new Error(`geodata 未就绪：${geodata.missing.join(', ')}`)
console.log('geodata ok')

const mixedPort = await allocatePort()
const controllerPort = await allocatePort()
const secret = newSecret()
const merged = mergeConfig(upstream, {}, { mixedPort, controllerPort, secret })
if (merged.tun?.enable !== false) throw new Error('tun 未被强制关闭')
const runtimePath = await writeRuntime(profileDir, merged)
console.log('runtime', runtimePath, 'mixed', mixedPort, 'controller', controllerPort)

const test = execFileSync(binary, ['-t', '-d', profileDir, '-f', runtimePath], { encoding: 'utf8' })
console.log(test.trim())

const child = spawn(binary, ['-d', profileDir, '-f', runtimePath], {
  windowsHide: true,
  stdio: 'ignore'
})
console.log('core pid', child.pid)

try {
  const deadline = Date.now() + 10_000
  const startedAt = Date.now()
  let version = null
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${controllerPort}/version`, { headers: { authorization: `Bearer ${secret}` } })
      if (res.ok) { version = await res.json(); break }
    } catch {}
    await new Promise((r) => setTimeout(r, 200))
  }
  if (!version) throw new Error('内核握手失败')
  console.log('version', version, 'handshake-ms', Date.now() - startedAt)

  const out = execFileSync('curl', ['-s', '-x', `http://127.0.0.1:${mixedPort}`, 'http://www.gstatic.com/generate_204', '-o', 'NUL', '-w', '%{http_code}'])
  console.log('through-proxy status', out.toString())
} finally {
  await new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve()
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 3000)
    child.once('exit', () => { clearTimeout(timer); resolve() })
    child.kill('SIGTERM')
  })
  console.log('core exited', child.exitCode ?? child.signalCode)
}

console.log('smoke ok', profileDir)
