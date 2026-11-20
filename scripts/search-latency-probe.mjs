#!/usr/bin/env node
/**
 * search-latency-probe.mjs —— 检索延迟台子：稳定态 vs 写后首检
 *
 * 判据来源：`docs/Memory-S2-Scoped-施工单_20261008.md` §一（S2-D 检索缓存 / S2-E 写后首检 2×）
 * 怎么用（**必须跑在容器副本上**）：
 *   MEMORY_CONTAINER_ROOT="<生产容器>" bash scripts/with-container-copy.sh \
 *     'node scripts/search-latency-probe.mjs "$CONTAINER_COPY" 2000'
 * 读数含义：稳定态 = 连续检索（缓存命中）；写后首检 = 写一条之后的第一次检索。
 *   两条的**比值**是 S2-E 的判据（改前 2.0×，且基数 126ms；改后 1.9×，基数 3.6ms）。
 */
import path from 'node:path'
import { MemoryContainer } from '../lib/container.js'
import { MemoryWriter } from '../lib/writer.js'
import { searchLongterm } from '../lib/search.js'

const ROOT = path.resolve(process.argv[2] ?? '')
const N = Number(process.argv[3] ?? 2000)
if (!ROOT) { console.error('用法：node scripts/_probe-search.mjs <副本根> [条数]'); process.exit(2) }

const t = () => Number(process.hrtime.bigint() / 1000n) / 1000
const p50 = (a) => { const s = [...a].sort((x, y) => x - y); return Number(s[Math.floor((s.length - 1) / 2)].toFixed(1)) }

const container = new MemoryContainer(ROOT)
container.load()
const writer = new MemoryWriter(container)

let built = container.getIndex().entries.length
let since = 0
while (built < N) {
  const id = container.nextEntryId('longterm')
  container.addEntryFile({
    id, layer: 'longterm',
    frontmatter: {
      id, layer: 'longterm', title: `检索语料 ${built} · ${['架构', '性能', '安全', '流程'][built % 4]}`,
      summary: `检索 ${built}`, tags: ['probe'], priority: 50, updated: '2026-10-08', status: 'active',
      memory_type: 'world', source_session: 'probe', source_message: `s ${built}`,
    },
    content: `检索语料第 ${built} 条，主题 ${['架构', '性能', '安全', '流程'][built % 4]}。` + '正文补足长度。'.repeat(100),
  })
  built += 1
  if (++since >= 200) { container.saveIndex(); since = 0 }
}
if (since) container.saveIndex()
console.log(`语料 ${N} 条就绪\n`)

const Q = '性能 架构'
const OPT = { layerFilter: ['longterm'] }
const t0 = t(); searchLongterm(container, Q, OPT); console.log(`冷启首检（建语料） ${(t() - t0).toFixed(1)}ms`)

const stable = []
for (let i = 0; i < 8; i++) { const s = t(); searchLongterm(container, Q, OPT); stable.push(t() - s) }

const after = []
for (let i = 0; i < 5; i++) {
  const r = writer.remember({ title: `写后检索探针 ${i}`, content: `写后检索 ${i} ${Math.random()}。`, memory_type: 'world', source_session: 'probe', source_message: `aw ${i}` })
  if (!r.ok) console.log('  ⚠️ 写入未 ok')
  const s = t(); searchLongterm(container, Q, OPT); after.push(t() - s)
}

console.log(`稳定态 p50 ${p50(stable)}ms（${stable.map((x) => x.toFixed(0)).join('/')}）`)
console.log(`写后首检 p50 ${p50(after)}ms（${after.map((x) => x.toFixed(0)).join('/')}）`)
console.log(`倍数 ${(p50(after) / p50(stable)).toFixed(2)}×`)
