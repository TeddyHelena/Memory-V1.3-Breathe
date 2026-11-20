#!/usr/bin/env node
/**
 * compact-index.mjs —— 把增量索引日志折平回快照（Ledger · L-5 的回滚前置）
 *
 * ════════════════════════════════════════════════════════════════════
 * 为什么必须有它
 * ════════════════════════════════════════════════════════════════════
 * L-5 之后，盘上索引是**两件**：`index.json`（快照）+ `index.delta.jsonl`（增量日志）。
 * **旧代码（Ledger 之前）只认快照** —— 它看不到日志里的变更。
 * 所以**回滚顺序必须先是"折平"，再换代码**：
 *
 *     停插件 → node scripts/compact-index.mjs → 换回旧代码 → 启动
 *
 * ⛔ 不许"直接切回去试试"：那样旧代码会读到落后于日志的快照，
 *    表现为"最近写的东西没了"—— 而且它会拿这份陈旧状态继续写，越滚越远。
 *
 * ════════════════════════════════════════════════════════════════════
 * 它做什么（三步，全部幂等）
 * ════════════════════════════════════════════════════════════════════
 *   ① `load({verify:true})` —— 重放日志 + 校验容器（顺带触发自身自愈，若有）
 *   ② 写回一份完整快照、清空日志（`verify` 档的加载本来就会做，这里显式确认）
 *   ③ 复核：**只读快照**（模拟旧代码的眼睛）条目数是否等于真身
 *
 * 用法：
 *   node scripts/compact-index.mjs --root "<容器根>"
 *   node scripts/compact-index.mjs --root "$CONTAINER_COPY" --dry-run   # 只看不写
 * 退出码：0 = 折平完成且复核通过；1 = 复核不过；2 = 参数错
 */

import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d }
const ROOT = path.resolve(arg('root', process.cwd()))
const DRY = argv.includes('--dry-run')

const { MemoryContainer } = await import(path.join(import.meta.dirname, '..', 'lib', 'container.js'))

const indexPath = path.join(ROOT, 'index.json')
const logPath = path.join(ROOT, 'index.delta.jsonl')

const before = {
  snapshot: (() => { try { return JSON.parse(fs.readFileSync(indexPath, 'utf-8')).entry_count } catch { return null } })(),
  logRecords: fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean).length : 0,
  logBytes: fs.existsSync(logPath) ? fs.statSync(logPath).size : 0,
}

console.log('════════ 折平增量索引日志（L-5 回滚前置）════════')
console.log(`容器 ${ROOT}`)
console.log(`折平前：快照声明 ${before.snapshot} 条 ｜ 日志 ${before.logRecords} 条 / ${before.logBytes} 字节\n`)

if (DRY) {
  const c = new MemoryContainer(ROOT)
  // ⚠️ 干跑必须真干跑：`verify:true` 那一档**自己就会折平写盘**（本工具复用它），
  //    拿它当"只看不写"是撒谎。改用 `verify:false`：它会重放日志得到真身，但**不折平**。
  //    代价：不做逐条文件交叉校验（那是 verify 档的活）——干跑的目的就是"看一眼，别动手"。
  const idx = c.load({ verify: false })
  console.log(`真身（快照 + 日志）${idx.entries.length} 条`)
  console.log(`日志作废留痕 ${c.indexLogEvents.length} 条 ／ 自愈留痕 ${c.repairEvents.length} 条`)
  console.log('\n--dry-run：不写盘。去掉 --dry-run 才会真折平。')
  process.exit(0)
}

const c = new MemoryContainer(ROOT)
const idx = c.load({ verify: true })            // ① 重放 + 校验 + （verify 档）折平落盘

// ② 确认折平真的发生了（若容器只读，这里会看出来）
const after = {
  logRecords: fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean).length : 0,
  snapshot: (() => { try { return JSON.parse(fs.readFileSync(indexPath, 'utf-8')).entry_count } catch { return null } })(),
}

// ③ 复核：只读快照（旧代码的眼睛）看到的是不是真身
let snapshotSeen = null
let drift = 0
try {
  const raw = JSON.parse(fs.readFileSync(indexPath, 'utf-8'))
  snapshotSeen = raw.entries.length
  for (const e of raw.entries) if (!fs.existsSync(path.join(ROOT, e.file))) drift++
} catch (error) {
  console.error(`❌ 快照不可读：${String(error)}`)
  process.exit(1)
}

console.log(`真身条目数      ${idx.entries.length}`)
console.log(`快照条目数      ${snapshotSeen}${snapshotSeen === idx.entries.length ? '  ✅ 与真身一致（旧代码可读）' : '  ❌ 不一致'}`)
console.log(`索引↔文件脱节   ${drift}${drift === 0 ? '  ✅' : '  ❌'}`)
console.log(`日志剩余        ${after.logRecords} 条${after.logRecords === 0 ? '  ✅ 已清空' : '  ⚠️ 仍有残留'}`)
if (c.indexLogEvents.length) console.log(`日志事件留痕    ${c.indexLogEvents.length} 条：\n  - ${c.indexLogEvents.join('\n  - ')}`)
if (c.repairEvents.length) console.log(`自愈留痕        ${c.repairEvents.length} 条：\n  - ${c.repairEvents.join('\n  - ')}`)

const ok = snapshotSeen === idx.entries.length && drift === 0 && after.logRecords === 0
console.log(`\n结论：${ok ? '✅ 折平完成，可以安全回滚旧代码' : '❌ 折平不完整，⛔ 先别回滚'}`)
process.exit(ok ? 0 : 1)
