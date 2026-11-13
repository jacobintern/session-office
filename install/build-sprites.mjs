#!/usr/bin/env node
// Builds the page's character sprites from your own copy of Pipoya's free pack
// ("PIPOYA FREE RPG Character Sprites 32x32", https://pipoya.itch.io), whose
// license allows use and editing but not redistribution — so the files are made
// on your machine instead of shipping with this repository.
//
//   node install/build-sprites.mjs "<path to the .zip or its unzipped folder>" [out dir, default page/chars]
//
// Writes c00.png (you), k00.png (the Codex secretary) and four atlases, each a
// column of 96x128 sheets: p-female, p-school, p-enemy, p-soldier.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const [src, outArg] = process.argv.slice(2)
if (!src) { console.error('usage: build-sprites.mjs <pack .zip or folder> [out dir]'); process.exit(1) }
const out = resolve(outArg ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'page', 'chars'))

let root = src
if (src.endsWith('.zip')) { root = mkdtempSync(join(tmpdir(), 'pipoya-')); execFileSync('unzip', ['-q', src, '-d', root]) }
const find = (dir, name) => { for (const e of readdirSync(dir)) { const p = join(dir, e); if (e === name) return p; if (statSync(p).isDirectory()) { const f = find(p, name); if (f) return f } } return null }
const pack = find(root, 'Female') && dirname(find(root, 'Female'))
if (!pack) { console.error(`no Female folder under ${src}; is this the 32x32 pack?`); process.exit(1) }

// ---- PNG in (8-bit RGBA, or 4/8-bit palette), PNG out (RGBA) -----------------
function decode(file) {
  const buf = readFileSync(file)
  let w, h, depth, type, plte, trns, idat = []
  for (let o = 8; o < buf.length;) {
    const len = buf.readUInt32BE(o), kind = buf.toString('latin1', o + 4, o + 8), data = buf.subarray(o + 8, o + 8 + len)
    if (kind === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; type = data[9]; if (data[12]) throw new Error(`${file}: interlaced`) }
    else if (kind === 'PLTE') plte = data
    else if (kind === 'tRNS') trns = data
    else if (kind === 'IDAT') idat.push(data)
    o += 12 + len
  }
  const bpp = type === 6 ? 4 : 1, stride = type === 6 ? w * 4 : Math.ceil(w * depth / 8)
  const raw = zlib.inflateSync(Buffer.concat(idat)), rows = Buffer.alloc(stride * h)
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? rows[y * stride + x - bpp] : 0, b = y ? rows[(y - 1) * stride + x] : 0, c = x >= bpp && y ? rows[(y - 1) * stride + x - bpp] : 0
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
      rows[y * stride + x] = (line[x] + [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f]) & 255
    }
  }
  if (type === 6 && depth === 8) return { w, h, px: rows }
  if (type !== 3) throw new Error(`${file}: unsupported PNG type ${type}/${depth}`)
  const px = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = depth === 8 ? rows[y * stride + x] : (rows[y * stride + (x >> 1)] >> (x & 1 ? 0 : 4)) & 15
    px.set([plte[i * 3], plte[i * 3 + 1], plte[i * 3 + 2], trns && i < trns.length ? trns[i] : 255], (y * w + x) * 4)
  }
  return { w, h, px }
}
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc = b => { let c = ~0; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return ~c >>> 0 }
const chunk = (kind, data) => { const len = Buffer.alloc(4), body = Buffer.concat([Buffer.from(kind, 'latin1'), data]), sum = Buffer.alloc(4); len.writeUInt32BE(data.length); sum.writeUInt32BE(crc(body)); return Buffer.concat([len, body, sum]) }
function encode({ w, h, px }) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 6, 0, 0, 0], 8)
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) px.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4)
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

// ---- the pools -----------------------------------------------------------------
const pngs = dir => readdirSync(dir).filter(f => f.endsWith('.png')).sort().map(f => join(dir, f))
const sheet = f => { const im = decode(f); if (im.w !== 96 || im.h !== 128) throw new Error(`${f}: ${im.w}x${im.h}, expected 96x128`); return im }
function atlas(files) {
  const px = Buffer.alloc(96 * 128 * 4 * files.length)
  files.forEach((f, k) => sheet(f).px.copy(px, k * 96 * 128 * 4))
  return { w: 96, h: 128 * files.length, px }
}
// Enemy 15 (six sheets) is left out of the pool.
const ENEMY_SKIP = ['Enemy 15-1.png', 'Enemy 15-2.png', 'Enemy 15-3.png', 'Enemy 15-4.png', 'Enemy 15-5.png', 'Enemy 15-6.png']
const school = join(pack, 'Japanese school characters')
const POOLS = {
  'p-female': pngs(join(pack, 'Female')),
  'p-school': readdirSync(school).sort().flatMap(d => statSync(join(school, d)).isDirectory() ? pngs(join(school, d)) : []),
  'p-enemy': pngs(join(pack, 'Enemy')).filter(f => !ENEMY_SKIP.some(s => f.endsWith(s))),
  'p-soldier': pngs(join(pack, 'Soldier')),
}
mkdirSync(out, { recursive: true })
for (const [name, files] of Object.entries(POOLS)) { writeFileSync(join(out, `${name}.png`), encode(atlas(files))); console.log(`${name}.png  ${files.length} sheets`) }
writeFileSync(join(out, 'c00.png'), encode(sheet(join(pack, 'Xmas', 'pipo-xmaschara01.png')))); console.log('c00.png  you')
writeFileSync(join(out, 'k00.png'), encode(sheet(join(pack, 'Xmas', 'pipo-xmaschara04.png')))); console.log('k00.png  Codex secretary')
