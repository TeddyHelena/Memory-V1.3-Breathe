#!/usr/bin/env node
/**
 * repair-index-projection.mjs —— 把索引投影按唯一真源回正（2026-10-07 建 · 2026-10-09 V1.3-A 重写）
 *
 * ── 背景 ────────────────────────────────────────────────────────────
 * 2026-10-07 首次全量对账抓到 **18 处投影与真源不符**：
 *   · l-e01…l-e09 的 `tags`：文件 `["证据","拆分","h01"]`，索引少了 `h01`
 *     → 检索有「标签命中」这一路，**按 h01 检索时这九条命中不了**（真·漏召）
 *   · h01…h09 的 `updated`：文件 2026-09-30，索引停在 08-17/26/27
 * 闸门（223 项测试 + `verify:true`）**一条都没报** —— 因为 `validate(verify:true)`
 * 只查 id / layer / 文件存在性，不查 title / summary / updated / tags。
 *
 * ── 2026-10-09 重写（V1.3-A · G1）────────────────────────────────────
 * 上一版自带**第二份手写字段表**（8 个字段）与**第二份判定实现**，而且判定里写着
 * 「单侧有值 → 设计内，不动」—— 于是 `source`（索引缺 42 条）、`scope`（索引缺 9 条）
 * 这类**文件有、索引没有**的真漂移，它**一处都回正不了**（跑 dry-run 显示"需要回正 0 处"）。
 *
 * 现在：字段表与判定**都从 `contract/fields.ts` 来**（全仓唯一一处），
 * 本脚本只负责"把它报出来的真漂移写回索引"。
 *
 * ── 口径 ────────────────────────────────────────────────────────────
 * **frontmatter 是唯一真源，索引只是它的投影**（V1.2 不变量 I-2）。
 *   · `index-stale`：文件有、索引没有 → 把**文件的值**写进索引
 *   · `value-mismatch`：两侧都有但不一致 → 同上
 *   · `index-extra`：索引有、文件没有 → **删掉索引那个键**（文件没源可填）
 *     ⚠️ 等于登记默认值的 `index-extra` **不算漂移**（判定层已放过，如 `status='active'`），
 *     所以这里删的都是"索引凭空多出来的东西"。
 *   · `both-missing`：数据缺口，**本脚本不碰**（那是回填的活，见 G2）
 *
 * ── 用法 ────────────────────────────────────────────────────────────
 *   node scripts/repair-index-projection.mjs --root <容器>            # dry-run
 *   node scripts/repair-index-projection.mjs --root <容器> --apply
 *
 * 安全：--apply 要求同目录下存在 `index.json.bak-*`（人工先备份），否则拒绝。
 */

import fs from 'node:fs'
import path from 'node:path'

import { MemoryContainer } from '../lib/container.js'
// 【V1.3-A · G1】判据来自 `src/contract/fields.ts`（随构建产出 lib 版）。
// ⚠️ 构建产物缺失时**拒绝运行**（不是退回内置表）：两份判据必然静默分叉——历史上就这么烂过。
let fieldsMod
try {
  fieldsMod = await import('../lib/contract/fields.js')
} catch {
  console.error('❌ 未构建：本脚本的判据来自 src/contract/fields.ts。先跑 `npm run build:host` 再执行。')
  process.exit(2)
}
const { diffEntryFields, REAL_DRIFT_KINDS } = fieldsMod
import { assertIndexLogCompacted } from './lib/index-log-guard.mjs'

const arg = (n, d = '') => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : d }
const ROOT = arg('root') || process.env.MEMORY_CONTAINER_ROOT || ''

// 【Audit】第二写入者护栏：有待折平的增量日志就拒跑（⛔ 不是警告一下继续）
assertIndexLogCompacted(ROOT, 'repair-index-projection.mjs')

const APPLY = process.argv.includes('--apply')
if (!ROOT) { console.error('用法：node scripts/repair-index-projection.mjs --root <容器> [--apply]'); process.exit(2) }

