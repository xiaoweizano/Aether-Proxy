#!/usr/bin/env node
/**
 * 从现有的托盘标记生成安装包图标 `build/icon.ico`。
 *
 * 来源（provenance）：`resources/tray.png`（16×16）与 `resources/tray@2x.png`（32×32），
 * 即仓库里已有的托盘标记（蓝底圆角方块 + 镂空「A」，见 resources/README.md）。
 * 本脚本**不做重新设计**：
 * - 16×16、32×32 两档直接使用原图像素（无损）；
 * - 48/64/128/256 由 32×32 原图按预乘 alpha 双线性放大（托盘标记本身没有更大的源图）。
 *
 * 为什么需要 ICO 而不是直接给 PNG：electron-builder 在 Windows 上用 rcedit 把图标写进
 * `Aether.exe` 与 NSIS 安装包，两者都只接受 .ico。ICO 内部各档用 PNG 压缩（Vista+ 支持），
 * 由本脚本手写容器，不引入图像库依赖。
 *
 * 用法：node scripts/make-app-icon.mjs [输出路径]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const SOURCE_2X = path.join(REPO_ROOT, 'resources', 'tray@2x.png')
const SOURCE_1X = path.join(REPO_ROOT, 'resources', 'tray.png')
const OUTPUT = process.argv[2] ?? path.join(REPO_ROOT, 'build', 'icon.ico')

const ICO_SIZES = [16, 32, 48, 64, 128, 256]

/** 读 PNG（仅支持本仓库图标使用的 8-bit RGBA、非隔行）。返回 RGBA 像素。 */
export function readPng(file) {
  const buf = readFileSync(file)
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idat = []
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset)
    const type = buf.toString('ascii', offset + 4, offset + 8)
    const data = buf.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      if (data[12] !== 0) throw new Error(`${file}: 不支持隔行 PNG`)
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  if (bitDepth !== 8 || colorType !== 6) {
    throw new Error(`${file}: 需要 8-bit RGBA（得到 bitDepth=${bitDepth}, colorType=${colorType}）`)
  }
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const bpp = 4
  const stride = width * bpp
  const out = Buffer.alloc(width * height * bpp)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let x = 0; x < stride; x += 1) {
      const left = x >= bpp ? out[y * stride + x - bpp] : 0
      const up = y > 0 ? out[(y - 1) * stride + x] : 0
      const upLeft = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0
      let value = line[x]
      if (filter === 1) value += left
      else if (filter === 2) value += up
      else if (filter === 3) value += (left + up) >> 1
      else if (filter === 4) {
        const p = left + up - upLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upLeft)
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
      }
      out[y * stride + x] = value & 0xff
    }
  }
  return { width, height, data: out }
}

/**
 * 预乘 alpha 的 Catmull-Rom 放大。
 *
 * 源图只有 32px，放大到 256 时双线性会把圆角边缘拉成一条明显的菱形折线；Catmull-Rom
 * 的负瓣补偿让圆角在放大后仍是一条平滑曲线、镂空的「A」保留尖锐内角。
 * 采样在预乘空间做（`rgb × a`），透明像素的颜色不会渗进边缘（不会出现黑边）。
 */
