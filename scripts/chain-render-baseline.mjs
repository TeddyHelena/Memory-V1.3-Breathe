#!/usr/bin/env node
/**
 * 【P6】缓存基线：读 **events/render.jsonl 的 section==='hot' 行**，测 N 个活跃日的 hot 段字符数，
 * 冻结为 chain-render-baseline.json。
 * 用法: node scripts/chain-render-baseline.mjs "<容器根>" [days=7]
 * ⛔ 只读（唯一写是基线文件本身）；无有效行时输出 ok:false（不许假装有基线）。
 *
 * 【2026-10-19 修复】修前读 `assembly-ledger.jsonl` —— 全仓**没有这个文件的生产者**
 * ⇒ 照文档永远测不出基线（激活条件③永远过不了）。文档 §三.5 写的真源是 render/hot 事件，
 * 这里对齐到真源；冻结条件同时要求 chars>0 && p50>0（全零基线不许冻结）。
 */
import fs from 'node:fs'
import path from 'node:path'

const root = process.argv[2]
if (!root) { console.error('用法: node scripts/chain-render-baseline.mjs "<容器根>" [days]'); process.exit(2) }
const wantDays = Number(process.argv[3] ?? 7)

const candidates = [path.join('events', 'render.jsonl')]
let rows = []
let src = ''
for (const name of candidates) {
  const f = path.join(root, name)
  if (!fs.existsSync(f)) continue
  src = name
  rows = fs.readFileSync(f, 'utf-8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l) } catch { return null } })
    .filter((r) => r && r.section === 'hot')
  if (rows.length) break
}
if (!rows.length) {
  console.log(JSON.stringify({ ok: false, note: '没有 events/render.jsonl 的 section=hot 行，无法测字符基线（⛔ 不许用投递账本冒充）' }))
  process.exit(1)
}
// 按落盘时刻折算当地日（脚本与插件同机，默认时区即可）
const dayOf = (r) => {
  if (typeof r.day === 'string' && r.day) return r.day.slice(0, 10)
  if (typeof r.at === 'number' && Number.isFinite(r.at)) {
    const d = new Date(r.at)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  return ''
}
const days = new Set(rows.map(dayOf).filter(Boolean))
const chars = rows.map((r) => Number(r.chars)).filter((n) => Number.isFinite(n))
const sorted = [...chars].sort((a, b) => a - b)
const p = (q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))] : 0
const baseline = {
  version: 1,
  measuredAt: new Date().toISOString(),
  source: src,
  days: days.size,
  rows: rows.length,
  chars: { p50: p(0.5), p90: p(0.9), max: sorted.at(-1) ?? 0 },
  frozen: days.size >= wantDays && (sorted.at(-1) ?? 0) > 0 && p(0.5) > 0,
  note: days.size < wantDays
    ? `仅 ${days.size}/${wantDays} 天，不许冻结`
    : ((sorted.at(-1) ?? 0) > 0 && p(0.5) > 0 ? '基线可冻结' : '字符数全零（baseline 无效），不许冻结'),
}
fs.writeFileSync(path.join(root, 'chain-render-baseline.json'), JSON.stringify(baseline, null, 2), 'utf-8')
console.log(JSON.stringify({ ok: baseline.frozen, baseline }, null, 2))
process.exit(baseline.frozen ? 0 : 1)
