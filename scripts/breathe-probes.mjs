#!/usr/bin/env node
/**
 * breathe-probes.mjs —— Breathe 全维度观测探针（只读）
 *
 * 用法:
 *   node scripts/breathe-probes.mjs "<容器根>" [--json] [--out <file>] [--matrix <path>]
 *
 * 口径:
 *   - **只读**：不 relocate、不 append 条目、不改 index；唯一写是 `--out` 指定的报告文件。
 *   - 10 个探针 = `docs/OBSERVATION-MATRIX.md` 的 21 个维度；M1（语义质量）是人工抽检，不在本脚本。
 *   - 每节只出一个状态：green / yellow（没样本/没基线，不许当绿）/ red（硬线破了）。
 *   - 任何一节抛错 → 该节 `error`，不拖垮其它节。
 *
 * 退出口径: 0 = 全绿；1 = 有 red/error；2 = 用法错误。
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { execFileSync } from 'node:child_process'

import { MemoryContainer } from '../lib/container.js'
import { InjectionLedger } from '../lib/injection-ledger.js'
import { computeTierOverrides } from '../lib/chain-render.js'
import { planDecaySweep, sweepEntries } from '../lib/decay.js'
import { readEvents } from '../lib/event-log.js'
import { loadPins } from '../lib/pins.js'
import { readLog, replay } from '../lib/decay-log.js'
import { LOCK_FILE } from '../lib/lock.js'
import { dueForgetting, isMatured } from '../lib/publication.js'
import { dayKey } from '../lib/day-boundary.js'
import { searchLongterm } from '../lib/search.js'
import { verifyChecksum } from '../lib/checksum.js'
import { TOMBSTONE_TITLE_PREFIX } from '../lib/writer.js'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const MATRIX_DEFAULT = path.join(REPO, 'docs', 'OBSERVATION-MATRIX.md')
const TOMBSTONE_SUMMARY = '（已删除：仅保留元数据）'
const DIMS = [
  'A1', 'A2', 'A3', 'A4',
  'B1', 'B2', 'B3', 'B4', 'B5',
  'C1', 'C2', 'C3', 'C4',
  'D1', 'D2', 'D3', 'D4',
  'E1', 'E2', 'E3', 'E4',
]

const argv = process.argv.slice(2)
if (!argv[0] || argv[0].startsWith('--')) {
  console.error('用法: node scripts/breathe-probes.mjs "<容器根>" [--json] [--out <file>] [--matrix <path>]')
  process.exit(2)
}
const root = path.resolve(argv[0])
const opt = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const matrixPath = path.resolve(opt('--matrix', MATRIX_DEFAULT))
const outPath = opt('--out', null)
const jsonOnly = argv.includes('--json')

const now = Date.now()
const probeStart = Date.now()
const sections = {}
const notes = []
const evidence = []

// ── 通用只读工具 ────────────────────────────────────────────────
const readText = (rel) => { try { return fs.readFileSync(path.join(root, rel), 'utf-8') } catch { return null } }
const readJson = (rel) => { const t = readText(rel); if (t === null) return null; try { return JSON.parse(t) } catch { return undefined } }
const readJsonl = (rel) => {
  const t = readText(rel)
  if (t === null) return { exists: false, rows: [], bad: [] }
  const rows = []; const bad = []
  t.split('\n').forEach((l, i) => {
    if (!l.trim()) return
    try { rows.push(JSON.parse(l)) } catch { bad.push(i + 1) }
  })
  return { exists: true, rows, bad }
}
const listDirs = (rel) => { try { return fs.readdirSync(path.join(root, rel), { withFileTypes: true }) } catch { return [] } }
const section = (id, fn) => {
  const started = Date.now()
  try {
    const out = fn()
    sections[id] = { status: out.status, metrics: out.metrics ?? {}, notes: out.notes ?? [], evidence: out.evidence ?? [], ms: Date.now() - started }
  } catch (e) {
    sections[id] = { status: 'error', metrics: {}, notes: [], evidence: [], error: e instanceof Error ? e.message : String(e), ms: Date.now() - started }
  }
}
const worst = (...xs) => xs.includes('error') ? 'error' : xs.includes('red') ? 'red' : xs.includes('yellow') ? 'yellow' : 'green'

// ── 矩阵覆盖（“全”的机械守点） ──────────────────────────────────
section('M0', () => {
  let text = null
  try { text = fs.readFileSync(matrixPath, 'utf-8') } catch { /* missing */ }
  if (text === null) return { status: 'error', notes: [`矩阵文件读不到: ${matrixPath}`] }
  const unmapped = DIMS.filter((d) => {
    const line = text.split('\n').find((l) => new RegExp(`^\\|\\s*${d}\\s*\\|`).test(l))
    if (!line) return true
    return !/P\d+|M1|豁免/.test(line)
  })
  return {
    status: unmapped.length ? 'red' : 'green',
    metrics: { dimensions: DIMS.length, unmapped: unmapped.length },
    notes: unmapped.length ? [`未映射维度: ${unmapped.join(', ')}`] : [],
    evidence: [matrixPath],
  }
})

