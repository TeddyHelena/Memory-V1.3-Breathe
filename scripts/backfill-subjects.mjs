#!/usr/bin/env node
/**
 * 【B3】历史会话回填：为条目里出现的 host 会话补 conv subject。
 * 用法：node scripts/backfill-subjects.mjs "<容器根>"
 * ⛔ 只补“没有 conv subject”的会话；已有名字不动。
 */
import path from 'node:path'
import { MemoryContainer } from '../lib/container.js'
import { SubjectStore } from '../lib/subjects.js'
import { classifySessionKind } from '../lib/container.js'

const root = process.argv[2]
if (!root) { console.error('用法: node scripts/backfill-subjects.mjs "<容器根>"'); process.exit(2) }
const c = new MemoryContainer(root, { verify: false })
const store = new SubjectStore(root)
const sessions = new Map()
for (const meta of c.getIndex().entries) {
  let src = null
  try { src = c.readEntry(meta.id)?.frontmatter?.source_session ?? null } catch { /* skip */ }
  if (!src || classifySessionKind(src) !== 'host') continue
  const seen = meta.last_accessed ?? meta.updated ?? null
  const prev = sessions.get(src)
  if (!prev) sessions.set(src, { title: meta.title || '历史会话', last: seen })
  else if (seen && (!prev.last || seen > prev.last)) prev.last = seen
}
let created = 0, existed = 0
for (const [sid, info] of sessions) {
  const title = info.title
  if (store.mainSubjectOf(sid)) { existed++; continue }
  const id = store.openConversation(sid, title)
  // 用条目真实 last_accessed 覆写 last_grown/last_activated（⛔ 不用 now 冒充活动时间）
  if (id && info.last) store.setLastGrown(id, info.last)
  created++
}
console.log(JSON.stringify({ ok: true, hostSessions: sessions.size, created, existed, total: store.list().length }, null, 2))
