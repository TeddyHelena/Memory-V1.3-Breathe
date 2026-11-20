#!/usr/bin/env node
/**
 * backfill-decay-fields.mjs —— 存量条目衰减字段回填（V1.3-A · G2）
 *
 * ── 治的是什么 ──────────────────────────────────────────────────────
 * 衰减引擎（V1.3-B）读 `decay_type` / `last_accessed`。存量里有条目**两侧都没有**这两个字段
 * （不是索引陈旧，是文件里压根没写）—— 引擎读不到就只能当"未分类"，
 * 而**未分类的条目会静默按某个默认曲线走**，标定出来的参数就是在拟合错的集合。
 *
 * 实测（2026-10-09，真身 112 条）：
 *   · `decay_type` 缺 **11 条**（`l-e01`~`l-e09` 证据条目 ＋ `p04` ＋ `p07`）
 *   · `last_accessed` 缺 **1 条**（`p07`）
 *   · `source` 14 条 / `summary` 2 条 ⇒ **不可重建**，本脚本⛔不碰（见下"三档口径"）
 *
 * ── 三档口径（与 `contract/fields.ts` 的 `absence` 一一对应）──────────
 *   漂移（索引陈旧）→ `repair-index-projection.mjs` 回正
 *   **缺口（能真回填）→ 本脚本**：`decay_type` / `last_accessed`
 *   遗留（不可重建）→ ⛔ 谁都不动。编一个值糊上才是真丢东西
 *
 * ── 取值规则（⚠️ 全部来自既有实现或实测分布，⛔ 不许现编）────────────
 *   · `decay_type`：调 `ingest.classifyDecayType({ operation })`——**与写入路径同一处实现**
 *     （`propose`→`process`，其余→`recent`，`core` 只能显式给）。⛔ 不在这里另写映射表。
 *   · `last_accessed`：09-23 已拍板的**分层回填**（原方案，口径按 0–100 重推）：
 *       高 priority（≥ `HIGH_PRIORITY`）→ 锚 `now`（视为仍在用）
 *       有访问史（`access_count > 0`）→ 按次数回推 —— ⚠️ **目前没有样本，缺公式**，
 *          遇到就**报出来并跳过**（⛔ 不拍一个公式糊过去）
 *       其余（冷条目）→ 回推 `COLD_BACKDATE_DAYS` 天
 *     并给该条目打 `cold_start_until = now + COLD_START_DAYS 天`（**回填出来的时间不可采信**）
 *   · `lifecycle` 缺 12 条：**刻意不填** —— 它的缺省语义（`active`）已登记在注册表里，
 *     写进文件等于"拿默认值静默顶替"，而它并不是缺口。
 *
 * `HIGH_PRIORITY = 92` 的来源：真身 112 条 priority 实测 55~98，**p75 = 92**（不是拍的）。
 * 原方案写的是 `priority >= 5`（1–5 刻度），本仓口径是 0–100，故按实测分位重推。
 *
 * ── 用法 ────────────────────────────────────────────────────────────
 *   node scripts/backfill-decay-fields.mjs --root <容器>            # dry-run
 *   node scripts/backfill-decay-fields.mjs --root <容器> --apply
 *
 * 幂等：**触发条件就是"字段两侧都缺"** ⇒ 填过之后再跑必然是 0 处（跑第二遍零改动即为验收判据）。
 * 安全：--apply 要求已有备份（同 repair 脚本的护栏）；写盘走容器自己的 `stampV12Fields`
 *       （只写 V1.2 字段，**不动 `updated` 与 `checksum`** —— 回填不是内容修订，不许改修订日期）。
 */

import fs from 'node:fs'
import path from 'node:path'

import { MemoryContainer } from '../lib/container.js'
import { classifyDecayType } from '../lib/ingest.js'
import { assertIndexLogCompacted } from './lib/index-log-guard.mjs'

// 判据与"哪些字段算缺口"来自注册表（单一真源）。构建缺失时拒绝运行，⛔ 不内置备用表。
let fieldsMod
try {
  fieldsMod = await import('../lib/contract/fields.js')
} catch {
  console.error('❌ 未构建：本脚本的缺口判据来自 src/contract/fields.ts。先跑 `npm run build:host` 再执行。')
  process.exit(2)
}
const { FIELD_REGISTRY, diffEntryFields } = fieldsMod

const arg = (n, d = '') => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : d }
const ROOT = arg('root') || process.env.MEMORY_CONTAINER_ROOT || ''
const APPLY = process.argv.includes('--apply')
if (!ROOT) { console.error('用法：node scripts/backfill-decay-fields.mjs --root <容器> [--apply]'); process.exit(2) }

assertIndexLogCompacted(ROOT, 'backfill-decay-fields.mjs')

const parent = path.dirname(path.resolve(ROOT))
if (APPLY) {
  const hasIdxBak = fs.readdirSync(ROOT).some((n) => n.startsWith('index.json.bak-'))
  const hasDirBak = fs.readdirSync(parent).some((n) => n.startsWith(`${path.basename(ROOT)}.bak-`))
  if (!hasIdxBak && !hasDirBak) {
    console.error(`❌ --apply 被拒绝：没有备份。先备份 ${ROOT}（或至少 index.json）再来。`)
    process.exit(2)
  }
}

// ── 常量（全部有出处，见文件头）──────────────────────────────────
const HIGH_PRIORITY = 92          // 真身 p75 实测
const COLD_BACKDATE_DAYS = 180    // 09-23 已拍板方案
const COLD_START_DAYS = 30        // 09-23 已拍板方案（≈ 冷启动豁免期）
const DAY_MS = 24 * 60 * 60 * 1000

