#!/usr/bin/env node
/**
 * repair-tombstone-titles.mjs —— 存量墓碑脱敏（一次性修复，2026-10-07 Teddy 授权）
 *
 * ── 为什么要单独一个脚本 ────────────────────────────────────────────
 * S1（MemoryV1.2-Sealed）修的是"**往后不再产生**"：新写入的墓碑标题是中性标识、
 * 文件名只用 id。**存量不会被自动改写** —— 而存量里确实有残留：
 * 早年 forget 只清正文与摘要（连摘要都是后来才补的），标题与文件名原样留着，
 * 而标题兜底取自正文前 40 字 = **它本来就是内容**。
 *
 * 已确认的残留（2026-10-06 扫描）：p01 / l60 / p07 / p09 四条墓碑，
 * 标题与文件名里都带着当年的原文。
 *
 * ── 这个脚本只做三件事，且只碰墓碑 ──────────────────────────────────
 *   ① frontmatter.title → 中性标识（规则**从 writer.ts 导入**，不在本文件重写一遍）
 *   ② 文件名 → `<id>.md`（仅对文件名里带标题的墓碑；可 --no-rename 关掉）
 *   ③ index.json 同步（title / file）
 *
 * **一律保留** deleted_at / deleted_by / delete_reason / supersedes / superseded_by /
 * version —— 只改标题与文件名。历史删除时间**不许被今天覆盖**：
 * 这正是"不能靠重跑一次 forget 来修"的原因（重跑会把 deleted_at 刷成今天，毁掉审计链）。
 *
 * ── 用法 ────────────────────────────────────────────────────────────
 *   node scripts/repair-tombstone-titles.mjs --root <容器>              # dry-run（默认）
 *   node scripts/repair-tombstone-titles.mjs --root <容器> --apply      # 真写
 *   node scripts/repair-tombstone-titles.mjs --root <容器> --apply --no-rename
 *
 * ── 安全约束（写死，不靠自觉）────────────────────────────────────────
 *   · 默认 dry-run，必须显式 --apply 才写盘
 *   · --apply 时**要求同目录下存在 `.bak-*` 备份**，否则拒绝（备份必须人工先做）
 *   · 只处理 `status==='expired'` 或带 `deleted_at` 的条目 —— 活条目一律不碰
 */

import fs from 'node:fs'
import path from 'node:path'

import { MemoryContainer } from '../lib/container.js'
import { TOMBSTONE_TITLE_PREFIX, tombstoneTitle } from '../lib/writer.js'
import { assertIndexLogCompacted } from './lib/index-log-guard.mjs'

const arg = (name, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback
}
const ROOT = arg('root') || process.env.MEMORY_CONTAINER_ROOT || ''

// 【Audit】第二写入者护栏 —— ⚠️ 必须在**任何提前退出之前**：
// 第一版把它放在扫描之后，结果"无事可做"那条路 `exit(0)` 先走了，护栏根本没跑到（实测抓到）。
// 口径：护栏是**入口条件**，不是"动手那一刻"的条件。
assertIndexLogCompacted(ROOT, 'repair-tombstone-titles.mjs')
const APPLY = process.argv.includes('--apply')
const RENAME = !process.argv.includes('--no-rename')

if (!ROOT) {
  console.error('用法：node scripts/repair-tombstone-titles.mjs --root <容器> [--apply] [--no-rename]')
  process.exit(2)
}

const parent = path.dirname(path.resolve(ROOT))
const hasBackup = fs.readdirSync(parent).some((n) => n.startsWith(`${path.basename(ROOT)}.bak-`))
if (APPLY && !hasBackup) {
  console.error(`❌ --apply 被拒绝：${parent} 下没有 ${path.basename(ROOT)}.bak-* 备份。先备份再动生产数据。`)
  process.exit(2)
}

const container = new MemoryContainer(ROOT)
container.load()
const index = container.getIndex()

const isTombstone = (e) => e.status === 'expired' || e.deleted_at !== undefined