// ── 基础读取：索引 / 容器（load 用 verify:false，不折平、不改盘） ──
const indexBefore = (() => { try { const st = fs.statSync(path.join(root, 'index.json')); return `${st.size}:${st.mtimeMs}` } catch { return null } })()
const indexFile = readJson('index.json')
const container = new MemoryContainer(root)
const loadStarted = Date.now()
let loadErr = null
try { container.load({ verify: false }) } catch (e) { loadErr = e instanceof Error ? e.message : String(e) }
const loadMs = Date.now() - loadStarted
const index = indexFile && Array.isArray(indexFile.entries) ? indexFile : null
const indexIds = new Set((index?.entries ?? []).map((e) => e.id))

const subjectRecords = (() => {
  const idx = readJson(path.join('subjects', 'index.json'))
  if (idx && Array.isArray(idx.subjects)) return idx.subjects
  const out = []
  for (const ent of listDirs('subjects')) {
    if (!ent.isFile() || !ent.name.endsWith('.md')) continue
    const t = readText(path.join('subjects', ent.name))
    if (!t) continue
    const m = t.match(/^---\n([\s\S]*?)\n---/)
    if (!m) continue
    const kv = {}
    for (const line of m[1].split('\n')) { const i = line.indexOf(':'); if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim() }
    if (kv.id && kv.kind) out.push(kv)
  }
  return out
})()
const subjectById = new Map(subjectRecords.map((s) => [s.id, s]))

// ── P1 真值输入 ────────────────────────────────────────────────
section('P1', () => {
  const ad = readJsonl('active-days.jsonl')
  const days = new Set(); const sessions = new Set(); const timeSource = {}
  for (const r of ad.rows) {
    if (typeof r.day === 'string') days.add(r.day)
    if (typeof r.sessionId === 'string') sessions.add(r.sessionId)
    const k = String(r.timeSource ?? 'missing')
    timeSource[k] = (timeSource[k] ?? 0) + 1
  }
  const convs = subjectRecords.filter((s) => s.kind === 'conversation')
  const convOrphans = subjectRecords.filter((s) => s.parent && !subjectById.has(String(s.parent)))
  const withSession = convs.filter((s) => s.session_id).length
  // 【沙箱 s4 抓到的盲区】P1 只看索引会漏掉“md 有、索引没有”的会话（并发丢更新）
  let mdConversations = 0
  for (const ent of listDirs('subjects')) {
    if (!ent.isFile() || !ent.name.endsWith('.md')) continue
    const t = readText(path.join('subjects', ent.name))
    if (t && /^kind:\s*conversation\s*$/m.test(t) && /^session_id:\s*\S+/m.test(t)) mdConversations++
  }
  const convIndexMismatch = mdConversations - withSession
  const indexEntries = index?.entries ?? []
  const hasSession = indexEntries.filter((e) => e.has_session === true).length
  // 采样 20 条：真实 frontmatter 的来源字段 vs 索引投影
  const sample = indexEntries.slice(0, 20)
  let sampled = 0; let sampledSource = 0; let seqZero = 0
  for (const e of sample) {
    let t = null
    try { t = container.readEntry(e.id)?.frontmatter } catch { /* skip */ }
    if (!t) continue
    sampled++
    if (typeof t.source_session === 'string' && t.source_session) sampledSource++
    if (String(t.source_message ?? '') === '0' || t.source_message === undefined) seqZero++
  }
  const bad = ad.bad.length
  const status = ad.exists && bad === 0 && convOrphans.length === 0 && convIndexMismatch === 0 && index
    ? (indexEntries.length ? 'green' : 'yellow')
    : (ad.exists ? 'red' : 'yellow')
  return {
    status,
    metrics: {
      activeDays: days.size, activeRows: ad.rows.length, activeBadLines: bad,
      sessions: sessions.size, timeSource,
      conversations: convs.length, conversationsWithSession: withSession,
      conversationMdWithSession: mdConversations, conversationIndexMismatch: convIndexMismatch,
      subjectOrphans: convOrphans.length,
      entries: indexEntries.length, indexHasSession: hasSession,
      sampledEntries: sampled, sampledSourceSession: sampledSource, sampledSeqZero: seqZero,
    },
    notes: [
      ...(ad.exists ? [] : ['没有 active-days.jsonl']),
      ...(convOrphans.length ? [`subject 孤儿: ${convOrphans.slice(0, 5).map((s) => s.id).join(', ')}`] : []),
      ...(convIndexMismatch ? [`会话 md 与索引不一致：md ${mdConversations} / 索引 ${withSession}（并发丢更新？）`] : []),
      ...(bad ? [`active-days 坏行: ${bad} 行`] : []),
    ],
    evidence: ['active-days.jsonl', 'subjects/', 'index.json'],
  }
})

