#!/usr/bin/env node
/**
 * P1/P8：孤儿 subject 报告（只读 + 落 orphan-report 事件）。
 * 孤儿 = 有 parent 但 parent 不在表里；root 不算。
 * 用法：node scripts/orphan-report.mjs "<容器根>"
 */
import { SubjectStore } from '../lib/subjects.js'
import { appendEvent } from '../lib/event-log.js'

const root = process.argv[2]
if (!root) { console.error('用法: node scripts/orphan-report.mjs "<容器根>"'); process.exit(2) }
const store = new SubjectStore(root)
const all = store.list()
const ids = new Set(all.map((s) => s.id))
const orphans = all.filter((s) => s.kind !== 'root' && s.parent && !ids.has(s.parent))
for (const s of orphans) {
  appendEvent(root, 'orphan-report', { id: s.id, parent: s.parent, detectedAt: new Date().toISOString() })
}
console.log(JSON.stringify({ ok: orphans.length === 0, total: all.length, orphans: orphans.map((s) => ({ id: s.id, parent: s.parent })) }, null, 2))
process.exit(orphans.length === 0 ? 0 : 1)