const planned = []
for (const entry of index.entries) {
  if (!isTombstone(entry)) continue
  const id = String(entry.id)
  const title = String(entry.title ?? '')
  const base = path.basename(String(entry.file ?? ''), '.md')
  const at = String(entry.deleted_at ?? entry.updated ?? '')
  const want = tombstoneTitle(id, at)

  const titleDirty = !title.startsWith(TOMBSTONE_TITLE_PREFIX)
  const nameDirty = RENAME && base !== id
  if (!titleDirty && !nameDirty) continue

  planned.push({
    id, title, want, file: entry.file, nameDirty, titleDirty,
    newFile: nameDirty ? `${entry.layer}/${id}.md` : entry.file,
  })
}

console.log(`容器：${ROOT}`)
console.log(`模式：${APPLY ? '【真写】' : 'dry-run（默认，不写盘）'}${RENAME ? '' : ' ｜ 不改名'}`)
console.log(`条目 ${index.entries.length} 条，其中墓碑 ${index.entries.filter(isTombstone).length} 条`)
console.log(`需要处理：${planned.length} 条\n`)

for (const p of planned) {
  console.log(`  ${p.id}`)
  console.log(`    标题: ${JSON.stringify(p.title)}`)
  console.log(`      →   ${JSON.stringify(p.want)}`)
  if (p.nameDirty) console.log(`    文件名: ${p.file}\n      →   ${p.newFile}`)
}

if (planned.length === 0) {
  console.log('无残留，无需处理。')
  process.exit(0)
}
if (!APPLY) {
  console.log('\n以上为预演。确认无误后加 --apply 真写。')
  process.exit(0)
}

// ── 真写：改文件头 + 改名 + 同步索引 ────────────────────────────────
let changed = 0
for (const p of planned) {
  const entry = container.readEntry(p.id)
  if (!entry) { console.warn(`  ⚠️ ${p.id} 读不到，跳过`); continue }

  const fm = { ...entry.frontmatter, title: p.want }
  const absOld = path.join(ROOT, p.file)
  const absNew = path.join(ROOT, p.newFile)

  // ① 先写内容（若改名，写到新路径；否则原地重写）
  if (p.nameDirty) {
    if (fs.existsSync(absNew)) { console.warn(`  ⚠️ ${p.id} 目标文件已存在，跳过改名`); continue }
    fs.writeFileSync(absNew, container.serializeEntryFile(fm, entry.content), { mode: 0o600 })
    fs.unlinkSync(absOld)
  } else {
    container.atomicWrite(absOld, container.serializeEntryFile(fm, entry.content))
  }

  // ② 索引同步：title 走内存元数据，file 只在真改名时动
  container.syncEntryMeta(p.id, { title: p.want, ...(p.nameDirty ? { file: p.newFile } : {}) })
  changed++
  console.log(`  ✅ ${p.id} → title=${JSON.stringify(p.want)}${p.nameDirty ? `, file=${p.newFile}` : ''}`)
}

container.saveIndex()
console.log(`\n完成：处理 ${changed} 条，索引已落盘。`)

// ── 写后自检：整棵容器里不许再出现旧标题 ────────────────────────────
let leftover = 0
for (const p of planned) {
  for (const rel of [p.file, p.newFile]) {
    const abs = path.join(ROOT, rel)
    if (!fs.existsSync(abs)) continue
    if (fs.readFileSync(abs, 'utf-8').includes(p.title)) { console.warn(`  ⚠️ 残留: ${rel}`); leftover++ }
  }
}
const idxRaw = fs.readFileSync(path.join(ROOT, 'index.json'), 'utf-8')
for (const p of planned) if (idxRaw.includes(p.title)) { console.warn(`  ⚠️ 索引残留: ${p.title}`); leftover++ }
console.log(leftover === 0 ? '自检：无残留 ✅' : `自检：仍有 ${leftover} 处残留 ❌`)
process.exit(leftover === 0 ? 0 : 1)