// ── P2 写入账 ─────────────────────────────────────────────────
section('P2', () => {
  const rec = readJsonl('write-receipts.jsonl')
  const ids = new Map(); const bySource = {}; const bySession = {}
  for (const r of rec.rows) {
    if (typeof r.id === 'string') ids.set(r.id, (ids.get(r.id) ?? 0) + 1)
    bySource[String(r.idSource ?? 'missing')] = (bySource[String(r.idSource ?? 'missing')] ?? 0) + 1
    bySession[String(r.sessionId ?? '')] = (bySession[String(r.sessionId ?? '')] ?? 0) + 1
  }
  const dupIds = [...ids.values()].filter((n) => n > 1).length
  const notInIndex = [...ids.keys()].filter((id) => !indexIds.has(id))
  const status = rec.bad.length ? 'red' : (!rec.exists || rec.rows.length === 0 ? 'yellow' : 'green')
  return {
    status,
    metrics: { receipts: rec.rows.length, badLines: rec.bad.length, distinctIds: ids.size, duplicateReceiptIds: dupIds, bySource, sessions: Object.keys(bySession).length, idsNotInIndex: notInIndex.length },
    notes: [
      ...(notInIndex.length ? [`${notInIndex.length} 个回执 id 不在索引（purge/墓碑请人工核）: ${notInIndex.slice(0, 5).join(', ')}`] : []),
      ...(rec.exists ? [] : ['没有 write-receipts.jsonl']),
    ],
    evidence: ['write-receipts.jsonl', 'index.json'],
  }
})

