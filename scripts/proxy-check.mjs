// 真实系统代理往返验证：读 → 设为 127.0.0.1:5566 → 回读 → 还原 → 回读比对。
// 运行：npx tsx scripts/proxy-check.mjs
// 任何失败都必须先在 finally 中还原，绝不能把机器留在 127.0.0.1:5566。

import { execFileSync } from 'node:child_process'

const { loadWindowsProxy } = await import('../src/main/proxy/win32.ts')
const pp = loadWindowsProxy()

const RAW_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
const dumpRaw = () => execFileSync('reg.exe', ['query', RAW_KEY], { encoding: 'utf8' })

function sameState(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** 行级差异，用于确认还原后原始注册表 dump 没有非预期变化。 */
function lineDiff(a, b) {
  const left = new Set(a.split(/\r?\n/).filter(Boolean))
  const right = new Set(b.split(/\r?\n/).filter(Boolean))
  return [
    ...[...left].filter(line => !right.has(line)),
    ...[...right].filter(line => !left.has(line))
  ]
}

const before = await pp.getSystemProxy()
const rawBefore = dumpRaw()
console.log('before', before)

let failure

try {
  await pp.setSystemProxy({ server: '127.0.0.1:5566', bypass: ['localhost', '127.0.0.0/8'] })
  const during = await pp.getSystemProxy()
  console.log('during', during)

  if (!during.enabled) throw new Error('设置未生效：ProxyEnable 不是 1')
  if (during.server !== '127.0.0.1:5566') throw new Error(`设置未生效：ProxyServer 是 ${during.server}`)
  if (during.autoConfigUrl !== undefined) throw new Error(`PAC 未被清除：${during.autoConfigUrl}`)
  if (during.autoDetect !== false) throw new Error(`AutoDetect 未被关闭：${during.autoDetect}`)
  if (JSON.stringify(during.bypass) !== JSON.stringify(['localhost', '127.0.0.0/8'])) {
    throw new Error(`ProxyOverride 不符：${JSON.stringify(during.bypass)}`)
  }
} catch (err) {
  failure = err
} finally {
  // finally 内再抛错会盖掉原始错误，但还原失败比原始错误更严重，必须暴露。
  await pp.restore(before)
  const after = await pp.getSystemProxy()
  const rawAfter = dumpRaw()
  console.log('after', after)
  console.log('rawBefore:\n' + rawBefore.trimEnd())
  console.log('rawAfter:\n' + rawAfter.trimEnd())

  if (!sameState(after, before)) {
    throw new Error(`还原失败：before=${JSON.stringify(before)} after=${JSON.stringify(after)}`)
  }

  const rawDiff = lineDiff(rawBefore, rawAfter)
  if (rawDiff.length) {
    console.log('raw diff:', rawDiff)
    // 已知平台行为：广播后 Windows 会删除显式的 AutoDetect=0。只允许这一种差异。
    if (!rawDiff.every(line => line.includes('AutoDetect'))) {
      throw new Error(`还原后原始注册表 dump 存在非 AutoDetect 差异：${JSON.stringify(rawDiff)}`)
    }
  }
}

if (failure) throw failure

console.log('proxy-check ok')
