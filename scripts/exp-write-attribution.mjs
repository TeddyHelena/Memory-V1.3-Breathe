#!/usr/bin/env node
/**
 * exp-write-attribution.mjs —— 写入成本归因实验（S2 · 判定实验）
 *
 * ════════════════════════════════════════════════════════════════════
 * 要回答的唯一问题
 * ════════════════════════════════════════════════════════════════════
 * 写入 p50 随语料线性增长（@2000 75.99ms / @2481 93.4–94.8ms），斜率 0.035–0.04 ms/条。
 * **两个候选根因，谁是主项？**
 *   甲 **判重读全语料**：写文件触发 `invalidateCache` → 语料缓存整片作废
 *      → 下一次判重要把 n 个文件全读回来重解析（`writer.collectDupCandidates` → `container.corpus`）
 *   乙 **全量 dump 索引**：`container.saveIndex` 每次全量序列化 + 落盘整个 index.json
 *
 * ════════════════════════════════════════════════════════════════════
 * 台子 v2 —— v1 的两个缺陷（留痕，防再犯）
 * ════════════════════════════════════════════════════════════════════
 *  ① **累计计数器当逐次读数用**：v1 在每次写入后 push 的是"累计耗时"，再取 p50——
 *     于是出现"判重 56.85ms ＞ 总 14.25ms"这种不可能的数。v2 改为**逐次取差**。
 *  ② **stub saveIndex 会把容器拆散**：不落索引但落文件 → 内存索引与磁盘分叉，
 *     下一次 buildTo 撞 `条目文件已存在，拒绝覆盖`，后面三个阶梯全空。
 *     v2 的修法：**归因不靠 stub**——base 模式下逐次量相位（t_dedup / t_save 取差）
 *     本身就是精确归因；`noDedup` 只作旁证，且**跑在语料副本上**，弄脏也不影响主副本。
 *
 * ════════════════════════════════════════════════════════════════════
 * 每个阶梯做三件事
 * ════════════════════════════════════════════════════════════════════
 *   1. 主测：base 模式 N 次真实 `writer.remember()`，逐次取差 → 总 / 判重 / 落索引 / 其余
 *   2. 微探针：`saveIndex()` 单次成本 ｜ `invalidateCache + corpus()` 单次全语料重读成本
 *   3. 旁证：把语料复制一份 → 在副本上把 `findDuplicateFor` 置空 → 同样 N 次写入（下界）
 *
 * ⚠️ 读数边界（写进报告，不许省）：
 *   · 相位计时是运行期挂 wrapper，不是编译进去的——**相对关系**可信，绝对值只与同台基线比。
 *   · 单进程、单线程、无并发；未测锁竞争（S3 面）。
 *   · `noDedup` 旁证会让"重复内容被吸收"这条路径消失——只用来看下界，不与 base 逐条对齐。
 *
 * 用法（**必须跑在副本上**）：
 *   MEMORY_CONTAINER_ROOT="<生产容器>" bash scripts/with-container-copy.sh \
 *     'node scripts/exp-write-attribution.mjs --root "$CONTAINER_COPY" \
 *        --rungs 200,1000,2000,5000 --writes 10 --rounds 2 --out /tmp/s2-attrib'
 */

import fs from 'node:fs'
import path from 'node:path'

import { MemoryContainer } from '../lib/container.js'
import { MemoryWriter } from '../lib/writer.js'

const argv = process.argv.slice(2)
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d }
const ROOT = path.resolve(arg('root', ''))
const RUNGS = String(arg('rungs', '200,1000,2000,5000')).split(',').map((x) => Number(x.trim())).filter(Boolean).sort((a, b) => a - b)
const WRITES = Number(arg('writes', 10))
const ROUNDS = Number(arg('rounds', 2))
const BATCH = Number(arg('batch', 200))
const OUT = arg('out', '')
/**
 * 语料正文长度（字符）。默认 60 偏短，**只作灵敏度对照**；
 * 真实容器实测 102 条：正文 p50 805 ／ p90 3,315 ／ 均值 1,324 ⇒ 正式读数用 `--content-chars 1300`。
 * 为什么必须调：判重的成本随**字节量**走（读回 + 逐条 sha256），拿 60 字符的语料报绝对值会低估。
 */
const CONTENT_CHARS = Number(arg('content-chars', 60))

if (!arg('root', '')) { console.error('用法：node scripts/exp-write-attribution.mjs --root <副本> [--rungs ...]'); process.exit(2) }
if (/00_记忆系统[\\/]dsh-memory-container$/.test(ROOT)) { console.error(`❌ 拒绝在生产容器上跑：${ROOT}`); process.exit(2) }

const t = () => Number(process.hrtime.bigint() / 1000n) / 1000
const p50 = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return Number(s[Math.floor((s.length - 1) * 0.5)].toFixed(2)) }
const mean = (a) => (a.length ? Number((a.reduce((x, y) => x + y, 0) / a.length).toFixed(2)) : null)
const kb = (n) => (n / 1024).toFixed(0)

const container = new MemoryContainer(ROOT)
container.load()
const writer = new MemoryWriter(container)
let built = container.getIndex().entries.length

const origDup = writer.findDuplicateFor.bind(writer)
const origSave = container.saveIndex.bind(container)

let tDup = 0, tSave = 0
const installTiming = () => {
  tDup = 0; tSave = 0
  container.saveIndex = function () { const s = t(); origSave(); tSave += t() - s }
  writer.findDuplicateFor = function (r) { const s = t(); const v = origDup(r); tDup += t() - s; return v }
}
const restore = () => { container.saveIndex = origSave; writer.findDuplicateFor = origDup }

