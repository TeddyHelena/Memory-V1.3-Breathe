/**
 * b-red-probe.mjs —— V1.3-B 先红证据（只读，跑副本）
 * R1 fresh 恒等于 pri ｜ R2 cold_start 不生效 ｜ R5 touch 每次装配都记
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const REPO = process.env.REPO
const { MemoryContainer } = await import(path.join(REPO, 'lib/container.js'))
const { scoreAll } = await import(path.join(REPO, 'lib/route/score.js'))
const { Router } = await import(path.join(REPO, 'lib/route/router.js'))
const { DEFAULT_ROUTE_CONFIG } = await import(path.join(REPO, 'lib/route/types.js'))

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'b-red-'))
fs.mkdirSync(path.join(root, 'longterm'), { recursive: true })
const fixed = '2026-09-01T00:00:00.000Z'
const mk = (id, decay, extra = '') => `---\nid: "${id}"\nlayer: "longterm"\ntitle: "样本 ${id}"\ntags: ["探针"]\npriority: 80\nupdated: "2026-09-01"\nsummary: "s"\nscope: "global"\ndecay_type: "${decay}"\nlast_accessed: "${fixed}"\naccess_count: 0\nlifecycle: "active"\n${extra}---\n\n正文 ${id}\n`
fs.writeFileSync(path.join(root, 'longterm', 'l01.md'), mk('l01', 'core'))
fs.writeFileSync(path.join(root, 'longterm', 'l02.md'), mk('l02', 'recent'))
fs.writeFileSync(path.join(root, 'longterm', 'l03.md'), mk('l03', 'process'))
// R2 用：窗口内 / 窗口外
fs.writeFileSync(path.join(root, 'longterm', 'l04.md'), mk('l04', 'recent', `cold_start_until: "2099-01-01T00:00:00.000Z"\n`))
fs.writeFileSync(path.join(root, 'longterm', 'l05.md'), mk('l05', 'recent', `cold_start_until: "2000-01-01T00:00:00.000Z"\n`))
const entries = ['l01','l02','l03','l04','l05'].map((id, i) => ({
  id, layer: 'longterm', title: `样本 ${id}`, file: `longterm/${id}.md`, tags: ['探针'],
  priority: 80, updated: '2026-09-01', summary: 's', scope: 'global',
  decay_type: ['core','recent','process','recent','recent'][i],
  last_accessed: fixed, access_count: 0, lifecycle: 'active',
  // ⚠️ 第一版我漏了这两个：cold_start_until 只写进文件、没进索引 ⇒ 两条都读到 undefined，
  //    R2 于是成了"两条完全一样的条目分数当然一样"——读数对不上就等于没量。
  cold_start_until: i === 3 ? '2099-01-01T00:00:00.000Z' : (i === 4 ? '2000-01-01T00:00:00.000Z' : undefined),
}))
fs.writeFileSync(path.join(root, 'index.json'), JSON.stringify({
  schema: 'harness-memory-container/v1', generated_at: '', source_root: root,
  entry_count: entries.length, entries, hot_order: [], archive_index: {}, longterm_tags: {},
}, null, 2) + '\n')

const c = new MemoryContainer(root)
c.load({ verify: true })
const now = new Date()

// ── R1：三类条目的 fresh 是否相同 ──
const items = c.getIndex().entries.map((meta) => ({ meta, origin: 'directed', bm25: 5 }))
const { scored } = scoreAll(items, { config: DEFAULT_ROUTE_CONFIG, now })
console.log('── R1 fresh 恒等于 pri ──')
for (const s of scored) {
  console.log(`   ${s.meta.id} decay=${String(s.meta.decay_type).padEnd(8)} pri=${s.pri.toFixed(3)} fresh=${s.fresh.toFixed(3)} 相等=${s.fresh === s.pri}`)
}
const uniq = new Set(scored.map((s) => s.fresh.toFixed(6)))
console.log(`   ⇒ 不同 decay_type 的 fresh 取值种类：${uniq.size}（全是 pri 的复制品）`)

// ── R2：cold_start 改不改分 ──
const inWin = scored.find((s) => s.meta.id === 'l04')
const outWin = scored.find((s) => s.meta.id === 'l05')
console.log('\n── R2 cold_start_until 改不了任何分数 ──')
console.log(`   l04（窗口内，cold_start=2099）score_in=${inWin.score_in.toFixed(6)} coldStart=${inWin.coldStart}`)
console.log(`   l05（窗口外，cold_start=2000）score_in=${outWin.score_in.toFixed(6)} coldStart=${outWin.coldStart}`)
console.log(`   ⇒ 分数差 = ${Math.abs(inWin.score_in - outWin.score_in).toFixed(6)}（除时间标记外完全相同）`)

// ── R5：同一轮内多次装配，access_count 涨几次 ──
const r = new Router(c, DEFAULT_ROUTE_CONFIG)
const before = new Map(c.getIndex().entries.map((e) => [e.id, Number(e.access_count) || 0]))
const rounds = []
for (let i = 0; i < 3; i++) {
  const res = r.route('探针')      // 模拟"同一轮被装配 3 次"
  rounds.push(res.main.map((m) => m.meta.id))
}
const after = new Map(c.getIndex().entries.map((e) => [e.id, Number(e.access_count) || 0]))
console.log('\n── R5 touch 每次装配都记（一轮 3 次装配）──')
for (const id of ['l01','l02','l03']) {
  const d = (after.get(id) ?? 0) - (before.get(id) ?? 0)
  console.log(`   ${id}: access_count +${d}（若按"每轮一次"应为 +1）`)
}
console.log(`   待落盘 touch 条数：${r.pendingTouchCount()}`)
fs.rmSync(root, { recursive: true, force: true })
