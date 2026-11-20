#!/usr/bin/env node
/**
 * P0-6 回填：为既有条目补 has_session / session_kind（只改索引投影，不碰文件）。
 * 用法：node scripts/backfill-has-session.mjs "<容器根>"
 */
import { MemoryContainer, classifySessionKind } from '../lib/container.js'

const root = process.argv[2]
if (!root) { console.error('用法: node scripts/backfill-has-session.mjs "<容器根>"'); process.exit(2) }
const c = new MemoryContainer(root, { verify: false })
const index = c.getIndex()
let n = 0, host = 0, legacy = 0, placeholder = 0, absent = 0, failed = 0
for (const meta of index.entries) {
  try {
    const entry = c.readEntry(meta.id)
    const raw = entry?.frontmatter?.source_session
    const kind = classifySessionKind(raw)
    c.stampSessionDerived(meta.id, Boolean(typeof raw === 'string' && raw.trim()), kind)
    n++
    if (kind === 'host') host++
    else if (kind === 'legacy_literal') legacy++
    else if (kind === 'placeholder') placeholder++
    else absent++
  } catch { failed++ }
}
c.saveIndex()
console.log(JSON.stringify({ ok: true, total: index.entries.length, stamped: n, host, legacy_literal: legacy, placeholder, absent, failed }))
