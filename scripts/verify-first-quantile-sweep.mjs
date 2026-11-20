#!/usr/bin/env node
/**
 * 首扫验收 · 纯分位 + 非对称地板（2026-10-16 Breathe）
 *
 * ## 什么时候跑
 * 新构建进宿主之后的**第一次真身扫描**之后（`.decay-audit.jsonl` 出现新批次）。
 * 用法：`node scripts/verify-first-quantile-sweep.mjs`
 *
 * ## 为什么单独立一支
 * 这套判据是**真身第一次**按"池内分位 + 非对称地板"动数据。判据全绿、dry-run 也过，
 * 但**真身写入路径**与 dry-run 之间隔着：审计 / 状态文件 / 层迁移 / 索引同步 / 回滚可达性。
 * ⇒ 这五样必须**逐条从盘上读回来验**（⛔ 不看内存、⛔ 不信"函数没报错"）。
 *
 * ## 判据（⛔ 先定后跑）
 *   ① 审计落盘：最新批次里每条 move 都有 `longterm → archive` 与 `at`
 *   ② 逐条对账：每条被搬的条目，**磁盘目录 == 索引 layer**（不是只看总数）
 *   ③ 新条目零误伤：**没有被搬的条目**曾写在最近 24 小时内（非对称地板要保护的那一族）
 *   ④ 回滚可达：该批次可在 `listRollbackBatches` 里查到（撤得回来）
 *   ⑤ 状态一致：`.decay-sweep.json` 的 lastBatch 与审计里最新批次一致
 *
 * ⛔ 只读：本脚本不写任何东西。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REPO = path.join(import.meta.dirname, '..')
const { MemoryContainer } = await import(`file://${path.join(REPO, 'lib', 'container.js')}`)
const { readAudit, listRollbackBatches } = await import(`file://${path.join(REPO, 'lib', 'decay-sweep.js')}`).catch(() => ({}))

const ROOT = process.argv.includes('--root')
  ? process.argv[process.argv.indexOf('--root') + 1]
  : path.join(os.homedir(), 'Documents', 'Obsidian Vault', '00_记忆系统', 'dsh-memory-container')

const rows = []
const add = (name, ok, detail) => rows.push({ name, ok, detail })
const DAY = 86400000

// ⛔ 只在副本上 open（生产容器不碰）—— 对账用副本 + 直接读生产盘，两不耽误
const prodIndex = JSON.parse(fs.readFileSync(path.join(ROOT, 'index.json'), 'utf8'))

// ① 审计
const auditPath = path.join(ROOT, '.decay-audit.jsonl')
let audit = []
if (fs.existsSync(auditPath)) {
  for (const line of fs.readFileSync(auditPath, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try { audit.push(JSON.parse(line)) } catch { /* 坏行单独报 */ }
  }
}
add('① 审计文件存在', fs.existsSync(auditPath), auditPath)
const batches = [...new Set(audit.map((r) => r.batch).filter(Boolean))]
const lastBatch = batches[batches.length - 1]
if (lastBatch) {
  const rowsOfBatch = audit.filter((r) => r.batch === lastBatch)
  const badShape = rowsOfBatch.filter((r) => r.from !== 'longterm' || r.to !== 'archive' || !r.at)
  add('① 最新批次形状正确', badShape.length === 0, `批次 ${lastBatch} · ${rowsOfBatch.length} 条 · 形状异常 ${badShape.length} 条`)
} else {
  add('① 审计里有批次', false, '审计里没有任何批次（还没扫过？）')
}

// ② 逐条对账（磁盘目录 vs 索引 layer）
const moved = lastBatch ? audit.filter((r) => r.batch === lastBatch) : []
let mismatch = []
for (const r of moved) {
  const e = prodIndex.entries.find((x) => x.id === r.id)
  if (!e) { mismatch.push(`${r.id}（索引里找不到）`); continue }
  if (e.layer !== 'archive') mismatch.push(`${r.id}（索引 layer=${e.layer}）`)
  const p = path.join(ROOT, e.file ?? '')
  if (!fs.existsSync(p)) mismatch.push(`${r.id}（文件不在 ${e.file}）`)
}
add('② 逐条对账：索引 layer=archive 且文件在位', mismatch.length === 0, mismatch.length ? mismatch.join(' · ') : `${moved.length} 条全部对上`)

// ③ 新条目零误伤：被搬的条目里不许有"最近 24 小时内写过/访问过"的
const now = Date.now()
const fresh = moved.filter((r) => {
  const e = prodIndex.entries.find((x) => x.id === r.id)
  const la = Date.parse(String(e?.last_accessed ?? ''))
  return Number.isFinite(la) && now - la < DAY
})
add('③ 新条目零误伤（24 小时内碰过的不许被搬）', fresh.length === 0, fresh.length ? fresh.map((r) => r.id).join(' · ') : '0 条')

// ④ 回滚可达
let rb = []
try { rb = await listRollbackBatches(ROOT) } catch (error) { rb = [`读取失败：${String(error.message).slice(0, 60)}`] }
const rollbackOk = Array.isArray(rb) && rb.some((b) => (typeof b === 'string' ? b === lastBatch : b?.batch === lastBatch))
add('④ 该批次可回滚（listRollbackBatches 里查得到）', rollbackOk, Array.isArray(rb) ? `批次列表 ${rb.length} 条` : String(rb[0]))

// ⑤ 状态文件一致
// ⚠️ 判据修正（2026-10-16 我在真身上先跑了一遍，发现**是判据错、不是系统错**）：
//    `审计`只记**真搬了东西**的批次；`moved: 0` 的那次扫描**不进审计**，
//    但它确实是"最后一次扫描"⇒ `state.lastBatch` 比审计最新批次**更新才对**。
//    第一版写成"必须相等" ⇒ 对一次 `moved:0` 的扫描**必然假红**。
// ⇒ 正确判据：state.lastBatch **不早于**审计最新批次（同为 `sweep-<时间基>`，可直接比串）。
let state = null
try { state = JSON.parse(fs.readFileSync(path.join(ROOT, '.decay-sweep.json'), 'utf8')) } catch { /* 缺/坏 */ }
const sb = state?.lastBatch ?? ''
const newer = !lastBatch || (sb !== '' && sb >= lastBatch)
add('⑤ 状态文件不落后于审计（允许领先：moved:0 的扫描不进审计）', newer,
  `state.lastBatch=${sb || '(缺)'} ／ audit=${lastBatch ?? '(无)'} ｜ state.lastCount=${state?.lastCount}`)
// ⑤b 若 state.lastBatch 恰好就是审计批次 ⇒ 计数必须对得上
if (sb && sb === lastBatch) {
  const n = audit.filter((r) => r.batch === sb).length
  add('⑤b 该批次的 lastCount == 审计条数', state?.lastCount === n, `state.lastCount=${state?.lastCount} ／ 审计 ${n} 条`)
}

console.log(`\n════ 首扫验收 ════\n容器 ${ROOT}\n`)
for (const r of rows) console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}  ｜ ${r.detail}`)
const failed = rows.filter((r) => !r.ok)
console.log(`\n结论：${failed.length === 0 ? '✅ 全部通过（真身首扫与判定一致、可回滚）' : `❌ ${failed.length} 项未过 —— ${failed.map((f) => f.name).join(' / ')}`}\n`)
process.exit(failed.length === 0 ? 0 : 1)
