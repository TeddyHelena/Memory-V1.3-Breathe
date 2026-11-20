#!/usr/bin/env node
/**
 * 标题单行化存量扫描（2026-10-19 · s7 标题换行注入修复）。
 * 用法：node scripts/normalize-titles.mjs "<容器根>" [--apply]
 * 默认 **dry-run**：只列会改的条目，不写盘。`--apply` 才逐条走 writer.edit（事务+写锁）。
 * ⛔ 生产容器先 dry-run 给人看过再 apply。
 */
import { MemoryContainer } from '../lib/container.js'
import { MemoryWriter, normalizeTitle } from '../lib/writer.js'

const root = process.argv[2]
if (!root) { console.error('用法: node scripts/normalize-titles.mjs "<容器根>" [--apply]'); process.exit(2) }
const apply = process.argv.includes('--apply')

const container = new MemoryContainer(root)
container.load({ verify: false })
const writer = new MemoryWriter(container, { operator: 'title-normalize' })
const changes = []
for (const meta of container.getIndex().entries) {
  let title
  try { title = container.readEntry(meta.id)?.frontmatter.title } catch { continue }
  if (typeof title !== 'string') continue
  const next = normalizeTitle(title)
  if (next !== title) changes.push({ id: meta.id, before: title, after: next })
}
console.log(JSON.stringify({ root, apply, candidates: changes.length, changes: changes.slice(0, 50), ...(changes.length > 50 ? { more: changes.length - 50 } : {}) }, null, 2))
if (apply) {
  let ok = 0; const failed = []
  for (const c of changes) {
    try { writer.edit(c.id, { title: c.after }); ok++ } catch (e) { failed.push({ id: c.id, error: String(e?.message ?? e) }) }
  }
  console.log(JSON.stringify({ applied: ok, failed }, null, 2))
}
process.exit(changes.length === 0 ? 0 : 1)