// ── P3 账实 / 版本 / 读数面 ───────────────────────────────────
section('P3', () => {
  if (loadErr) return { status: 'red', metrics: { loadError: loadErr }, notes: [`container.load 失败: ${loadErr}`] }
  if (!index) return { status: 'red', notes: ['index.json 不存在或不是合法 JSON'] }
  const hot = new Set(index.hot_order ?? [])
  const fileSet = new Set(index.entries.map((e) => e.file))
  const missingFiles = []
  for (const e of index.entries) { try { if (!fs.existsSync(container.resolvePath(e.file))) missingFiles.push(e.id) } catch { missingFiles.push(e.id) } }
  const orphanFiles = []
  for (const layer of ['hot', 'longterm', 'archive', 'pending']) {
    for (const ent of listDirs(layer)) {
      if (!ent.isFile() || !ent.name.endsWith('.md')) continue
      const rel = `${layer}/${ent.name}`
      if (!fileSet.has(rel)) orphanFiles.push(rel)
    }
  }
  const dupIds = index.entries.length - new Set(index.entries.map((e) => e.id)).size
  // 投影漂移：采样 50 条，读文件 frontmatter 比对索引
  let sampled = 0; const drift = []
  // 版本分叉：同一个底座被多个 active 头 supersedes（s4 并发 update 的形态）
  const headsByBase = new Map()
  for (const e of index.entries.slice(0, 50)) {
    let fm = null
    try { fm = container.readEntry(e.id)?.frontmatter } catch { /* skip */ }
    if (!fm) continue
    sampled++
    for (const k of ['layer', 'status', 'title']) {
      // 文件里**没写**的字段可能是解析默认值/索引投影，不算漂移；只有“写了但不一致”才算
      if (fm[k] === undefined) continue
      if (String(fm[k]) !== String(e[k] ?? '')) { drift.push(`${e.id}.${k}`); break }
    }
    if (fm.status === 'active' && Array.isArray(fm.supersedes)) {
      for (const base of fm.supersedes) {
        if (typeof base !== 'string') continue
        const list = headsByBase.get(base) ?? []
        list.push(e.id)
        headsByBase.set(base, list)
      }
    }
  }
  const versionForks = [...headsByBase.entries()].filter(([, heads]) => heads.length > 1).map(([base, heads]) => ({ base, heads }))
  let ckSampled = 0; const ckBad = []; let ckUnverifiable = 0
  for (const e of index.entries.slice(0, 20)) {
    try {
      const entry = container.readEntry(e.id)
      if (!entry) continue
      ckSampled++
      const verdict = verifyChecksum(entry.frontmatter.checksum, entry.content)
      if (verdict === 'mismatch') ckBad.push(e.id)
      else if (verdict === 'unverifiable') ckUnverifiable++
    } catch { /* skip */ }
  }
  // 版本/状态
  const counts = { active: 0, superseded: 0, expired: 0, other: 0 }
  for (const e of index.entries) {
    const s = String(e.status ?? 'active')
    if (s === 'active') counts.active++
    else if (s === 'superseded') counts.superseded++
    else if (s === 'expired') counts.expired++
    else counts.other++
  }
  const danglingSupersede = index.entries.filter((e) => e.superseded_by && !indexIds.has(String(e.superseded_by))).length
  const scopes = {}
  for (const e of index.entries) { const k = String(e.scope ?? 'global'); scopes[k] = (scopes[k] ?? 0) + 1 }
  // 增量日志 / 读数面
  let logStatus = null
  try { logStatus = container.indexLogStatus() } catch { /* skip */ }
  // 【s3 抓到的盲区】坏 delta 行会让后续记录被跳过（已删条目复活）⇒ 必须单独判红
  const deltaRaw = readJsonl('index.delta.jsonl')
  const deltaBadLines = deltaRaw.bad.length
  const indexAfter = (() => { try { const st = fs.statSync(path.join(root, 'index.json')); return `${st.size}:${st.mtimeMs}` } catch { return null } })()
  const mutated = indexBefore !== null && indexAfter !== null && indexBefore !== indexAfter
  const status = mutated || missingFiles.length || orphanFiles.length || dupIds || drift.length || ckBad.length || versionForks.length || deltaBadLines
    ? 'red'
    : (!index.entries.length ? 'yellow' : (ckUnverifiable > 0 ? 'yellow' : 'green'))
  return {
    status,
    metrics: {
      entries: index.entries.length, indexEntryCount: index.entry_count, hotOrder: hot.size,
      missingFiles: missingFiles.length, orphanFiles: orphanFiles.length, duplicateIds: dupIds,
      driftSampled: sampled, drift: drift.length, checksumSampled: ckSampled, checksumBad: ckBad.length,
      versionForks: versionForks.length,
      statusCounts: counts, danglingSupersede, scopes, checksumUnverifiable: ckUnverifiable,
      delta: logStatus, deltaBadLines, indexMutatedByProbe: mutated, loadMs,
    },
    notes: [
      ...(mutated ? ['⚠️ 探针读完后 index.json 变了（load 不应写盘）'] : []),
      ...(missingFiles.length ? [`条目文件缺失: ${missingFiles.slice(0, 5).join(', ')}`] : []),
      ...(orphanFiles.length ? [`未登记 md: ${orphanFiles.slice(0, 5).join(', ')}`] : []),
      ...(drift.length ? [`投影漂移: ${drift.slice(0, 5).join(', ')}`] : []),
      ...(ckBad.length ? [`checksum 不符（真篡改/真脏）: ${ckBad.slice(0, 5).join(', ')}`] : []),
      ...(versionForks.length ? [`版本分叉（同一底座多个 active 头）: ${versionForks.slice(0, 3).map((f) => `${f.base}→${f.heads.join('|')}`).join(', ')}`] : []),
      ...(ckUnverifiable ? [`checksum 不可验（旧版本/空值，不算通过）: ${ckUnverifiable}/${ckSampled}`] : []),
      ...(logStatus?.pendingRecords > 0 && (logStatus?.oldestAgeMs ?? 0) > 5 * 60_000 ? ['增量日志超 5 分钟未折平（读数面陈旧）'] : []),
      ...(deltaBadLines ? [`index.delta.jsonl 坏行 ${deltaBadLines} 条（可能跳过后续记录）`] : []),
    ],
    evidence: ['index.json', 'index.delta.jsonl'],
  }
})

// ── P4 恢复 / 隔离 ────────────────────────────────────────────
section('P4', () => {
  const trashDirs = listDirs('.purge-trash').filter((d) => d.isDirectory())
  let trashMd = 0
  for (const d of trashDirs) { try { trashMd += fs.readdirSync(path.join(root, '.purge-trash', d.name)).filter((f) => f.endsWith('.md')).length } catch { /* skip */ } }
  const log = readLog(root)
  const rep = replay(log.records)
  const incomplete = rep.projection.incompleteTxns ?? []
  let lock = null
  try { const st = fs.statSync(path.join(root, LOCK_FILE)); lock = { ageMs: now - st.mtimeMs } } catch { /* no lock */ }
  // 辅助锁（pins/subjects）：崩溃残留超过 60s 说明没人正常释放（各自 staleMs 只有 10s）
  const auxLocks = {}
  for (const name of ['.pins.lock', '.subjects.lock']) {
    try { auxLocks[name] = now - fs.statSync(path.join(root, name)).mtimeMs } catch { /* no lock */ }
  }
  const staleAux = Object.entries(auxLocks).filter(([, age]) => age > 60_000).map(([n]) => n)
  const badScope = (index?.entries ?? []).filter((e) => e.scope === 'project' && !e.scope_id).map((e) => e.id)
  const status = incomplete.length || rep.problems.length || trashMd || (lock && lock.ageMs > 60_000) || staleAux.length || badScope.length ? 'red' : 'green'
  return {
    status,
    metrics: { purgeTrashDirs: trashDirs.length, purgeTrashMd: trashMd, decayLogProblems: rep.problems.length, incompleteTxns: incomplete.length, lockAgeMs: lock?.ageMs ?? null, auxLocks, staleAuxLocks: staleAux, projectScopeWithoutId: badScope.length },
    notes: [
      ...(incomplete.length ? [`半批事务: ${incomplete.slice(0, 3).join(', ')}`] : []),
      ...(trashMd ? [`purge 残留正文 ${trashMd} 个 md（需人工删）`] : []),
      ...(badScope.length ? [`project scope 缺 scope_id: ${badScope.slice(0, 5).join(', ')}`] : []),
      ...(lock ? [`锁文件存在 ${Math.round((lock.ageMs ?? 0) / 1000)}s`] : []),
      ...(staleAux.length ? [`辅助锁残留 >60s: ${staleAux.join(', ')}`] : []),
    ],
    evidence: ['.purge-trash/', '.sweep-log.jsonl', LOCK_FILE],
  }
})

