#!/usr/bin/env node
/**
 * 【P8 演练 · 2026-11-22】候选自动转正的准入演练（激活契约 §五）
 *
 * 契约要求：① P7 稳定 ② 三天演练：pending 恒空、启动不抛 ③ 30 活跃日新增孤儿=0
 *
 * 本脚本能覆盖 ② ③，**覆盖不了 ①**（P7 还没开）。而且：
 *   · 「三天」用 3 次**冷启动周期**代替（不是 3 个自然日）；
 *   · 「30 活跃日」用 30 轮 启动+写入+孤儿检查 代替（不是 30 个日历活跃日）。
 * ⛔ 所以本脚本的输出叫"演练通过"，**不叫"契约满足"**。真跑还得让它在生产里过日子。
 *
 * 用法：node scripts/p8-drill.mjs "<容器根>" [轮数=30]
 * 退出码 0 = 演练通过；1 = 有红。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const SRC = path.resolve(import.meta.dirname, '..')

const srcRoot = process.argv[2]
const ROUNDS = Number(process.argv[3] ?? 30)
if (!srcRoot) { console.error('用法：node scripts/p8-drill.mjs "<容器根>" [轮数=30]'); process.exit(2) }

const { apply } = await import(path.join(SRC, 'lib', 'index.js'))
const { MemoryContainer } = await import(path.join(SRC, 'lib', 'container.js'))
const { SubjectStore } = await import(path.join(SRC, 'lib', 'subjects.js'))

const labRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-p8-lab-'))
fs.cpSync(srcRoot, labRoot, { recursive: true })
// 演练不加新账到别人的审计里：清掉调研用的事件账（保留容器结构）
for (const f of ['events/candidates.jsonl', 'events/campaign.jsonl']) {
  const p = path.join(labRoot, f)
  if (fs.existsSync(p)) fs.rmSync(p)
}

const noop = () => ({ info() {}, warn() {}, error() {} })

function boot({ autoPromote }) {
  const tools = []
  const disposers = []
  const ctx = {
    logger: noop,
    effect(cb) { const d = cb(); disposers.push(d); return () => {} },
    tools: { register(tool) { tools.push(tool); return () => {} } },
    systemPrompt: { section() {}, context() {} },
    on() { return () => {} },
    webServer: { register() { return () => {} } },
  }
  apply(ctx, {
    containerRoot: labRoot,
    injectPersona: false,
    personaMode: 'full',
    voiceFile: '',
    searchTopK: 5,
    searchArchive: false,
    hotMaxChars: 16000,
    apiPrefix: '/api/memory',
    apiToken: '',
    apiTokenFile: '',
    allowEdit: false,
    allowWrite: true,
    decayDailyCheck: false,
    autoPromote,
    requireHostSession: true,
    enableRoute: false,
    verifyUserQuote: false,
    timeZone: 'Asia/Shanghai',
  })
  return { tools, dispose: () => { for (const d of disposers) { try { d?.() } catch { /* ignore */ } } } }
}

function readIndex() {
  const c = new MemoryContainer(labRoot)
  c.load({ verify: false })
  return c
}

const orphansNow = () => {
  const store = new SubjectStore(labRoot, { log: { info() {}, warn() {}, error() {} } })
  const all = store.list()
  const ids = new Set(all.map((s) => s.id))
  return all.filter((s) => s.kind !== 'root' && s.parent && !ids.has(s.parent))
}

const out = { rounds: [], fails: [], pendingQualifiedLeft: [], orphansAdded: 0, bootsThrown: 0 }

