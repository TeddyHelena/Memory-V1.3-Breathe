#!/usr/bin/env node
/** 按批次回滚自动转正：只回滚 auditor=auto 且 action=promoted 的条目。 */
import fs from 'node:fs'
import path from 'node:path'
const args = process.argv.slice(2)
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d }
const root = arg('root'); const batch = arg('batch'); const dry = args.includes('--dry')
if (!root || !batch) { console.error('用法: node scripts/auto-promote-rollback.mjs --root <容器> --batch <batch> [--dry]'); process.exit(2) }
const audit = path.join(root, '.auto-promote.jsonl')
if (!fs.existsSync(audit)) { console.error('没有审计文件: ' + audit); process.exit(2) }
const rows = fs.readFileSync(audit, 'utf8').trim().split('\n').filter(Boolean).map((l, i) => {
  try { return JSON.parse(l) } catch (e) { throw new Error(`审计第 ${i + 1} 行坏: ${e.message}`) }
})
const targets = [...new Set(rows.filter(r => r.batch === batch && r.action === 'promoted' && r.operator === 'auto').map(r => r.id))]
if (!targets.length) { console.log(JSON.stringify({ ok: true, batch, rolledBack: 0, note: '没有可回滚的 auto 条目' })); process.exit(0) }
if (dry) { console.log(JSON.stringify({ ok: true, batch, dry: true, targets }, null, 2)); process.exit(0) }
const u = p => new URL('file://' + path.join(process.cwd(), 'lib', p)).href
const { MemoryContainer } = await import(u('container.js'))
const { MemoryWriter } = await import(u('writer.js'))
const c = new MemoryContainer(root); c.load({ verify: false })
const w = new MemoryWriter(c, { useWriteLock: false })
const done = []
for (const id of targets) {
  try {
    w.unconfirm(id, { operator: 'auto-rollback', reason: `batch ${batch}` })
    done.push(id)
    fs.appendFileSync(audit, JSON.stringify({ batch, at: new Date().toISOString(), id, action: 'rolled_back', operator: 'auto-rollback', reason: `batch ${batch}` }) + '\n')
  } catch (e) { console.error(`[FAIL] ${id}: ${e instanceof Error ? e.message : String(e)}`) }
}
console.log(JSON.stringify({ ok: done.length === targets.length, batch, rolledBack: done.length, targets, done }, null, 2))