// ── P5 判据分歧 ───────────────────────────────────────────────
const subjectsAdapter = { list: () => subjectRecords, get: (id) => subjectById.get(id) ?? null }
const ledger = new InjectionLedger(path.join(root, 'injection-ledger.jsonl'))
let chainRes = null
let chainMs = null
section('P5', () => {
  if (!index || loadErr) return { status: 'red', notes: ['索引不可用，无法算判据'] }
  const started = Date.now()
  chainRes = computeTierOverrides(container, subjectsAdapter, ledger, 7, 0.1, { limit: 20 })
  chainMs = Date.now() - started
  const delivered = ledger.deliveredCounts()
  const legacy = planDecaySweep(sweepEntries(index.entries, now, index.hot_order, delivered))
  const chainMoves = new Set(chainRes.plan.moves.map((m) => m.id))
  const legacyMoves = new Set(legacy.moves.map((m) => m.id))
  const legacyBlocked = new Set((legacy.blocked ?? []).map((b) => b.id))
  const onlyChain = [...chainMoves].filter((id) => !legacyMoves.has(id))
  const onlyLegacy = [...legacyMoves].filter((id) => !chainMoves.has(id))
  const tierOf = new Map(chainRes.plan.tiers.map((t) => [t.id, t]))
  const metaOf = new Map(index.entries.map((e) => [e.id, e]))
  const unexplained = []
  for (const id of onlyChain) {
    const t = tierOf.get(id); const m = metaOf.get(id)
    if (!t || t.guarded || t.ageDays < 0) continue
    if (m && (m.status !== 'active' || m.decay_type === 'core')) continue
    if (legacyBlocked.has(id)) continue
    unexplained.push(id)
  }
  for (const id of onlyLegacy) {
    const t = tierOf.get(id)
    if (t?.guarded) continue
    unexplained.push(id)
  }
  const judged = chainRes.plan.tiers.filter((t) => t.ageDays >= 0 && !t.guarded).length
  const status = judged === 0 ? 'red' : (unexplained.length ? 'red' : 'green')
  return {
    status,
    metrics: {
      today: chainRes.today, activeDays: chainRes.activeDays,
      judged, chainMoves: chainMoves.size, legacyMoves: legacyMoves.size,
      onlyChain: onlyChain.length, onlyLegacy: onlyLegacy.length, unexplained: unexplained.length,
      byTier: chainRes.plan.stats.byTier, overLimit: chainRes.plan.stats.overLimit,
      chainMs,
    },
    notes: [
      ...(judged === 0 ? ['judged=0：链级判据在真实容器上一个可判条目都没有（inert，不是绿）'] : []),
      ...(unexplained.length ? [`不可解释分歧: ${unexplained.slice(0, 8).join(', ')}`] : []),
    ],
    evidence: ['src/chain.ts', 'src/chain-render.ts', 'src/decay.ts'],
  }
})

