#!/usr/bin/env node
/**
 * drift-ladder.mjs —— 规模阶梯：**两千档不是极限**，往上找拐点/硬限
 *
 * ════════════════════════════════════════════════════════════════════
 * 为什么单独一个脚本
 * ════════════════════════════════════════════════════════════════════
 * longrun-drift.mjs 的播撒是"每条 remember 一次"——而 remember 每条都落一次
 * index.json（O(n)），于是**播撒本身是 O(n²)**：2 万条要 2 小时以上。
 * 但"把语料建到 N"不是被测量对象；**被测量的是"在 N 条规模下，一次真实写入/检索/冷启动多贵"**。
 * 所以拆两步：
 *   第 1 步 批量建语料：走真路径 `container.addEntryFile()`（写文件 + 改内存索引），
 *          只是**攒批落索引**（每 batch 次一次 saveIndex）→ 播撒从 O(n²) 降到 O(n²/batch)
 *   第 2 步 到规模后，**用真实单条 `writer.remember()` 测量**（这才是读数）
 *
 * ════════════════════════════════════════════════════════════════════
 * 每个阶梯测什么
 * ════════════════════════════════════════════════════════════════════
 *   · 真实写入 p50/p95/max（走 writer，单条）
 *   · 检索：稳定态（连续检索，缓存命中）vs **写后首检索**（缓存刚失效）
 *   · 冷启动：load(verify:true) 与 load(verify:false) 两档对照
 *   · index.json 体积、进程 RSS
 *   · **任何异常**：超时、OOM、ENOSPC、解析失败 —— 找硬限就是来找这个的
 *
 * 用法：
 *   bash scripts/with-container-copy.sh 'node scripts/drift-ladder.mjs --root "$CONTAINER_COPY" \
 *        --rungs 2000,5000,10000,20000 --batch 200 --out /tmp/drift-ladder'
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import { MemoryContainer } from '../lib/container.js'
import { MemoryWriter } from '../lib/writer.js'
import { searchLongterm } from '../lib/search.js'

const argv = process.argv.slice(2)
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d }
const ROOT = arg('root', '')
const RUNGS = String(arg('rungs', '5000,10000,20000')).split(',').map((x) => Number(x.trim())).filter(Boolean).sort((a, b) => a - b)
const BATCH = Number(arg('batch', 200))
const OUT = arg('out', '')
const WRITES_PER_RUNG = Number(arg('probe-writes', 20))
if (!ROOT) { console.error('用法：node scripts/drift-ladder.mjs --root <副本> --rungs 5000,10000,20000'); process.exit(2) }

const resolved = path.resolve(ROOT)
if (/00_记忆系统[\\/]dsh-memory-container$/.test(resolved)) {
  console.error(`❌ 拒绝在生产容器上跑：${resolved}`); process.exit(2)
}

const t = () => Number(process.hrtime.bigint() / 1000n) / 1000
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))] }
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 8)
const mb = (n) => (n / 1024 / 1024).toFixed(1)

console.log('════════ 规模阶梯（找拐点/硬限）════════')
console.log(`副本 ${resolved}`)
console.log(`阶梯 ${RUNGS.join(' → ')} ｜ 攒批 ${BATCH}\n`)

const container = new MemoryContainer(ROOT)
container.load()
const writer = new MemoryWriter(container)
let built = container.getIndex().entries.length
console.log(`起点 ${built} 条\n`)

const results = []

/** 批量建语料：真路径写文件 + 改内存索引，攒批落索引 */
function buildTo(target) {
  const t0 = t()
  let since = 0
  while (built < target) {
    const id = container.nextEntryId('longterm')
    container.addEntryFile({
      id,
      layer: 'longterm',
      frontmatter: {
        id, layer: 'longterm',
        title: `阶梯语料 ${built} · ${['架构', '性能', '安全', '流程'][built % 4]}`,
        summary: `阶梯第 ${built} 条`, tags: ['阶梯'],
        priority: 50, updated: '2026-10-08', status: 'active',
        memory_type: 'world', source_session: 'ladder', source_message: `ladder ${built}`,
      },
      content: `阶梯语料第 ${built} 条，标记 ${sha(`ladder-${built}`)}。`,
    })
    built++
    if (++since >= BATCH) { container.saveIndex(); since = 0 }
  }
  if (since > 0) container.saveIndex()
  return t() - t0
}

