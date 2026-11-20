#!/usr/bin/env node
/**
 * repair-v12-fields.mjs —— 把索引里的 V1.2 五字段回填进条目文件（一次性修复）
 *
 * 为什么需要它（2026-10-03 查实）：
 *   `parseEntryFile` / `serializeEntryFile` 的白名单里漏登记了 V1.2 五字段，
 *   于是 `stampV12Fields`（路由 touch 落盘）写文件时把这五个字段**静默丢掉**：
 *   索引（派生）里 access_count 已经涨到 619，条目文件（真源）里一个都没有。
 *   白名单本身已随 ③ 接线补上，但**已经分叉的存量数据需要回填**：
 *   否则这五个值的唯一副本还在 index.json 里，索引一重建（回填 / 迁移 / 手工对齐）全部归零。
 *
 * ── 修法是外科手术式的（这一点比脚本本身重要）──────────────────────
 * **不重新序列化条目文件**。理由：serializeEntryFile 是白名单，
 * 整份重写会顺手吃掉它不认识的 frontmatter 字段（历史遗留 / 手工加的 / 未来加的），
 * 那等于用一次修复制造一次数据丢失。所以本脚本只做**行级插入/替换**：
 *   · 字段已存在 → 只替换那一行的值
 *   · 字段不存在 → 在 frontmatter 块末尾插一行
 *   · 其余字节（含正文、字段顺序、注释、空行）**一个都不动**
 * 证据要求：跑完 `diff -r` 只能看到这五行级别的增改。
 *
 * 用法：
 *   node scripts/repair-v12-fields.mjs --root <容器目录>              # 空跑（默认），只报告
 *   node scripts/repair-v12-fields.mjs --root <容器目录> --apply      # 真写，并自动留备份
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { assertIndexLogCompacted } from './lib/index-log-guard.mjs'

const FIELDS = ['decay_type', 'last_accessed', 'access_count', 'lifecycle', 'cold_start_until']

const argv = process.argv.slice(2)
const rootIdx = argv.indexOf('--root')
if (rootIdx < 0) {
  console.error('必须显式给 --root <容器目录>（不设默认值：这个脚本会改真实数据）')
  process.exit(2)
}
const ROOT = path.resolve(argv[rootIdx + 1])
const APPLY = argv.includes('--apply')

// 【Audit】第二写入者护栏：有待折平的增量日志就拒跑（⛔ 不是警告一下继续）
assertIndexLogCompacted(ROOT, 'repair-v12-fields.mjs')


const indexPath = path.join(ROOT, 'index.json')
if (!fs.existsSync(indexPath)) {
  console.error(`不是容器目录（缺 index.json）: ${ROOT}`)
  process.exit(2)
}
const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'))
if (index.schema !== 'harness-memory-container/v1') {
  console.error(`schema 不符: ${index.schema}`)
  process.exit(2)
}

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * 附加规则（2026-10-03 标定带出来的）：**转正却没重打标**。
 *
 * `decay_type = process` 是候选区的默认值（"可能是噪声，快衰"）；人工转正恰恰是
 * "它不是噪声"的裁断。`writer.confirm` 已修（转正即重打标），这里是**存量修复**：
 * 非 pending 层却还带 process 的条目 → recent。
 *
 * 为什么值得单独修：process 在打分里豁免新鲜度（w3_process = 0，0.4 的权重归零）。
 * 实测 p05（缓存塌陷根因，BM25 是第二名的 10 倍）因此被挤进候选区，
 * 而弱 10 倍的条目进了 main —— 一条人工确认过的记忆，被当成噪声排掉。
 */
function reclassify(meta) {
  return meta.layer !== 'pending' && meta.decay_type === 'process'
}