// ── P6 档位 / 渲染 ────────────────────────────────────────────
section('P6', () => {
  const tc = readJsonl(path.join('events', 'tier-change.jsonl'))
  const byDay = {}
  for (const r of tc.rows) {
    const d = typeof r.at === 'number' ? new Date(r.at) : null
    const key = d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : 'unknown'
    byDay[key] = (byDay[key] ?? 0) + 1
  }
  const maxFlips = Object.values(byDay).reduce((m, n) => Math.max(m, n), 0)
  const render = readJsonl(path.join('events', 'render.jsonl'))
  const hotChars = render.rows.filter((r) => r.section === 'hot' && Number.isFinite(Number(r.chars))).slice(-20).map((r) => Number(r.chars))
  const p50 = hotChars.length ? [...hotChars].sort((a, b) => a - b)[Math.floor((hotChars.length - 1) / 2)] : 0
  const baseline = readJson('chain-render-baseline.json')
  const baseP50 = Number(baseline?.chars?.p50 ?? 0)
  const driftPct = baseP50 > 0 ? Number((((p50 - baseP50) / baseP50) * 100).toFixed(1)) : null
  const status = maxFlips > 1 ? 'red'
    : (!hotChars.length || !baseline ? 'yellow'
      : (baseP50 > 0 && driftPct !== null && Math.abs(driftPct) > 20 ? 'red' : 'green'))
  return {
    status,
    metrics: { tierChangeRows: tc.rows.length, tierChangeDays: Object.keys(byDay).length, maxFlipsPerDay: maxFlips, hotRenderSamples: hotChars.length, hotCharsP50: p50, baselineP50: baseP50 || null, driftPct },
    notes: [
      ...(maxFlips > 1 ? [`单日翻转 ${maxFlips} 次 > 1（P6 门槛）`] : []),
      ...(!hotChars.length ? ['没有 render/hot 样本'] : []),
      ...(baseline ? [] : ['没有 chain-render-baseline.json（P6 无基线闸门）']),
    ],
    evidence: ['events/tier-change.jsonl', 'events/render.jsonl', 'chain-render-baseline.json'],
  }
})

// ── P7 扫描 / 公示 ───────────────────────────────────────────
section('P7', () => {
  const st = readJson('.decay-sweep.json')
  const pubs = readJsonl(path.join('events', 'publication.jsonl'))
  const notices = pubs.rows.filter((r) => typeof r.expireDay === 'number' && Array.isArray(r.ids))
  const dueRows = pubs.rows.filter((r) => r.kind === 'due')
  const consumed = new Set(dueRows.map((r) => String(r.batch)).filter((b) => b.startsWith('due-')).map((b) => b.slice(4)))
  // 【并发修复后】loadPins 坏文件会 fail-closed 抛错；探针自己兜住并判红，不让整节 error。
  let pins = new Set()
  let pinsBad = false
  try { pins = loadPins(root) } catch { pinsBad = true }
  const today = chainRes?.today ?? (() => { const ad = readJsonl('active-days.jsonl'); const days = new Set(ad.rows.map((r) => r.day).filter(Boolean)); return days.size ? days.size - 1 : 0 })()
  const prev = [...notices].reverse().find((r) => typeof r.batch === 'string') ?? null
  const wallDay = dayKey(new Date())
  const toNotice = (r) => ({ batch: String(r.batch), ids: r.ids, publishedDay: Number(r.publishedDay), expireDay: Number(r.expireDay), ...(typeof r.publishedWallDay === 'string' ? { publishedWallDay: r.publishedWallDay } : {}), ...(typeof r.expireWallDay === 'string' ? { expireWallDay: r.expireWallDay } : {}) })
  const prevNotice = prev ? toNotice(prev) : null
  const prevDue = prevNotice ? isMatured(prevNotice, today, wallDay) : false
  const matured = notices.filter((r) => isMatured(toNotice(r), today, wallDay))
  const unconsumed = matured.filter((r) => !consumed.has(String(r.batch)))
  const curDue = prevNotice && prevDue ? dueForgetting(prevNotice, pins, today, wallDay) : []
  const bDue = [...new Set(unconsumed.flatMap((r) => (r.ids ?? []).filter((id) => !pins.has(id))))]
  const todayBatch = `pub-${wallDay}`
  // 口径 A：只有“没有上一批”或“上一批已到期”才应该落新行
  const wouldPublish = !notices.some((r) => r.batch === todayBatch) && (prevNotice === null || prevDue)
  const audit = readJsonl('.decay-audit.jsonl')
  const sweepLog = readLog(root)
  const commits = sweepLog.records.filter((r) => r.phase === 'commit').length
  let status = 'green'
  if (pinsBad) status = 'red'
  if (!notices.length) status = 'yellow'
  else if (prevDue && prev && !consumed.has(String(prev.batch))) status = 'red'  // A：上一批到期未消费
  else if (!prevDue) status = 'yellow'   // 订阅期进行中
  if (dueRows.some((r) => !notices.some((n) => `due-${n.batch}` === r.batch))) status = 'red'
  return {
    status,
    metrics: {
      today, pins: pins.size, notices: notices.length, dueRows: dueRows.length,
      prevBatch: prev?.batch ?? null, prevExpireDay: prev?.expireDay ?? null,
      maturedBatches: matured.length, unconsumedBatches: unconsumed.length,
      currentDue: curDue.length, bDue: bDue.length, prevDue,
      wouldPublishToday: wouldPublish, sweepCommits: commits, auditRows: audit.rows.length,
      lastAutoAt: st?.lastAutoAt ?? null, lastCount: st?.lastCount ?? null, pinsFileBad: pinsBad,
    },
    notes: [
      ...(!notices.length ? ['还没有任何公示批次'] : []),
      ...(prevDue && prev && !consumed.has(String(prev.batch)) ? [`A 口径：上一批 ${prev.batch} 已到期但未消费（due=${curDue.length}；按批次结算 B 会到期 ${bDue.length} 条）`] : []),
      ...(pinsBad ? ['pins.json 解析失败（loadPins 会静默空集 = 全体解钉）'] : []),
      ...(wouldPublish ? ['今天还没落公示行（会重签订阅期）'] : []),
      ...(st === null ? ['没有 .decay-sweep.json（从未自动扫描）'] : (st?.lastAutoAt ? [] : ['状态文件存在但 lastAutoAt=0（从未自动扫描）'])),
    ],
    evidence: ['events/publication.jsonl', '.decay-sweep.json', '.sweep-log.jsonl'],
  }
})

