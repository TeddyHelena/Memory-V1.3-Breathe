#!/usr/bin/env node
/**
 * scan-title-leaks.mjs —— 存量标题泄漏扫描（**只读，不改任何数据**）
 *
 * 背景（审计 P1-8 · 2026-10-06 S1）：
 *   隐私删除过去只清正文，**标题与文件名**都还留着从正文派生出来的内容。
 *   S1 修的是"往后不再产生"：墓碑标题换成中性标识、文件名只用 id。
 *   **但存量文件不会被自动改写** —— 本次刻意不做批量改名：
 *   改名要同时动 index.json 的 file 字段与全部引用，风险远大于收益。
 *   所以这里只报告，由人决定动不动。
 *
 * 报告三件事：
 *   ① 旧命名文件（`<id>_<标题>.md`）——文件名里带着内容；
 *   ② 墓碑（已删除）但标题仍不是中性标识的条目 —— "删了但没删干净"的存量；
 *   ③ 墓碑但摘要仍不是占位串的条目。
 *
 * 用法：
 *   node scripts/scan-title-leaks.mjs [containerRoot]
 *   缺省 containerRoot = ~/Documents/Obsidian Vault/00_记忆系统/dsh-memory-container
 *
 * 退出码恒为 0（这是报告，不是闸门）；有发现时打印条数。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TOMBSTONE_TITLE_PREFIX } from '../lib/writer.js'

// 中性标识规则从 writer.ts 导入（见文件顶部 import），不在本文件重写一遍 ——
// 两处各写一份的话，规则一改就会静默对不上（本仓反复踩过的"改一半"）。

const TOMBSTONE_SUMMARY = '（已删除：仅保留元数据）'

const root = process.argv[2]
  || path.join(os.homedir(), 'Documents', 'Obsidian Vault', '00_记忆系统', 'dsh-memory-container')

// 这个工具**故意**默认看真身（审计工具，审的就是生产）——但必须把"扫了哪里"印出来，
// 否则报告没法归因：同一份结论，扫生产与扫副本的含义完全不同（2026-10-09 安全审稿）。
console.log(`[scan-title-leaks] 扫描目标：${root}`)

const indexPath = path.join(root, 'index.json')
if (!fs.existsSync(indexPath)) {
  console.error(`找不到 index.json：${indexPath}`)
  process.exit(1)
}

// 【Audit · Ledger 适配】泄漏扫描必须看**真身**：直读 index.json 会读到落后于增量日志的快照
// ⇒ 刚被墓碑化的条目可能还"看起来"在索引里（或反过来，漏检）。用只读档（重放日志、不折平）。
const { MemoryContainer } = await import('../lib/container.js')
const _c = new MemoryContainer(root)
_c.load({ verify: false })
const index = _c.getIndex()
const entries = Array.isArray(index.entries) ? index.entries : []

const oldNaming = []
const tombstoneTitleLeaks = []
const tombstoneSummaryLeaks = []

for (const entry of entries) {
  const file = String(entry.file ?? '')
  const base = path.basename(file, '.md')

  // ① 旧命名：`<id>_<标题>`（新命名恒为 `<id>`）
  if (base !== String(entry.id ?? '')) oldNaming.push({ id: entry.id, file })

  // ② / ③ 墓碑残留
  const isTombstone = entry.status === 'expired' || entry.deleted_at !== undefined
  if (!isTombstone) continue
  const title = String(entry.title ?? '')
  if (!title.startsWith(TOMBSTONE_TITLE_PREFIX)) {
    tombstoneTitleLeaks.push({ id: entry.id, title, file })
  }
  if (entry.summary !== undefined && entry.summary !== TOMBSTONE_SUMMARY) {
    tombstoneSummaryLeaks.push({ id: entry.id, summary: String(entry.summary).slice(0, 40), file })
  }
}

const line = (s) => console.log(s)
line(`容器：${root}`)
line(`条目：${entries.length} 条`)
line('')

line(`① 旧命名文件（文件名含标题片段）：${oldNaming.length} 条`)
for (const r of oldNaming.slice(0, 20)) line(`   ${r.id}  ${r.file}`)
if (oldNaming.length > 20) line(`   …还有 ${oldNaming.length - 20} 条`)
line('   处置建议：**不动**。改名要动 index.json 的 file 字段与全部引用，风险大于收益；')
line('             新建/移动的条目已自动用新命名，存量会自然稀释。')
line('')

line(`② 墓碑标题仍是原文（删了但索引里还看得见）：${tombstoneTitleLeaks.length} 条`)
for (const r of tombstoneTitleLeaks.slice(0, 20)) line(`   ${r.id}  title=${JSON.stringify(r.title)}  ${r.file}`)
line('   处置建议：需要清理时逐条人工确认后改 index.json 的 title 字段；')
line('             本次不改 —— 改存量数据要先备份、且必须走人工，不做自动批处理。')
line('')

line(`③ 墓碑摘要仍是原文摘录：${tombstoneSummaryLeaks.length} 条`)
for (const r of tombstoneSummaryLeaks.slice(0, 20)) line(`   ${r.id}  summary=${JSON.stringify(r.summary)}  ${r.file}`)
line('')

const total = oldNaming.length + tombstoneTitleLeaks.length + tombstoneSummaryLeaks.length
line(total === 0 ? '结论：无发现。' : `结论：共 ${total} 处发现（其中②③属"已删除但未删干净"，值得人工过一遍）。`)
