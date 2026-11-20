#!/usr/bin/env node
/**
 * backfill-index.mjs —— 把条目 frontmatter 里的元数据回填进 index.json
 *
 * 为什么需要（压测评审清单 #2 的配套）：
 *   `/list` 原本为拿 scope / 有效期等字段**逐条读文件**（2000 条 = 1645ms）。
 *   字段进索引后 `/list` 变成零读盘，但**存量条目**的索引里没有这些字段——
 *   不填的话每次请求仍要为它们回退读文件。
 *
 * 幂等：已填过的条目会跳过（除非 --force）。可反复运行。
 * 默认值口径：`scope` 缺失补 `global`、`status` 缺失补 `active`（两者都是旧条目的隐含默认，
 *   且与 `temporalState()` / 前端渲染语义一致）；`memory_type` 缺失**不补**（无隐含默认）。
 * 安全：只改 index.json，**不碰任何条目文件**；写入走容器自身的 saveIndex（原子写）。
 *       运行前请自行备份容器（或用 scripts/with-container-copy.sh 先在副本上试）。
 *
 * 用法：
 *   node scripts/backfill-index.mjs --root <容器目录> [--dry] [--force]
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { assertIndexLogCompacted } from './lib/index-log-guard.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const libDir = path.join(here, '..', 'lib')
const argv = process.argv.slice(2)
const flag = (n, d) => {
  const at = argv.indexOf(`--${n}`)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : d
}
const root = flag('root')
const dryRun = argv.includes('--dry')
const force = argv.includes('--force')

// 【Audit】第二写入者护栏：有待折平的增量日志就拒跑（⛔ 不是警告一下继续）
assertIndexLogCompacted(root, 'backfill-index.mjs')


if (!root) {
  console.error('用法: node scripts/backfill-index.mjs --root <容器目录> [--dry] [--force]')
  process.exit(2)
}

const { MemoryContainer } = await import(pathToFileURL(path.join(libDir, 'container.js')).href)

/** 需要回填的字段（与 ContainerEntry 的 scope 族一致；temporalState 靠它们算） */
const FIELDS = ['scope', 'scope_id', 'valid_from', 'valid_to', 'expires', 'superseded_by', 'status']

const container = new MemoryContainer(path.resolve(root))
container.load()
const index = container.getIndex()

let filled = 0
let skipped = 0
const missingFiles = []

for (const entry of index.entries) {
  const needs = FIELDS.filter((f) => entry[f] === undefined)
  // status 旧条目本来就可能没有（视为 active），但既然要读文件，一并补上更省事
  if (needs.length === 0 && !force) {
    skipped++
    continue
  }
  const file = container.readEntry(entry.id)
  if (!file) {
    missingFiles.push(entry.id)
    continue
  }
  const fm = file.frontmatter
  // 只回填「索引里没有、文件里有」的；不覆盖已有值（避免把新写入的权威值改掉）
  if (entry.scope === undefined && fm.scope !== undefined) entry.scope = fm.scope
  if (entry.scope_id === undefined && fm.scope_id !== undefined) entry.scope_id = fm.scope_id
  if (entry.valid_from === undefined && fm.valid_from !== undefined) entry.valid_from = fm.valid_from
  if (entry.valid_to === undefined && fm.valid_to !== undefined) entry.valid_to = fm.valid_to
  if (entry.expires === undefined && fm.expires !== undefined) entry.expires = fm.expires
  if (entry.superseded_by === undefined && fm.superseded_by !== undefined) entry.superseded_by = fm.superseded_by
  if (entry.status === undefined && fm.status !== undefined) entry.status = fm.status
  // scope 缺失语义：文件也没写 → 显式写 global（旧条目默认），免得每次请求都当"缺字段"
  if (entry.scope === undefined) entry.scope = 'global'
  // status 缺失语义：文件也没写 → 显式写 active（旧条目默认）。
  // **这不是"随便补个默认值"**，依据是语义本来就这样，补的是显式化：
  //   - `temporalState()` 对缺 status 的条目按有效期正常判活，不报错不特殊处理；
  //   - 前端 `EntryPanel.tsx:224` 本来就按 `entry.status || 'active'` 渲染。
  // **不补的代价**（v1.1 增量④）：`/list` 的漂移判定是 `scope===undefined || status===undefined`，
  //   而这 52 条**文件里也没写 status**（实测：文件有 status 的仅 16 条 = 索引已有的 16 条），
  //   所以每次请求都为它们回退读文件、读回来的 status 仍是 undefined——纯浪费，且永久存在。
  // 注意：`memory_type` **不补默认值**——它没有"隐含默认"语义，编一个等于伪造分类。
  if (entry.status === undefined) entry.status = 'active'
  filled++
}

console.log(`容器: ${root}`)
console.log(`条目: ${index.entry_count} 条`)
console.log(`  回填: ${filled} 条`)
console.log(`  跳过: ${skipped} 条（已齐）`)
if (missingFiles.length) console.log(`  ⚠️ 文件缺失（未回填）: ${missingFiles.join(', ')}`)

if (dryRun) {
  console.log('\n[dry] 未写入。去掉 --dry 才真正落盘。')
  process.exit(0)
}

if (filled === 0) {
  console.log('\n无需回填，index.json 未改动。')
  process.exit(0)
}

// 落盘前校验：索引与文件必须一致（沿用容器契约），并同步 entry_count
container.recountEntries()
const check = container.hotOrderConsistency()
if (!check.ok) {
  console.error(`\n❌ 指针一致性未通过，拒绝落盘: ${check.problems.join('；')}`)
  process.exit(1)
}
container.saveIndex()
console.log(`\n✅ 已回填并落盘（entry_count=${container.getIndex().entry_count}）`)