// ── P8 交付 / 检索 / 反馈 ─────────────────────────────────────
section('P8', () => {
  const inj = readJsonl('injection-ledger.jsonl')
  const ids = new Set(); const faces = {}
  for (const r of inj.rows) {
    if (Array.isArray(r.ids)) for (const id of r.ids) ids.add(String(id))
    faces[String(r.face ?? 'missing')] = (faces[String(r.face ?? 'missing')] ?? 0) + 1
  }
  const delivered = ledger.deliveredCounts()
  const candidates = (index?.entries ?? []).filter((e) => ['longterm', 'archive'].includes(e.layer) && e.status !== 'expired' && e.status !== 'superseded')
  const never = candidates.filter((e) => !delivered.has(e.id))
  const sample = candidates.filter((e) => typeof e.title === 'string' && e.title.trim().length >= 2).slice(0, 3)
  let hits = 0; const hitDetail = []
  for (const e of sample) {
    try {
      const scopeContext = {
        ...(e.scope === 'project' && e.scope_id ? { projectId: String(e.scope_id) } : {}),
        ...(e.scope === 'workspace' && e.scope_id ? { workspaceId: String(e.scope_id) } : {}),
      }
      const res = searchLongterm(container, e.title.trim(), { topK: 5, layerFilter: ['longterm', 'archive'], enableLexicon: false, ...(Object.keys(scopeContext).length ? { scopeContext } : {}) })
      const ok = res.some((h) => h.id === e.id)
      if (ok) hits++
      hitDetail.push({ id: e.id, ok })
    } catch { hitDetail.push({ id: e.id, ok: false }) }
  }
  const mention = readJsonl(path.join('events', 'mention.jsonl'))
  const activation = readJsonl(path.join('events', 'activation.jsonl'))
  const status = (!inj.exists || !inj.rows.length || !sample.length) ? 'yellow'
    : (hits === sample.length ? 'green' : 'red')
  return {
    status,
    metrics: { injectionEvents: inj.rows.length, injectionBadLines: inj.bad.length, faces, deliveredIds: ids.size, candidates: candidates.length, neverDelivered: never.length, searchSamples: sample.length, searchHits: hits, mentionRows: mention.rows.length, activationRows: activation.rows.length, hitDetail },
    notes: [
      ...(never.length ? [`never-delivered ${never.length}/${candidates.length}：${never.slice(0, 5).map((e) => e.id).join(', ')}`] : []),
      ...(sample.length && hits < sample.length ? ['检索自检未全命中（按标题查自己）'] : []),
    ],
    evidence: ['injection-ledger.jsonl', 'events/mention.jsonl', 'events/activation.jsonl'],
  }
})

// ── P9 成本 ─────────────────────────────────────────────────
section('P9', () => {
  const sizes = {}
  for (const f of ['index.json', 'index.delta.jsonl', '.sweep-log.jsonl', '.decay-startup.jsonl', 'active-days.jsonl', 'injection-ledger.jsonl']) {
    try { sizes[f] = fs.statSync(path.join(root, f)).size } catch { sizes[f] = null }
  }
  const baseline = readJson('observation-baseline.json')
  const metrics = { loadMs, chainMs, probeTotalMs: null, sizes, entries: index?.entries.length ?? 0 }
  const checks = []
  if (baseline) {
    for (const k of ['loadMs', 'chainMs']) {
      const b = Number(baseline[k])
      if (b > 0 && Number.isFinite(metrics[k])) {
        const pct = Number((((metrics[k] - b) / b) * 100).toFixed(1))
        metrics[`${k}DeltaPct`] = pct
        if (pct > 20) checks.push(`${k} 超基线 ${pct}%`)
      }
    }
  }
  return {
    status: checks.length ? 'red' : (baseline ? 'green' : 'yellow'),
    metrics,
    notes: [
      ...(baseline ? [] : ['没有 observation-baseline.json（成本只报数，不判绿）']),
      ...checks,
      '写入 p50/p95 未落盘（当前只有 receipts 的 at 时间戳，无法算单次耗时）',
    ],
    evidence: ['index.json', '.sweep-log.jsonl'],
  }
})

