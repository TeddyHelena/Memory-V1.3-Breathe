#!/usr/bin/env node
/**
 * refresh-index-summary.mjs —— 把条目文件 frontmatter 的 summary 回填进 index.json
 *
 * 为什么需要（2026-09-30 实测）：
 *   装配读的是 **index.json**，不是条目文件。直接改文件的 summary 后重启，
 *   线上仍是旧值 —— 这就是 V1.2 那个「双真源」的形状：文件改了、索引没跟上。
 *
 * 与 backfill-index.mjs 的关系：那个只补 scope/status 族（temporalState 靠它们算），
 *   **不含 summary**。本脚本补的正是 summary 这一格。
 *
 * 归属原则（V1.2 不变量 I-2）：**frontmatter 是唯一真源，索引只是它的投影。**
 *   所以方向永远是「文件 → 索引」，不反向。
 *
 * 安全：只改 index.json，**不碰任何条目文件**；写前自动备份；走容器自身 saveIndex（原子写）。
 *
 * 用法：
 *   node scripts/refresh-index-summary.mjs --root <容器目录> [--dry]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { assertIndexLogCompacted } from './lib/index-log-guard.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const libDir = path.join(here, '..', 'lib')
const argv = process.argv.slice(2)
const flag = (n, d) => { const at = argv.indexOf(`--${n}`); return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : d }

const root = flag('root', '')

// 【Audit】第二写入者护栏：有待折平的增量日志就拒跑（⛔ 不是警告一下继续）
assertIndexLogCompacted(root, 'refresh-index-summary.mjs')

const dry = argv.includes('--dry')
if (!root) { console.error('用法: node scripts/refresh-index-summary.mjs --root <容器目录> [--dry]'); process.exit(2) }

const { MemoryContainer } = await import(pathToFileURL(path.join(libDir, 'container.js')).href)

const c = new MemoryContainer(root)
c.load({ verify: false })
const index = c.getIndex()

let changed = 0, same = 0, missing = 0
const samples = []

for (const entry of index.entries) {
  const file = c.readEntry(entry.id)
  if (!file) { missing++; console.log(`  ⚠️ 读不到条目文件: ${entry.id} (${entry.file})`); continue }
  // readEntry 走容器自己的解析器（与插件同一套字段映射），不重复实现
  const fromFile = String(file.frontmatter.summary ?? '')
  const inIndex = String(entry.summary ?? '')
  if (fromFile === inIndex) { same++; continue }
  changed++
  if (samples.length < 8) samples.push({ id: entry.id, before: inIndex.slice(0, 40), after: fromFile.slice(0, 40), from: inIndex.length, to: fromFile.length })
  entry.summary = fromFile
}

console.log(`条目 ${index.entries.length} 条：需更新 ${changed} / 已一致 ${same} / 读不到 ${missing}`)
for (const s of samples) console.log(`  ${s.id}  ${s.from}→${s.to} 字  「${s.before}」→「${s.after}」`)

if (dry) { console.log('\n[dry] 未写入。去掉 --dry 才真正落盘。'); process.exit(0) }
if (changed === 0) { console.log('\n无变化，不写盘。'); process.exit(0) }

const idxPath = path.join(root, 'index.json')
const bak = `${idxPath}.bak-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)}-summary-refresh`
fs.copyFileSync(idxPath, bak)
console.log(`\n索引备份: ${path.basename(bak)}`)
c.saveIndex()
console.log(`已写 index.json（${changed} 条 summary 从文件回填）`)