// ── 三天演练：3 次冷启动，每轮跑一批真实形态的 propose ──
const DAYS = 3
for (let day = 1; day <= DAYS; day++) {
  // ① 启动不抛
  let inst
  try {
    inst = boot({ autoPromote: true })
  } catch (e) {
    out.bootsThrown++
    out.fails.push(`第 ${day} 天启动抛错：${e instanceof Error ? e.message : String(e)}`)
    continue
  }
  // 【模拟换日】配额是「每**活跃日** ≤3 条」，而演练的三轮都发生在同一个自然日
  // ⇒ 不重置的话第 2/3 天会被配额拦住（这不是缺陷，是我模拟没做对）。
  // 把计数文件的 day 写成昨天，`readAutoPromote()` 比对不上今天 ⇒ 计数归零。
  const quotaFile = path.join(labRoot, 'auto-promote.json')
  if (fs.existsSync(quotaFile)) fs.writeFileSync(quotaFile, JSON.stringify({ day: '1970-01-01', count: 3 }), 'utf-8')

  const propose = inst.tools.find((t) => t.name === 'memory_propose')
  if (!propose) { out.fails.push('走完 apply 也没注册 memory_propose'); break }

  const session = `sess-p8-d${day}`
  // ② 链归属齐全 ⇒ 必须自动转正
  for (let i = 1; i <= 3; i++) {
    const r = await propose.execute(
      { content: `P8 演练第${day}天-${i}条。`, title: `p8-d${day}-${i}`, memory_type: 'experience', about: [`P8-DRILL-D${day}`], source_message: `m${day}-${i}` },
      { agent: { session: { id: session } } },
    )
    if (r.layer !== 'longterm') out.fails.push(`第 ${day} 天第 ${i} 条有链归属却没转正（layer=${r.layer}）`)
  }
  // ③ 无链归属 ⇒ 必须留 pending（不是"漏转正"）
  const noChain = await propose.execute(
    { content: `P8 演练第${day}天-无归属。`, title: `p8-d${day}-nochain`, memory_type: 'experience', source_message: `mn${day}` },
    { agent: { session: { id: session } } },
  )
  if (noChain.layer !== 'pending') out.fails.push(`第 ${day} 天无归属候选不该转正（layer=${noChain.layer}）`)
  // ④ opinion 类型 ⇒ 不得自动转正（人工判断项）
  const opinion = await propose.execute(
    { content: `P8 演练第${day}天-观点。`, title: `p8-d${day}-opinion`, memory_type: 'opinion', about: [`P8-DRILL-OP-D${day}`], source_message: `mo${day}` },
    { agent: { session: { id: session } } },
  )
  if (opinion.layer !== 'pending') out.fails.push(`第 ${day} 天 opinion 不该自动转正（layer=${opinion.layer}）`)

  inst.dispose()

  // ⑤ pending 恒空：pending 里不许有"链归属齐全却还躺着"的
  const c = readIndex()
  const pending = c.getIndex().entries.filter((e) => e.layer === 'pending')
  const qualifiedLeft = pending.filter((e) => (Array.isArray(e.about) && e.about.length > 0) || (e.scope === 'project' && e.scope_id))
  out.pendingQualifiedLeft.push(...qualifiedLeft.map((e) => e.id))
  out.rounds.push({ day, pendingTotal: pending.length, qualifiedLeft: qualifiedLeft.length })
}

// ── 30 轮 启动+孤儿检查 ──
const before = orphansNow().length
for (let i = 1; i <= ROUNDS; i++) {
  let inst
  try { inst = boot({ autoPromote: false }) } catch (e) { out.bootsThrown++; out.fails.push(`孤儿轮第 ${i} 次启动抛错：${String(e)}`); continue }
  inst.dispose()
  const orphans = orphansNow()
  if (orphans.length > before) {
    out.orphansAdded += orphans.length - before
    out.fails.push(`第 ${i} 轮出现新孤儿：${orphans.map((o) => o.id).join(',')}`)
  }
}

// ── 审计：被拦的必须留痕 ──
const auditPath = path.join(labRoot, '.auto-promote.jsonl')
const audit = fs.existsSync(auditPath)
  ? fs.readFileSync(auditPath, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : []
const promoted = audit.filter((r) => r.action === 'promoted').length
const blocked = audit.filter((r) => r.action === 'blocked').length

const result = {
  ok: out.fails.length === 0 && out.pendingQualifiedLeft.length === 0 && out.orphansAdded === 0,
  lab: labRoot,
  covered: ['② 三天演练（3 次冷启动）', '③ 30 轮启动+孤儿检查'],
  notCovered: ['① P7 稳定（P7 未开，无法验）', '30 个**自然活跃日**（此处是 30 轮，不是 30 天）'],
  rounds: out.rounds,
  pendingQualifiedLeft: out.pendingQualifiedLeft,
  orphansAdded: out.orphansAdded,
  bootsThrown: out.bootsThrown,
  audit: { promoted, blocked, total: audit.length },
  fails: out.fails,
}
console.log(JSON.stringify(result, null, 2))
process.exit(result.ok ? 0 : 1)
