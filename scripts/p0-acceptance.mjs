#!/usr/bin/env node
/**
 * P0–P3 一键验收（只读）。
 * 用法：node scripts/p0-acceptance.mjs "<容器根>"
 * 输出：JSON { checks: [{name, ok, detail}] }
 */
import fs from 'node:fs'
import path from 'node:path'
import { MemoryContainer } from '../lib/container.js'
import { SubjectStore } from '../lib/subjects.js'

const root = process.argv[2]
if (!root) { console.error('用法: node scripts/p0-acceptance.mjs "<容器根>"'); process.exit(2) }

const checks = []
const add = (name, ok, detail) => checks.push({ name, ok, detail })

// ① subjects 自校验
try {
  const store = new SubjectStore(root)
  const sc = store.selfCheck()
  add('P2 subjects 自校验', sc.ok, sc)
} catch (e) {
  add('P2 subjects 自校验', false, String(e))
}

// ② write-receipts 与 md 的 source_session 交叉对账
try {
  const recFile = path.join(root, 'write-receipts.jsonl')
  const receipts = fs.existsSync(recFile)
    ? fs.readFileSync(recFile, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []
  const c = new MemoryContainer(root, { verify: false })
  const idx = c.getIndex()
  let withSession = 0
  for (const meta of idx.entries) {
    try {
      const e = c.readEntry(meta.id)
      if (e?.frontmatter?.source_session) withSession++
    } catch { /* skip */ }
  }
  const bySource = receipts.reduce((m, r) => { m[r.idSource ?? 'unknown'] = (m[r.idSource ?? 'unknown'] ?? 0) + 1; return m }, {})
  add('P0-3a 回执 ≤ md 非空条数', receipts.length <= withSession, { receipts: receipts.length, withSession, bySource })
} catch (e) {
  add('P0-3a 回执对账', false, String(e))
}

// ③ active-days
try {
  const f = path.join(root, 'active-days.jsonl')
  const rows = fs.existsSync(f) ? fs.readFileSync(f, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
  const days = new Set(rows.map((r) => r.day))
  const ts = rows.reduce((m, r) => { m[r.timeSource ?? 'unknown'] = (m[r.timeSource ?? 'unknown'] ?? 0) + 1; return m }, {})
  add('P0-7 active-days', rows.length > 0, { rows: rows.length, days: days.size, timeSource: ts })
} catch (e) {
  add('P0-7 active-days', false, String(e))
}

// ④ 启动记账：最近 10 行里是否有「未扫（开关）」
try {
  const f = path.join(root, '.decay-startup.jsonl')
  const rows = fs.existsSync(f) ? fs.readFileSync(f, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
  const tail = rows.slice(-10)
  const switchOff = tail.filter((r) => r.ran === false && String(r.reason ?? '').includes('开关'))
  add('P0-5 开关关闭记账', switchOff.length > 0, { tailRows: tail.length, switchOff: switchOff.length, last: tail.at(-1) ?? null })
} catch (e) {
  add('P0-5 开关关闭记账', false, String(e))
}

// ⑤ has_session 与 raw 对账
try {
  const c = new MemoryContainer(root, { verify: false })
  const idx = c.getIndex()
  let mismatch = 0, checked = 0
  for (const meta of idx.entries) {
    try {
      const e = c.readEntry(meta.id)
      const has = Boolean(e?.frontmatter?.source_session)
      checked++
      if (Boolean(meta.has_session) !== has) mismatch++
    } catch { /* skip */ }
  }
  add('P0-6 has_session 对账', mismatch === 0, { checked, mismatch })
} catch (e) {
  add('P0-6 has_session 对账', false, String(e))
}

const ok = checks.every((c) => c.ok)
console.log(JSON.stringify({ ok, checks }, null, 2))
process.exit(ok ? 0 : 1)