// ── P10 安全 / 隐私 / 治理 ───────────────────────────────────
section('P10', () => {
  const tomb = (index?.entries ?? []).filter((e) => e.status === 'expired' || e.deleted_at)
  let residue = []
  for (const e of tomb.slice(0, 200)) {
    try {
      const entry = container.readEntry(e.id)
      if (!entry) { residue.push(`${e.id}:missing`); continue }
      const titleOk = String(entry.frontmatter.title ?? '').startsWith(TOMBSTONE_TITLE_PREFIX)
      const summaryOk = String(entry.frontmatter.summary ?? '') === TOMBSTONE_SUMMARY
      if (!titleOk || !summaryOk) residue.push(e.id)
    } catch { residue.push(`${e.id}:error`) }
  }
  const trashDirs = listDirs('.purge-trash').filter((d) => d.isDirectory())
  let trashMd = 0
  for (const d of trashDirs) { try { trashMd += fs.readdirSync(path.join(root, '.purge-trash', d.name)).filter((f) => f.endsWith('.md')).length } catch { /* skip */ } }
  const files = ['active-days.jsonl', 'injection-ledger.jsonl', 'write-receipts.jsonl', '.sweep-log.jsonl', '.decay-audit.jsonl', '.decay-startup.jsonl', '.chain-audit.jsonl',
    ...listDirs('events').filter((d) => d.isFile() && d.name.endsWith('.jsonl')).map((d) => path.join('events', d.name))]
  let badLines = 0; const badFiles = []
  for (const f of files) {
    const r = readJsonl(f)
    if (r.bad.length) { badLines += r.bad.length; badFiles.push(`${f}:${r.bad.length}`) }
  }
  let pkg = null; let commit = null
  try { pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf-8')).version } catch { /* skip */ }
  try { commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf-8' }).trim() } catch { /* skip */ }
  const status = residue.length || trashMd || badLines ? 'red' : 'green'
  return {
    status,
    metrics: { tombstones: tomb.length, tombstoneResidue: residue.length, purgeTrashMd: trashMd, badJsonlLines: badLines, badFiles, packageVersion: pkg, repoCommit: commit },
    notes: [
      ...(residue.length ? [`墓碑残留: ${residue.slice(0, 8).join(', ')}`] : []),
      ...(trashMd ? [`purge 残留正文 ${trashMd} 个`] : []),
      ...(badLines ? [`坏行: ${badFiles.join(', ')}`] : []),
      '鉴权/访问日志当前不落盘（宿主层），本探针不观测',
    ],
    evidence: ['events/*.jsonl', '.purge-trash/', 'write-receipts.jsonl'],
  }
})

// ── 汇总 ────────────────────────────────────────────────────
if (chainRes) sections.P5.metrics.chainMs = chainMs
if (sections.P9) sections.P9.metrics.probeTotalMs = Date.now() - probeStart
const statuses = Object.fromEntries(Object.entries(sections).filter(([k]) => k !== 'M0').map(([k, v]) => [k, v.status]))
const summary = { green: 0, yellow: 0, red: 0, error: 0 }
for (const s of Object.values(statuses)) summary[s] = (summary[s] ?? 0) + 1
const report = {
  probe: 'breathe-probes', version: 1,
  root, at: new Date(now).toISOString(), matrix: matrixPath,
  matrixCoverage: sections.M0?.metrics ?? null,
  sections, summary,
  ok: summary.red === 0 && summary.error === 0,
}
delete report.sections.M0 // M0 只做覆盖检查，不参与 10 探针统计

const outText = JSON.stringify(report, null, 2)
if (outPath) { try { fs.writeFileSync(path.resolve(outPath), outText + '\n', 'utf-8') } catch (e) { console.error(`[probe] 写报告失败: ${String(e)}`) } }
if (jsonOnly) process.stdout.write(outText + '\n')
else {
  console.log(`Breathe probes @ ${root}`)
  console.log(`matrix: ${report.matrixCoverage?.dimensions ?? '?'} 维 / 未映射 ${report.matrixCoverage?.unmapped ?? '?'}`)
  for (const [k, v] of Object.entries(report.sections)) {
    console.log(`${v.status.padEnd(6)} ${k.padEnd(3)} ${v.notes?.[0] ?? ''}`)
  }
  console.log(`summary: green=${summary.green} yellow=${summary.yellow} red=${summary.red} error=${summary.error}`)
}
process.exit(report.ok ? 0 : 1)