export function upscale(image, size) {
  const { width: sw, data } = image
  const out = Buffer.alloc(size * size * 4)
  const scale = sw / size

  const sample = (px, py) => {
    const cx = Math.min(sw - 1, Math.max(0, px))
    const cy = Math.min(sw - 1, Math.max(0, py))
    const i = (cy * sw + cx) * 4
    const a = data[i + 3] / 255
    return [data[i] * a, data[i + 1] * a, data[i + 2] * a, a]
  }

  // Catmull-Rom 的四个基函数（t ∈ [0,1)），参数是 -1..2 的样本序号偏移。
  const weights = (t) => {
    const t2 = t * t
    const t3 = t2 * t
    return [
      -0.5 * t3 + t2 - 0.5 * t,
      1.5 * t3 - 2.5 * t2 + 1,
      -1.5 * t3 + 2 * t2 + 0.5 * t,
      0.5 * t3 - 0.5 * t2
    ]
  }

  for (let y = 0; y < size; y += 1) {
    const sy = (y + 0.5) * scale - 0.5
    const y0 = Math.floor(sy)
    const wy = weights(sy - y0)
    for (let x = 0; x < size; x += 1) {
      const sx = (x + 0.5) * scale - 0.5
      const x0 = Math.floor(sx)
      const wx = weights(sx - x0)
      const acc = [0, 0, 0, 0]
      for (let j = 0; j < 4; j += 1) {
        for (let i = 0; i < 4; i += 1) {
          const w = wx[i] * wy[j]
          if (w === 0) continue
          const p = sample(x0 - 1 + i, y0 - 1 + j)
          acc[0] += p[0] * w
          acc[1] += p[1] * w
          acc[2] += p[2] * w
          acc[3] += p[3] * w
        }
      }
      const alpha = Math.min(1, Math.max(0, acc[3]))
      if (alpha <= 0) continue
      const o = (y * size + x) * 4
      // 负瓣可能把预乘值推出 [0, alpha]：夹住，避免溢出成刺眼的过亮边缘。
      const channel = (v) => Math.round(Math.min(255, Math.max(0, (v / alpha) * 255)))
      out[o] = channel(Math.min(alpha * 255, Math.max(0, acc[0])))
      out[o + 1] = channel(Math.min(alpha * 255, Math.max(0, acc[1])))
      out[o + 2] = channel(Math.min(alpha * 255, Math.max(0, acc[2])))
      out[o + 3] = Math.round(alpha * 255)
    }
  }
  return out
}

/**
 * RGBA → ICO 的传统 DIB 条目（Windows 对 <=128px 的图标最兼容的格式）。
 *
 * 结构：BITMAPINFOHEADER（高度写两倍：XOR 位图 + AND 掩码）→ 自下而上的 32bpp BGRA
 * → 1bpp AND 掩码（每行补齐到 4 字节）。32bpp 条目里 alpha 才是真正的透明度来源；
 * AND 掩码仍要写，因为部分旧 API 只看它。
 */
export function toDib(rgba, size) {
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8)
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  header.writeUInt32LE(0, 16)
  header.writeUInt32LE(size * size * 4, 20)
  const pixels = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    const src = (size - 1 - y) * size * 4
    for (let x = 0; x < size; x += 1) {
      const s = src + x * 4
      const d = (y * size + x) * 4
      pixels[d] = rgba[s + 2]
      pixels[d + 1] = rgba[s + 1]
      pixels[d + 2] = rgba[s]
      pixels[d + 3] = rgba[s + 3]
    }
  }
  const maskStride = Math.ceil(size / 32) * 4
  const mask = Buffer.alloc(maskStride * size)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      // AND 掩码位为 1 表示「透明」。
      if (rgba[((size - 1 - y) * size + x) * 4 + 3] === 0) {
        mask[y * maskStride + (x >> 3)] |= 0x80 >> (x & 7)
      }
    }
  }
  return Buffer.concat([header, pixels, mask])
}

/** 组装 ICO：<=128px 用 DIB，256px 用内嵌 PNG（Windows 惯例）。 */
export function buildIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)
  const dir = Buffer.alloc(16 * entries.length)
  let offset = 6 + dir.length
  entries.forEach((entry, index) => {
    const at = index * 16
    dir[at] = entry.size >= 256 ? 0 : entry.size
    dir[at + 1] = entry.size >= 256 ? 0 : entry.size
    dir[at + 2] = 0
    dir[at + 3] = 0
    dir.writeUInt16LE(1, at + 4)
    dir.writeUInt16LE(32, at + 6)
    dir.writeUInt32LE(entry.data.length, at + 8)
    dir.writeUInt32LE(offset, at + 12)
    offset += entry.data.length
  })
  return Buffer.concat([header, dir, ...entries.map((entry) => entry.data)])
}

export function makeIco() {
  const source2x = readPng(SOURCE_2X)
  const source1x = readPng(SOURCE_1X)
  return buildIco(
    ICO_SIZES.map((size) => {
      const rgba =
        size === 16
          ? source1x.data
          : size === 32
            ? source2x.data
            : upscale(source2x, size)
      return { size, data: toDib(rgba, size) }
    })
  )
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const ico = makeIco()
  mkdirSync(path.dirname(OUTPUT), { recursive: true })
  writeFileSync(OUTPUT, ico)
  console.log(`[icon] ${path.relative(REPO_ROOT, OUTPUT)}  ${ICO_SIZES.join('/')} px  ${ico.length} bytes`)
}
