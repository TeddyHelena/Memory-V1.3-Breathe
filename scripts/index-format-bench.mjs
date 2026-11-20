#!/usr/bin/env node
/**
 * index-format-bench.mjs —— 索引落盘格式的**判定实验**（Ledger · L-5）
 *
 * ════════════════════════════════════════════════════════════════════
 * 要回答的问题
 * ════════════════════════════════════════════════════════════════════
 * `saveIndex()` 每次全量 `JSON.stringify` + 落盘。S2 之后它是写入成本里**最大的一项**
 * （@2000 ≈5.0ms、@5000 ≈11.7ms，占写入 **36–38%**；判定实验当时的 2.8% 是判重还没修时的旧结构）。
 * ⇒ 三条路，**先量后选**：
 *   (a) **追加式日志 + 定期压缩**：每次只追一条变更记录；到阈值压缩成全量快照
 *   (b) **索引分片**：把 entries 切成 S 片，只重写动过的那片
 *   (c) **只写变化（dirty）**：维护脏集合，落盘时只落变更 + 一个基线快照 id
 *
 * ════════════════════════════════════════════════════════════════════
 * 量什么（两栏都要，缺一不可）
 * ════════════════════════════════════════════════════════════════════
 *   ① **写一次**：单次变更后落盘要多久（这是 L-5 要压的）
 *   ② **启动读一次**：把索引读回内存要多久（⛔ 不许把写侧的成本挪给启动侧就宣布赢了）
 * 还要报 **字节量**：写出去多少字节决定了长期 I/O 与 SSD 寿命，不能只看毫秒。
 *
 * ════════════════════════════════════════════════════════════════════
 * 诚实的边界（写进结论里）
 * ════════════════════════════════════════════════════════════════════
 *   · 这是**纯 I/O 微基准**：用合成 entry 记录，不碰真容器、不碰真 index.json。
 *     它量的是"格式本身的代价"，不是"接进插件后的端到端读数"——后者要等实现完再跑归因台子。
 *   · 各方案都按"最省事但正确"的写法实现，⛔ 不刻意把某一方案写丑。
 *
 * 用法：node scripts/index-format-bench.mjs --rungs 2000,5000 --shards 8
 * 退出码：0 = 跑完；2 = 参数错
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const argv = process.argv.slice(2)
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d }
const RUNGS = String(arg('rungs', '2000,5000')).split(',').map((x) => Number(x.trim())).filter(Boolean)
const SHARDS = Number(arg('shards', 8))
const ROUNDS = Number(arg('rounds', 12))

const t = () => Number(process.hrtime.bigint() / 1000n) / 1000
const p50 = (a) => { const s = [...a].sort((x, y) => x - y); return Number(s[Math.floor((s.length - 1) / 2)].toFixed(3)) }
const kb = (n) => Number((n / 1024).toFixed(1))

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idxfmt-'))

/** 造一条像真的 entry 记录（字段集与真 index.json 的投影一致量级） */
const mkEntry = (i, layer = 'longterm') => ({
  id: `l${i}`, layer, title: `第 ${i} 条记忆的标题（示例长度）`, file: `${layer}/l${i}.md`,
  tags: ['标签甲', '标签乙'], priority: 50, updated: '2026-10-08', summary: `第 ${i} 条的摘要，长度与真实条目同量级。`,
  scope: 'global', status: 'active', decay_type: 'recent', last_accessed: '2026-10-08T00:00:00.000Z',
  access_count: 3, lifecycle: 'active', source: 'memory 2.0 写入（remember）', checksum: 'v3:8f4be9be79a801479e3bbdbafed44831',
})

const writeFile = (p, s) => fs.writeFileSync(p, s, 'utf-8')

const results = []
console.log('════════ 索引落盘格式 · 判定实验（L-5）════════')
console.log(`合成记录 ｜ 阶梯 ${RUNGS.join(' → ')} ｜ 分片数 ${SHARDS} ｜ 每档 ${ROUNDS} 次变更\n`)

