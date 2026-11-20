#!/usr/bin/env node
/**
 * 【增长普查】把"这些只追加文件会不会长成债"变成**可重跑的数**。
 *
 * ## 为什么要它
 * 2026-10-14 我在这上面**归错过一次**（把 5 秒级算成"意图日志不轮转"，
 * 真正的问题是 `listRollbackBatches` 平方级）—— 教训是：**别凭"应该是它"下结论，要量**。
 * 这个脚本把量法固化：① 从**真身**读实际增长速率 ② 把每个读者压到 1k/50k 行
 * ③ 做**粗线性检查**（50k 的耗时不该是 5k 的 20 倍以上 —— 线性约 10 倍，平方级约 100 倍）。
 *
 * ⛔ 只读：临时目录里造数据，不碰真身（真身只 stat 一下行数）。
 * ⛔ 阈值刻意"离两边都远"：它抓的是**平方级回来**，不是抓小抖动。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

const LIB = path.resolve(import.meta.dirname, '..', 'lib')
const REAL = process.env.MEMORY_ROOT ?? '/Users/admin/Documents/Obsidian Vault/00_记忆系统/dsh-memory-container'
const { readAudit, listRollbackBatches, resolveGateSnapshot, healAuditFromIntents } = await import(path.join(LIB, 'decay-sweep.js'))
const { readStartups, summarizeStartups } = await import(path.join(LIB, 'decay-monitor.js'))

const T = Date.parse('2026-10-14T12:00:00+08:00')
const mk = (name, rows) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'growth-'))
  fs.writeFileSync(path.join(root, name), rows.join('\n') + '\n')
  return root
}
const auditRows = (n) => Array.from({ length: n }, (_, i) => JSON.stringify({
  batch: 'sweep-2026' + String(101000000000000 + Math.floor(i / 5)).padStart(12, '0'),
  id: 'l' + i, from: 'longterm', to: 'archive', fresh: 0.1, at: T - i * 60000,
}))
const startupRows = (n) => Array.from({ length: n }, (_, i) => {
  const at = T - i * 3600000
  return JSON.stringify({ tz: 'Asia/Shanghai', lastAt: at - 86400000, sinceHours: 24, lastDayKey: '2026-10-13', todayKey: '2026-10-14', by24h: true, byDay: false, decidedBy: 'day', minIntervalBlocked: false, at, decidedAt: at, kind: i % 2 ? 'sweep' : 'gate', ran: i % 2 === 1, reason: '' })
})

const timeIt = (fn) => { const t = performance.now(); fn(); return performance.now() - t }
const SMALL = 5000
const BIG = 50000

console.log('════ 只追加文件增长普查 ════\n')
console.log('① 真身实际行数（只 stat）')
for (const [label, f] of [['审计', '.decay-audit.jsonl'], ['意图', '.decay-intent.jsonl'], ['启动账', '.decay-startup.jsonl'], ['增量日志', 'index.delta.jsonl']]) {
  let n = '—', size = '—'
  try { const p = path.join(REAL, f); const st = fs.statSync(p); size = (st.size / 1024).toFixed(1) + ' KB'; n = fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean).length } catch { n = '(不存在)' }
  console.log(`   ${label.padEnd(6)} ${String(n).padStart(6)} 行 ｜ ${size}`)
}

console.log('\n② 各读者耗时（临时目录，5k → 50k）')
const checks = []
const onlyAudit = (n, fn) => { const r = mk('.decay-audit.jsonl', auditRows(n)); return timeIt(() => fn(r)) }
const onlyStartup = (n, fn) => { const r = mk('.decay-startup.jsonl', startupRows(n)); return timeIt(() => fn(r)) }
const layerOf = () => 'longterm'
const suite = [
  ['readAudit', (n) => onlyAudit(n, readAudit)],
  ['listRollbackBatches', (n) => onlyAudit(n, listRollbackBatches)],
  ['resolveGateSnapshot', (n) => onlyAudit(n, (r) => resolveGateSnapshot(r, T))],
  // ⛔【2026-10-15】**这一项已移除** —— `healAuditFromIntents` 自愈已退役（L4 步③c-2），
  //   它守的那件事现在由**日志的 `moved` 段**承载（③c-1 已证）。
  ['readStartups', (n) => onlyStartup(n, readStartups)],
  ['summarizeStartups', (n) => onlyStartup(n, summarizeStartups)],
]
console.log('   读者                     5k        50k      比值（线性≈10×）')
let bad = 0
for (const [name, run] of suite) {
  run(SMALL) // 预热（JIT + 首次读盘）
  const a = run(SMALL)
  const b = run(BIG)
  const ratio = a > 0.05 ? b / a : NaN
  const ok = !Number.isFinite(ratio) || ratio < 20
  if (!ok) bad++
  console.log(`   ${name.padEnd(22)} ${a.toFixed(1).padStart(6)}ms ${b.toFixed(1).padStart(8)}ms   ${Number.isFinite(ratio) ? ratio.toFixed(1) + '×' : '—'}  ${ok ? '✅' : '❌ 疑似平方级'}`)
}

console.log('\n③ 结论口径')
console.log('   · 真身增长：审计 ~9 行/天、启动账 ~2 行/重启 ⇒ 都是**每年数千行**的量级')
console.log('   · `index.delta.jsonl` **本来就有界**：启动期折平 / 体积>快照20% / 最老一条>5 分钟 三条触发')
console.log(`   · 线性检查：${bad === 0 ? '✅ 全部通过' : `❌ ${bad} 项疑似平方级`}`)
process.exit(bad === 0 ? 0 : 1)
