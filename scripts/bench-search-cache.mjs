#!/usr/bin/env node
/**
 * bench-search-cache.mjs —— 检索语料缓存的换挡对照台（2026-10-08）
 *
 * 测三档，同一规模下：
 *   ① 稳定态检索（缓存命中，连续检索）
 *   ② 写后首检索（语料缓存刚失效 —— 这是要治的那个）
 *   ③ 写读交错（每写一次读三次，模拟真实长任务）
 *
 * 用法：node scripts/bench-search-cache.mjs --root <副本> [--scale 2000] [--rounds 6]
 * 纪律：拒绝在生产容器上跑（同 longrun-drift.mjs）
 */
import fs from 'node:fs'
import path from 'node:path'
import { MemoryContainer } from '../lib/container.js'
import { MemoryWriter } from '../lib/writer.js'
import { searchLongterm } from '../lib/search.js'

const argv = process.argv.slice(2)
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d }
const ROOT = arg('root', '')
const SCALE = Number(arg('scale', 2000))
const ROUNDS = Number(arg('rounds', 6))
const OUT = arg('out', '')
if (!ROOT) { console.error('用法：node scripts/bench-search-cache.mjs --root <副本> [--scale N]'); process.exit(2) }
const resolved = path.resolve(ROOT)
if (/00_记忆系统[\\/]dsh-memory-container$/.test(resolved)) { console.error(`❌ 拒绝在生产容器上跑：${resolved}`); process.exit(2) }

const t = () => Number(process.hrtime.bigint() / 1000n) / 1000
const p50 = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] }
const p90 = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * 0.9))] }

const container = new MemoryContainer(ROOT)
container.load()
const writer = new MemoryWriter(container)

// 建语料（攒批：addEntryFile + 每 200 条落一次索引）
let n = container.getIndex().entries.length
const start = n
while (n < SCALE) {
  const id = container.nextEntryId('longterm')
  container.addEntryFile({
    id, layer: 'longterm',
    frontmatter: { id, layer: 'longterm', title: `基线语料 ${n} · 架构`, summary: `基线 ${n}`, tags: ['基线'], priority: 50, updated: '2026-10-08', status: 'active', memory_type: 'world', source_session: 'bench', source_message: `b${n}` },
    content: `基线语料第 ${n} 条。`,
  })
  n++
  if ((n - start) % 200 === 0) container.saveIndex()
}
container.saveIndex()
console.log(`容器 ${resolved}`)
console.log(`语料 ${container.getIndex().entries.length} 条（从 ${start} 建起）\n`)

const Q = '基线语料 12 架构'
const stable = []
for (let i = 0; i < 3; i++) searchLongterm(container, Q, { topK: 5 })   // 预热
for (let i = 0; i < 8; i++) { const a = t(); searchLongterm(container, Q, { topK: 5 }); stable.push(t() - a) }

const afterWrite = []
for (let i = 0; i < ROUNDS; i++) {
  writer.remember({ title: `写后探针 ${i}`, content: `probe ${i}`, memory_type: 'world', source_session: 'bench', source_message: `w${i}` })
  const a = t(); searchLongterm(container, Q, { topK: 5 }); afterWrite.push(t() - a)
}

const interleaved = []
for (let i = 0; i < ROUNDS; i++) {
  writer.remember({ title: `交错写 ${i}`, content: `mix ${i}`, memory_type: 'world', source_session: 'bench', source_message: `m${i}` })
  for (let k = 0; k < 3; k++) { const a = t(); searchLongterm(container, Q, { topK: 5 }); interleaved.push(t() - a) }
}

const r = {
  scale: container.getIndex().entries.length,
  stable: { p50: p50(stable), p90: p90(stable), n: stable.length },
  afterWrite: { p50: p50(afterWrite), p90: p90(afterWrite), n: afterWrite.length },
  interleaved: { p50: p50(interleaved), p90: p90(interleaved), n: interleaved.length },
  gear: typeof container.getCorpusGear === 'function' ? container.getCorpusGear() : null,
}
console.log(`稳定态检索        p50 ${r.stable.p50.toFixed(1)}ms  p90 ${r.stable.p90.toFixed(1)}ms  (n=${r.stable.n})`)
console.log(`写后首检索        p50 ${r.afterWrite.p50.toFixed(1)}ms  p90 ${r.afterWrite.p90.toFixed(1)}ms  (n=${r.afterWrite.n})`)
console.log(`写读交错          p50 ${r.interleaved.p50.toFixed(1)}ms  p90 ${r.interleaved.p90.toFixed(1)}ms  (n=${r.interleaved.n})`)
console.log(`写后/稳定 = ${(r.afterWrite.p50 / r.stable.p50).toFixed(2)}×`)
// ⭐ 换挡计数器：证伪/证实"增量档到底跑没跑"的唯一判据
// 换挡计数只在带换挡的构建里有（2026-10-08 那次改动因零收益已撤回）—— 没有就跳过
if (typeof container.getCorpusGear === 'function') {
  const gear = container.getCorpusGear()
  console.log(`换挡计数：增量档 ${gear.incremental} 次 ｜ 重建档 ${gear.rebuild} 次`)
}
if (OUT) { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, `bench-cache-${r.scale}.json`), JSON.stringify(r, null, 2)); console.log(`\n落盘 ${OUT}/bench-cache-${r.scale}.json`) }