for (const N of RUNGS) {
  const dir = path.join(tmp, `n${N}`)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const entries = Array.from({ length: N }, (_, i) => mkEntry(i + 1))
  const row = { N, strategies: {} }

  // ── 基线：现状（全量快照）────────────────────────────────────────
  {
    const p = path.join(dir, 'index.json')
    const writes = [], reads = [], bytes = []
    let text = JSON.stringify({ schema: 'x', entry_count: entries.length, entries }, null, 2) + '\n'
    writeFile(p, text)
    // 启动读
    for (let i = 0; i < 3; i++) { const s = t(); JSON.parse(fs.readFileSync(p, 'utf-8')); reads.push(t() - s) }
    for (let r = 0; r < ROUNDS; r++) {
      entries[0].access_count += 1                 // 一次真实变更
      const s = t()
      text = JSON.stringify({ schema: 'x', entry_count: entries.length, entries }, null, 2) + '\n'
      writeFile(p, text)
      writes.push(t() - s)
      bytes.push(Buffer.byteLength(text))
    }
    row.strategies.full = { writeP50: p50(writes), readP50: p50(reads), writeBytes: bytes[bytes.length - 1] }
  }

  // ── (a)/(c) 追加式：变更写进日志，到阈值压缩 ──────────────────────
  {
    const p = path.join(dir, 'index.json')          // 压缩后的基线快照
    const log = path.join(dir, 'index.delta.jsonl') // 追加日志
    const writes = [], reads = [], bytes = []
    let base = { schema: 'x', entry_count: entries.length, entries: Array.from({ length: N }, (_, i) => mkEntry(i + 1)) }
    writeFile(p, JSON.stringify(base, null, 2) + '\n')
    writeFile(log, '')
    for (let r = 0; r < ROUNDS; r++) {
      const changed = { ...mkEntry(1), access_count: 10 + r }
      const s = t()
      fs.appendFileSync(log, JSON.stringify({ op: 'set', id: changed.id, entry: changed }) + '\n', 'utf-8')
      writes.push(t() - s)
      bytes.push(Buffer.byteLength(JSON.stringify(changed)) + 24)
    }
    // 启动读 = 基线快照 + 重放日志
    for (let i = 0; i < 3; i++) {
      const s = t()
      const b = JSON.parse(fs.readFileSync(p, 'utf-8'))
      const byId = new Map(b.entries.map((e) => [e.id, e]))
      for (const line of fs.readFileSync(log, 'utf-8').split('\n')) {
        if (!line) continue
        const rec = JSON.parse(line)
        if (rec.op === 'set') byId.set(rec.id, rec.entry)
      }
      reads.push(t() - s)
    }
    row.strategies.append = { writeP50: p50(writes), readP50: p50(reads), writeBytes: bytes[bytes.length - 1] }
  }

  // ── (b) 分片：只重写动过的那一片 ─────────────────────────────────
  {
    const shardDir = path.join(dir, 'index-shards')
    fs.mkdirSync(shardDir, { recursive: true })
    const shardOf = (id) => Number(String(id).replace(/\D/g, '')) % SHARDS
    const paths = Array.from({ length: SHARDS }, (_, s) => path.join(shardDir, `shard-${s}.json`))
    for (let s = 0; s < SHARDS; s++) {
      const part = entries.filter((e) => shardOf(e.id) === s)
      writeFile(paths[s], JSON.stringify({ shard: s, entries: part }, null, 2) + '\n')
    }
    const writes = [], reads = [], bytes = []
    for (let r = 0; r < ROUNDS; r++) {
      const changed = { ...mkEntry(1), access_count: 20 + r }
      const s = t()
      const idx = shardOf(changed.id)
      const part = JSON.parse(fs.readFileSync(paths[idx], 'utf-8'))
      part.entries = part.entries.map((e) => (e.id === changed.id ? changed : e))
      const text = JSON.stringify(part, null, 2) + '\n'
      writeFile(paths[idx], text)
      writes.push(t() - s)
      bytes.push(Buffer.byteLength(text))
    }
    for (let i = 0; i < 3; i++) {
      const s = t()
      const all = []
      for (const p of paths) all.push(...JSON.parse(fs.readFileSync(p, 'utf-8')).entries)
      reads.push(t() - s)
    }
    row.strategies.shards = { writeP50: p50(writes), readP50: p50(reads), writeBytes: bytes[bytes.length - 1] }
  }

  results.push(row)
  const f = row.strategies
  console.log(`── ${N} 条 ─────────────────────────────────────────────`)
  console.log(`   方案          写一次 p50      启动读 p50      单次写出字节`)
  for (const [name, label] of [['full', '全量快照(现状)'], ['append', '追加式+压缩'], ['shards', `${SHARDS} 片分片    `]]) {
    const x = f[name]
    console.log(`   ${label}  ${String(x.writeP50).padStart(8)}ms  ${String(x.readP50).padStart(9)}ms  ${String(kb(x.writeBytes)).padStart(9)}KB`)
  }
  console.log('')
}

// ── 结论区（只给数，判词留给人）───────────────────────────────────
console.log('──── 斜率（2000 → 5000，写一次）────')
const [a, b] = [results[0], results[results.length - 1]]
for (const name of ['full', 'append', 'shards']) {
  const slope = (b.strategies[name].writeP50 - a.strategies[name].writeP50) / (b.N - a.N)
  console.log(`   ${name.padEnd(7)} ${slope.toFixed(6)} ms/条`)
}
fs.rmSync(tmp, { recursive: true, force: true })