for (const target of RUNGS) {
  const row = { target, errors: [] }
  try {
    row.builtIn = buildTo(target)
    row.entries = container.getIndex().entries.length
    row.indexBytes = fs.statSync(path.join(ROOT, 'index.json')).size

    // ── 真实写入（单条，走 writer）──
    const w = []
    for (let i = 0; i < WRITES_PER_RUNG; i++) {
      const a = t()
      try {
        writer.remember({
          title: `阶梯真实写入 ${target}-${i}`, content: `规模阶梯探针 ${target}-${i}`,
          memory_type: 'world', source_session: 'ladder', source_message: `ladder-real ${i}`,
        })
      } catch (e) { row.errors.push(`write: ${String(e.message).slice(0, 60)}`) }
      w.push(t() - a)
    }
    row.writeP50 = pct(w, 0.5); row.writeP95 = pct(w, 0.95); row.writeMax = Math.max(...w)

    // ── 检索：稳定态 vs 写后首检索 ──
    const q = '阶梯语料 12 架构'
    for (let i = 0; i < 3; i++) searchLongterm(container, q, { topK: 5 })   // 预热
    const stable = []
    for (let i = 0; i < 8; i++) { const a = t(); searchLongterm(container, q, { topK: 5 }); stable.push(t() - a) }
    const afterWrite = []
    for (let i = 0; i < 4; i++) {
      writer.remember({ title: `写后检索探针 ${i}`, content: `afterWrite ${i}`, memory_type: 'world', source_session: 'ladder', source_message: `aw ${i}` })
      const a = t(); searchLongterm(container, q, { topK: 5 }); afterWrite.push(t() - a)
    }
    row.searchStableP50 = pct(stable, 0.5)
    row.searchAfterWriteP50 = pct(afterWrite, 0.5)

    // ── 冷启动：两档对照 ──
    const cFast = new MemoryContainer(ROOT)
    let a = t(); cFast.load({ verify: false }); row.loadFast = t() - a
    const cFull = new MemoryContainer(ROOT)
    a = t(); cFull.load(); row.loadVerify = t() - a
    row.projectionDrift = cFull.getProjectionDrift().length

    row.rssMB = Number(mb(process.memoryUsage().rss))
    row.ok = row.errors.length === 0
    console.log(
      `── ${String(target).padStart(6)} 条 ──  建语料 ${(row.builtIn / 1000).toFixed(1)}s ｜ index ${mb(row.indexBytes)}MB ｜ RSS ${row.rssMB}MB\n` +
      `     写入 p50 ${row.writeP50?.toFixed(0)}ms / p95 ${row.writeP95?.toFixed(0)}ms / max ${row.writeMax?.toFixed(0)}ms\n` +
      `     检索 稳定 ${row.searchStableP50?.toFixed(0)}ms ｜ 写后首检索 ${row.searchAfterWriteP50?.toFixed(0)}ms ｜ 倍数 ${(row.searchAfterWriteP50 / row.searchStableP50).toFixed(2)}×\n` +
      `     冷启动 verify:false ${row.loadFast?.toFixed(0)}ms ｜ verify:true ${row.loadVerify?.toFixed(0)}ms ｜ 投影不符 ${row.projectionDrift}${row.errors.length ? `\n     ⚠️ 异常 ${row.errors.length} 起：${row.errors.slice(0, 2).join('; ')}` : ''}`,
    )
  } catch (e) {
    row.fatal = String(e.stack ?? e.message).slice(0, 300)
    console.log(`── ${target} 条 ── ❌ 硬失败：${String(e.message).slice(0, 120)}`)
  }
  results.push(row)
}

// ── 拟合：从最低档起算斜率，看线性还成不成立 ──
if (results.filter((r) => r.writeP50).length >= 2) {
  const pts = results.filter((r) => r.writeP50)
  const a = pts[0]; const z = pts[pts.length - 1]
  const slope = (z.writeP50 - a.writeP50) / (z.entries - a.entries)
  console.log(`\n════════ 拟合 ════════`)
  console.log(`  写入 p50 斜率 ≈ ${slope.toFixed(4)} ms/条（${a.entries} → ${z.entries} 条）`)
  console.log(`  外推：20000 条 ≈ ${(a.writeP50 + slope * (20000 - a.entries)).toFixed(0)}ms ｜ 50000 条 ≈ ${(a.writeP50 + slope * (50000 - a.entries)).toFixed(0)}ms`)
  const last = pts[pts.length - 1]
  const prev = pts[pts.length - 2]
  if (prev) {
    const s2 = (last.writeP50 - prev.writeP50) / (last.entries - prev.entries)
    console.log(`  末段斜率 ${s2.toFixed(4)} ms/条 vs 首段 ${slope.toFixed(4)} —— ${s2 > slope * 1.3 ? '⚠️ 末段更陡，非线性抬头' : '仍在线性内'}`)
  }
}

if (OUT) { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, 'ladder.json'), JSON.stringify(results, null, 2)); console.log(`\n报告已落 ${OUT}/ladder.json`) }