function repairFile(relFile, meta) {
  const abs = path.join(ROOT, relFile)
  if (!fs.existsSync(abs)) return { changes: [], error: '文件不存在' }
  const raw = fs.readFileSync(abs, 'utf-8')
  const lines = raw.split('\n')
  if (lines[0].trim() !== '---') return { changes: [], error: '首行不是 ---' }
  let end = -1
  for (let i = 1; i < lines.length; i++) if (lines[i].trim() === '---') { end = i; break }
  if (end < 0) return { changes: [], error: 'frontmatter 未闭合' }

  const changes = []
  const block = lines.slice(1, end)
  for (const f of FIELDS) {
    const value = f === 'decay_type' && reclassify(meta) ? 'recent' : meta[f]
    if (value === undefined || value === null || value === '') continue
    const at = block.findIndex((l) => new RegExp(`^${esc(f)}\\s*:`).test(l))
    if (at >= 0) {
      const old = block[at]
      const next = `${f}: ${value}`
      if (old.trim() !== next) changes.push({ kind: 'replace', field: f, from: old.trim(), to: next })
      block[at] = next
    } else {
      block.push(`${f}: ${value}`)
      changes.push({ kind: 'insert', field: f, to: `${f}: ${value}` })
    }
  }
  if (changes.length === 0) return { changes }
  const out = [lines[0], ...block, ...lines.slice(end)].join('\n')
  if (APPLY) {
    const tmp = `${abs}.tmp-repair-${process.pid}`
    fs.writeFileSync(tmp, out, 'utf-8')
    fs.renameSync(tmp, abs)
  }
  return { changes }
}

// ⚠️ **备份必须排在写入之前**（2026-10-03 踩过）：第一版把 `cp -a` 放在写入循环之后，
// 备份出来的是"文件已回填、索引还是旧的"的**混合态** —— 当不了回滚点，
// 而且名字看着像回滚点，比没有备份更危险。判据：备份里的文件必须还没有本次新增的字段。
let backupPath = null
if (APPLY) {
  backupPath = `${ROOT}.bak-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-repair-v12`
  execFileSync('cp', ['-a', ROOT, backupPath])
  console.log(`备份（写入前）: ${backupPath}`)
}

let touchedFiles = 0
let replaceCount = 0
let insertCount = 0
const errors = []
const samples = []
const reclassified = []
for (const meta of index.entries) {
  if (reclassify(meta)) {
    reclassified.push(meta.id)
    meta.decay_type = 'recent'   // 索引侧同步（只改文件 = 又造一次双真源分叉）
  }
  const { changes, error } = repairFile(meta.file, meta)
  if (error) { errors.push(`${meta.id}: ${error}`); continue }
  if (changes.length === 0) continue
  touchedFiles++
  for (const c of changes) c.kind === 'insert' ? insertCount++ : replaceCount++
  if (samples.length < 3) samples.push({ id: meta.id, changes })
}

console.log(`容器: ${ROOT}`)
console.log(`模式: ${APPLY ? '★ 真写（已自动备份）' : '空跑（不写任何东西）'}`)
console.log(`条目总数 ${index.entries.length}｜需要修的条目 ${touchedFiles}｜插入 ${insertCount} 行｜替换 ${replaceCount} 行`)
if (reclassified.length) console.log(`转正未重打标（process → recent）: ${reclassified.length} 条 —— ${reclassified.join(', ')}`)
for (const s of samples) {
  console.log(`  例 ${s.id}: ` + s.changes.map((c) => (c.kind === 'insert' ? `+${c.field}` : `~${c.field}`)).join(', '))
}
if (errors.length) {
  console.log(`⚠️ 读不了的条目 ${errors.length} 条：${errors.slice(0, 5).join('; ')}`)
}

if (!APPLY) {
  console.log('\n空跑结束。确认无误后加 --apply 真写（会先建 <容器>.bak-<时间戳> 备份）。')
  process.exit(0)
}

if (reclassified.length) {
  const tmp = `${indexPath}.tmp-repair-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2) + '\n', 'utf-8')
  fs.renameSync(tmp, indexPath)
  console.log('index.json 已同步（否则又是"文件改了、索引没改"）')
}
console.log('完成。建议立刻验证：① diff 只应有这几行变化 ② 用 verify:true 加载一次容器')