/** 注册表里"能真回填"的字段（⛔ 不在这里另写一份清单） */
const GAP_FIELDS = FIELD_REGISTRY.filter((f) => f.absence === 'gap').map((f) => f.name)

/** 每个缺口字段的取值规则。注册表新增 gap 字段而这里没有规则 ⇒ 直接停下报错（⛔ 不静默跳过） */
function valueFor(fieldName, entry, now) {
  if (fieldName === 'decay_type') {
    // 与写入路径同一处实现：propose→process，其余→recent，core 只能显式给
    return { value: classifyDecayType({ operation: entry.operation }), note: `按 operation=${entry.operation ?? '(无)'} 推定` }
  }
  if (fieldName === 'last_accessed') {
    const pri = Number(entry.priority)
    if (Number.isFinite(pri) && pri >= HIGH_PRIORITY) {
      return { value: new Date(now).toISOString(), note: `高 priority（${pri} ≥ ${HIGH_PRIORITY}）⇒ 锚 now`, coldStart: true }
    }
    const ac = Number(entry.access_count)
    if (Number.isFinite(ac) && ac > 0) {
      return { unfillable: `有访问史（access_count=${ac}）但无 last_accessed：回推公式**尚未定**，⛔ 不拍一个糊过去 —— 请人工裁` }
    }
    return { value: new Date(now - COLD_BACKDATE_DAYS * DAY_MS).toISOString(), note: `冷条目 ⇒ 回推 ${COLD_BACKDATE_DAYS} 天`, coldStart: true }
  }
  return { unfillable: `注册表登记 ${fieldName} 为可回填缺口，但本脚本没有它的取值规则 —— 停下人工定（⛔ 不静默跳过）` }
}

const now = Date.now()
const container = new MemoryContainer(ROOT)
container.load()
const index = container.getIndex()

const planned = []
const unfillable = []
let skippedLegacy = 0
for (const e of index.entries) {
  const file = container.readEntry(e.id)
  if (!file) continue
  const raw = file.raw ?? file.frontmatter
  const diffs = diffEntryFields(e.id, e, raw)   // 判一次，别判两遍（两遍就可能不一致）
  const gaps = diffs.filter((d) => d.kind === 'both-missing' && GAP_FIELDS.includes(d.field))
  skippedLegacy += diffs.filter((d) => d.kind === 'legacy-missing').length
  if (gaps.length === 0) continue
  const patch = {}
  const notes = []
  let coldStart = false
  for (const g of gaps) {
    const r = valueFor(g.field, e, now)
    if (r.unfillable) { unfillable.push({ id: e.id, field: g.field, why: r.unfillable }); continue }
    patch[g.field] = r.value
    notes.push(`${g.field}=${JSON.stringify(r.value)}（${r.note}）`)
    if (r.coldStart) coldStart = true
  }
  if (Object.keys(patch).length === 0) continue
  if (coldStart) {
    patch.cold_start_until = new Date(now + COLD_START_DAYS * DAY_MS).toISOString()
    notes.push(`cold_start_until=+${COLD_START_DAYS}天（回填时间不可采信，打标记）`)
  }
  planned.push({ id: e.id, patch, notes })
}

console.log(`容器：${ROOT}`)
console.log(`模式：${APPLY ? '【真写】' : 'dry-run（默认，不写盘）'}`)
console.log(`缺口字段（注册表 absence='gap'）：${GAP_FIELDS.join(' / ')}`)
console.log(`需要回填：${planned.length} 条　｜　不可重建（登记为 legacy，⛔ 本脚本不碰）：${skippedLegacy} 处\n`)
for (const p of planned) {
  console.log(`  ${p.id}`)
  for (const n of p.notes) console.log(`     ${n}`)
}
if (unfillable.length > 0) {
  console.log(`\n❌ 无法回填（缺规则，需人工裁）：${unfillable.length} 处`)
  for (const u of unfillable) console.log(`   ${u.id} · ${u.field}：${u.why}`)
}

if (planned.length === 0 && unfillable.length === 0) { console.log('\n无缺口，无需处理。'); process.exit(0) }
if (unfillable.length > 0) { console.log('\n⛔ 有字段缺取值规则，本次**拒绝写入**（先定规则再跑）。'); process.exit(2) }
if (!APPLY) { console.log('\n以上为预演。确认无误后加 --apply 真写。'); process.exit(0) }

// ── 真写：走容器的 stampV12Fields（只写 V1.2 字段，不动 updated / checksum）──
for (const p of planned) {
  container.stampV12Fields(p.id, p.patch, { saveIndex: false })
  console.log(`  ✅ ${p.id} ← ${Object.keys(p.patch).join(', ')}`)
}
container.saveIndex()
console.log(`\n完成：回填 ${planned.length} 条，索引已落盘。`)

// ── 写后自检：**换一个新容器重跑缺口判据**（不是拿内存对象自证）──
const again = new MemoryContainer(ROOT)
again.load()
const left = []
for (const e of again.getIndex().entries) {
  const f = again.readEntry(e.id)
  if (!f) continue
  for (const d of diffEntryFields(e.id, e, f.raw ?? f.frontmatter)) {
    if (d.kind === 'both-missing' && GAP_FIELDS.includes(d.field)) left.push(`${d.id}.${d.field}`)
  }
}
console.log(left.length === 0 ? '自检：可回填缺口已归零 ✅' : `自检：仍缺 ${left.length} 处 ❌ ${JSON.stringify(left.slice(0, 5))}`)
process.exit(left.length === 0 ? 0 : 1)