const parent = path.dirname(path.resolve(ROOT))
if (APPLY) {
  const hasIdxBak = fs.readdirSync(ROOT).some((n) => n.startsWith('index.json.bak-'))
  const hasDirBak = fs.readdirSync(parent).some((n) => n.startsWith(`${path.basename(ROOT)}.bak-`))
  if (!hasIdxBak && !hasDirBak) {
    console.error(`❌ --apply 被拒绝：既没有 ${ROOT}/index.json.bak-*，也没有 ${parent}/${path.basename(ROOT)}.bak-*。先备份。`)
    process.exit(2)
  }
}

/** 扫描一遍，返回真漂移清单（判定全部来自 contract/fields.ts，本脚本不另写判据） */
function scan(container) {
  const index = container.getIndex()
  const planned = []
  for (const e of index.entries) {
    const file = container.readEntry(e.id)
    if (!file) continue
    const raw = file.raw ?? file.frontmatter
    for (const d of diffEntryFields(e.id, e, raw)) {
      if (REAL_DRIFT_KINDS.includes(d.kind)) planned.push(d)
    }
  }
  return planned
}

const container = new MemoryContainer(ROOT)
container.load()
const planned = scan(container)

const KIND_CN = { 'index-stale': '索引陈旧（文件有·索引无）', 'index-extra': '索引多出（索引有·文件无）', 'value-mismatch': '两侧不一致' }
const byKind = {}
for (const p of planned) byKind[p.kind] = (byKind[p.kind] ?? 0) + 1

console.log(`容器：${ROOT}`)
console.log(`模式：${APPLY ? '【真写】' : 'dry-run（默认，不写盘）'}`)
console.log(`判据：contract/fields.ts（全仓唯一一处）`)
console.log(`需要回正：${planned.length} 处　${Object.entries(byKind).map(([k, v]) => `${KIND_CN[k] ?? k} ${v}`).join(' ｜ ') || ''}\n`)
for (const p of planned) {
  console.log(`  ${p.id} · ${p.field}　[${KIND_CN[p.kind] ?? p.kind}]`)
  console.log(`     索引 ${JSON.stringify(p.fromIndex)}`)
  console.log(`     文件 ${JSON.stringify(p.fromFile)}   ← 唯一真源，按此回写`)
}

if (planned.length === 0) { console.log('无差异，无需处理。'); process.exit(0) }
if (!APPLY) { console.log('\n以上为预演。确认无误后加 --apply 真写。'); process.exit(0) }

// 回写：按 id 聚合，一次 syncEntryMeta
const byId = new Map()
for (const p of planned) {
  if (!byId.has(p.id)) byId.set(p.id, {})
  // index-extra（索引有、文件无）⇒ 置 undefined 把那个键删掉；其余按文件值写
  byId.get(p.id)[p.field] = p.kind === 'index-extra' ? undefined : p.fromFile
}
for (const [id, patch] of byId) {
  container.syncEntryMeta(id, patch)
  console.log(`  ✅ ${id} ← ${Object.entries(patch).map(([k, v]) => `${k}=${v === undefined ? '(删)' : JSON.stringify(v)}`).join(', ')}`)
}
container.saveIndex()
console.log(`\n完成：回正 ${planned.length} 处，索引已落盘。`)

// 写后自检：**换一个新容器重跑同一判据**（不是拿内存里的对象自证）
const again = new MemoryContainer(ROOT)
again.load()
const leftovers = scan(again)
console.log(leftovers.length === 0
  ? '自检：投影与真源已一致 ✅'
  : `自检：仍有 ${leftovers.length} 处 ❌ ${JSON.stringify(leftovers.slice(0, 5).map((d) => `${d.id}.${d.field}:${d.kind}`))}`)
process.exit(leftovers.length === 0 ? 0 : 1)
