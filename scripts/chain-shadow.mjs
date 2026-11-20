#!/usr/bin/env node
/**
 * ── 【P5 · 2026-10-18】链级判据影子跑（只算不写；唯一输出是 .chain-audit.jsonl）──
 * 用法：node scripts/chain-shadow.mjs "<容器根>" [H=7] [theta=0.1]
 */
import fs from 'node:fs'
import path from 'node:path'
import { MemoryContainer } from '../lib/container.js'
import { SubjectStore } from '../lib/subjects.js'
import { InjectionLedger } from '../lib/injection-ledger.js'
import { planChainSweep } from '../lib/chain.js'
import { loadPins } from '../lib/pins.js'
import { planDecaySweep, sweepEntries } from '../lib/decay.js'

const root = process.argv[2]
if (!root) { console.error('用法: node scripts/chain-shadow.mjs "<容器根>" [H] [theta]'); process.exit(2) }
const H = Number(process.argv[3] ?? 7)
const theta = Number(process.argv[4] ?? 0.1)

const container = new MemoryContainer(root, { verify: false })
const index = container.getIndex()
const subjects = new SubjectStore(root)
const ledger = new InjectionLedger(path.join(root, 'injection-ledger.jsonl'))
const delivered = ledger.deliveredCounts()

// 活跃日：日期 → 序号；会话 → 最后活跃日序号
const days = []
try {
  for (const line of fs.readFileSync(path.join(root, 'active-days.jsonl'), 'utf-8').split('\n')) {
    if (!line.trim()) continue
    const r = JSON.parse(line)
    if (!days.includes(r.day)) days.push(r.day)
  }
} catch { /* 无文件 */ }
days.sort()
const dayIndex = new Map(days.map((d, i) => [d, i]))
const lastBySession = new Map()
try {
  for (const line of fs.readFileSync(path.join(root, 'active-days.jsonl'), 'utf-8').split('\n')) {
    if (!line.trim()) continue
    const r = JSON.parse(line)
    const idx = dayIndex.get(r.day)
    if (idx === undefined) continue
    const prev = lastBySession.get(r.sessionId)
    if (prev === undefined || idx > prev) lastBySession.set(r.sessionId, idx)
  }
} catch { /* 无文件 */ }

const convBySession = new Map()
for (const s of subjects.list()) if (s.kind === 'conversation' && s.session_id) convBySession.set(s.session_id, s.id)

const conversations = []
for (const [sessionId, convId] of convBySession) {
  conversations.push({ convId, lastGrownDay: lastBySession.has(sessionId) ? lastBySession.get(sessionId) : null })
}

const entries = []
for (const meta of index.entries) {
  let src = null
  try { src = container.readEntry(meta.id)?.frontmatter?.source_session ?? null } catch { /* skip */ }
  entries.push({
    id: meta.id,
    layer: meta.layer,
    status: meta.status,
    decayType: meta.decay_type,
    hot: (index.hot_order ?? []).includes(meta.id),
    delivered: delivered.get(meta.id),
    convId: src ? (convBySession.get(src) ?? '') : '',
  })
}

const today = days.length ? days.length - 1 : 0
// 【B1 · 2026-10-26】先用旧判据算池内分位名单，再交给链级；链级不是“白名单”，是资格/档位。
let legacyQuantile = null
try { legacyQuantile = planDecaySweep(sweepEntries(index.entries, undefined, index.hot_order, delivered)) } catch { /* 影子降级 */ }
const quantileMoves = new Set((legacyQuantile?.moves ?? []).map((m) => m.id))
const plan = planChainSweep({ today, conversations, entries, H, theta, pinned: loadPins(root), quantileMoves })

// 影子审计（独立文件，⛔ 不混 .decay-audit）
const auditFile = path.join(root, '.chain-audit.jsonl')
const at = Date.now()
const batch = `chain-${at}`
const lines = plan.tiers.map((t) => JSON.stringify({
  judge: 'chain', batch, at, id: t.id, eff: Number(t.state.toFixed(6)), tier: t.tier,
  ...(t.guarded ? { guarded: t.guarded } : {}),
})).join('\n') + '\n'
fs.appendFileSync(auditFile, lines, 'utf-8')

// P5 影子对照：旧判据（条目级 + 墙钟）同口径跑一遍，列出分歧（⛔ 旧判据只用来看差异，不作真值）
const oldIds = (legacyQuantile?.moves ?? []).map((m) => m.id)
const newIds = plan.moves.map((m) => m.id)
const diff = {
  both: newIds.filter((id) => oldIds.includes(id)),
  onlyNew: newIds.filter((id) => !oldIds.includes(id)),
  onlyOld: oldIds.filter((id) => !newIds.includes(id)),
}
// B1：只有“非护栏”的分歧才算 unexplained；no-session/hot/core 等是预期护栏差异。
const tierById = new Map(plan.tiers.map((t) => [t.id, t]))
const unexplained = {
  onlyOld: diff.onlyOld.filter((id) => !tierById.get(id)?.guarded),
  onlyNew: diff.onlyNew.filter((id) => !tierById.get(id)?.guarded),
}

// 【P0-3】judged/guard 分账：judged=0 说明“一条都没真判”，⛔ 不许再报 ok
const guardCounts = {}
for (const t of plan.tiers) if (t.guarded) guardCounts[t.guarded] = (guardCounts[t.guarded] ?? 0) + 1
const judged = plan.tiers.filter((t) => !t.guarded).length
const sample = plan.tiers.slice(0, 8).map((t) => `${t.id} ${t.tier}${t.guarded ? `(${t.guarded})` : ''} s=${t.state.toFixed(3)}`)
console.log(JSON.stringify({
  ok: judged > 0,
  judged,
  guardCounts,
  H, theta, today, activeDays: days.length,
  conversations: conversations.length,
  entries: entries.length,
  byTier: plan.stats.byTier,
  moves: plan.moves.map((m) => ({ id: m.id, state: Number(m.state.toFixed(3)), ageDays: m.ageDays, reason: m.reason })),
  diff,
  diffUnexplained: { onlyOld: unexplained.onlyOld.length, onlyNew: unexplained.onlyNew.length },
  sample,
  audit: auditFile,
}, null, 2))

process.exit(judged > 0 ? 0 : 2)