console.log('════════ 写入成本归因（S2 判定实验 · 台子 v2）════════')
console.log(`副本 ${ROOT}`)
console.log(`起点 ${built} 条 ｜ 阶梯 ${RUNGS.join(' → ')} ｜ 每模式 ${WRITES} 写 × ${ROUNDS} 轮\n`)

/** 批量建语料：真路径写文件 + 改内存索引，攒批落索引（照 drift-ladder） */
function buildTo(target) {
  let since = 0
  while (built < target) {
    const id = container.nextEntryId('longterm')
    container.addEntryFile({
      id,
      layer: 'longterm',
      frontmatter: {
        id, layer: 'longterm',
        title: `归因语料 ${built} · 第${built % 7}类`,
        summary: `归因第 ${built} 条`, tags: ['归因'],
        priority: 50, updated: '2026-10-08', status: 'active',
        memory_type: 'world', source_session: 'attrib', source_message: `attrib ${built}`,
      },
      content: `归因语料第 ${built} 条，序号 ${built}。` + '阶梯语料正文补足长度，用于逼近真实条目的字节量。'.repeat(Math.max(1, Math.round(CONTENT_CHARS / 26))).slice(0, CONTENT_CHARS),
    })
    built += 1
    if (++since >= BATCH) { container.saveIndex(); since = 0 }
  }
  if (since > 0) container.saveIndex()
}

/** 旁证：在语料副本上把判重置空，量下界 */
function measureNoDedup(srcRoot, rung) {
  const tmp = `${srcRoot}-nodedup`
  let c = null
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
    fs.cpSync(srcRoot, tmp, { recursive: true })
    c = new MemoryContainer(tmp)
    c.load()
    const w = new MemoryWriter(c)
    w.findDuplicateFor = function () { return null }   // 这个副本弄脏没关系，用完就删
    const totals = []
    for (let i = 0; i < WRITES; i++) {
      const nonce = `nd-${rung}-${i}-${Math.random().toString(36).slice(2, 8)}`
      const s = t()
      try {
        w.remember({ title: `下界写入 ${nonce}`, content: `下界探针 ${nonce} 唯一内容。`, memory_type: 'world', source_session: 'attrib', source_message: nonce })
      } catch { /* 下界只取读数，报错单独计 */ }
      totals.push(t() - s)
    }
    return { total: p50(totals), meanTotal: mean(totals) }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

const results = []
for (const target of RUNGS) {
  const row = { target, entries: 0, indexBytes: 0, base: {}, micro: {}, noDedup: {}, errors: [] }
  try {
    buildTo(target)
    row.entries = container.getIndex().entries.length
    row.indexBytes = fs.statSync(path.join(ROOT, 'index.json')).size

    // ── 微探针 ①：单次 saveIndex（序列化 + 落盘）──────────────
    const saveMs = []
    for (let i = 0; i < 3; i++) { const s = t(); origSave(); saveMs.push(t() - s) }

    // ── 微探针 ②：单次语料重建（缓存作废后全量重读）────────────
    const corpusMs = []
    for (let i = 0; i < 3; i++) {
      const anyId = container.getIndex().entries[0]?.id
      if (anyId) container.invalidateCache(anyId)
      const s = t(); container.corpus(); corpusMs.push(t() - s)
    }
    row.micro = { saveIndexDirect: p50(saveMs), corpusRebuild: p50(corpusMs) }

    // ── 主测：base 模式，逐次取差 ─────────────────────────────
    const totals = [], dups = [], saves = [], rests = []
    for (let round = 0; round < ROUNDS; round++) {
      installTiming()
      for (let i = 0; i < WRITES; i++) {
        const nonce = `${target}-base-${round}-${i}-${Math.random().toString(36).slice(2, 8)}`
        const d0 = tDup, s0 = tSave
        const s = t()
        try {
          writer.remember({ title: `归因写入 ${nonce}`, content: `归因探针 ${nonce} 唯一内容，防判重吸收。`, memory_type: 'world', source_session: 'attrib', source_message: nonce })
        } catch (e) { row.errors.push(`base: ${String(e?.message ?? e).slice(0, 70)}`) }
        const total = t() - s
        const dd = tDup - d0, ds = tSave - s0
        totals.push(total); dups.push(dd); saves.push(ds); rests.push(total - dd - ds)
      }
      restore()
    }
    row.base = { total: p50(totals), dedup: p50(dups), saveIndex: p50(saves), rest: p50(rests), meanTotal: mean(totals) }

    // ── 旁证：noDedup 下界（跑在语料副本上）────────────────────
    row.noDedup = measureNoDedup(ROOT, target)
  } catch (e) {
    row.errors.push(String(e?.message ?? e))
  }
  results.push(row)

  const b = row.base, m = row.micro, nd = row.noDedup
  console.log(`── ${target} 条（index.json ${kb(row.indexBytes)}KB）`)
  console.log(`   微探针：saveIndex 单次 ${m.saveIndexDirect}ms ｜ 语料重建单次 ${m.corpusRebuild}ms`)
  console.log(`   base   总 p50 ${b.total}ms ＝ 判重 ${b.dedup} ＋ 落索引 ${b.saveIndex} ＋ 其余 ${b.rest}`)
  console.log(`   旁证   noDedup 总 p50 ${nd.total}ms（下界）｜ 未被判重吸收的写入数应 = ${WRITES * 1}`)
  if (row.errors.length) console.log(`   ⚠️ errors ${row.errors.length}：${row.errors[0]}`)
  console.log('')
}

restore()

if (OUT) {
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, 'write-attribution.json'), JSON.stringify({ at: new Date().toISOString(), root: ROOT, rungs: RUNGS, writes: WRITES, rounds: ROUNDS, results }, null, 2))
  console.log(`报告已落 ${OUT}/write-attribution.json`)
}
