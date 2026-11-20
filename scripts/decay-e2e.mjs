#!/usr/bin/env node
/**
 * **衰减端到端演练**（在**副本容器**上跑真代码 —— ⛔ 绝不碰生产）。
 *
 * 为什么需要它：生产容器里"陈旧"的条目太少（首日归档 **0 条**），
 * 机制虽然"在跑"，但**从没实际动过数据** ⇒ 等于没验证过。
 * 这个演练在副本上**人为制造一条陈旧**，然后把整条链走一遍：
 *   制造陈旧 → `runSweep`（真判定 + 真写入器 `relocate`）→ 归档生效 → 审计落盘 → `rollbackLastBatch` 回滚
 *
 * 用法：node scripts/decay-e2e.mjs [源容器路径]
 * 退出码：0 = 全通；1 = 有一步没过（并打印哪一步）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { MemoryContainer } from '../lib/container.js'
import { MemoryWriter } from '../lib/writer.js'
import { readAudit, readSweepState, rollbackLastBatch, runSweep } from '../lib/decay-sweep.js'

const SRC = process.argv[2] ?? path.join(os.homedir(), 'Documents/Obsidian Vault/00_记忆系统/dsh-memory-container')
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'decay-e2e-'))
const COPY = path.join(WORK, 'container')
const rows = []
const ok = (what, got, want) => { const pass = String(got) === String(want); rows.push([pass ? '✅' : '❌', what, got, want]); return pass }
let red = 0

try {
  fs.cpSync(SRC, COPY, { recursive: true })
  rows.push(['ℹ️ ', '副本容器', COPY, '—'])

  // ① 挑一条可降层的条目，并把它的 last_accessed 倒到 60 天前（> 半衰期 30 天 ⇒ 陈旧）
  const idxPath = path.join(COPY, 'index.json')
  const idx = JSON.parse(fs.readFileSync(idxPath, 'utf-8'))
  const list = Array.isArray(idx.entries) ? idx.entries : Object.values(idx.entries)
  const target = list.find((e) => e.layer === 'longterm' && (e.status ?? 'active') === 'active' && !/^h/i.test(e.id))
  if (!target) throw new Error('副本里找不到可降层的 longterm+active 条目（不碰 h*）')
  const old = target.last_accessed
  target.last_accessed = new Date(Date.now() - 60 * 86400000).toISOString()
  fs.writeFileSync(idxPath, JSON.stringify(idx, null, 2), 'utf-8')
  rows.push(['ℹ️ ', '被制造陈旧的条目', `${target.id}（last_accessed: ${String(old).slice(0, 10)} → 60 天前）`, '—'])

  // ② 跑真扫描（force：跳过"一天一次"）
  const container = new MemoryContainer(COPY)
  const writer = new MemoryWriter(container, { operator: 'decay-e2e' })
  // ⛔ **修（2026-10-15 · L4 顺手）**：修前这里**手搓条目形状**（`list.map(e => ({id,layer,status,fresh}))`），
  //   而退场判据 **2026-10-14 已从 `fresh` 换成 `effectiveAge`**（`625a44c`）⇒
  //   搓出来的条目**没有判据字段** ⇒ 计划里 0 个 moves（实测拦截类全是 `age-unknown`）
  //   ⇒ **本 e2e 自 10-14 起静默腐烂**（今天才发现，因为它不在 `verify` 里）。
  //   ⇒ 改成走**生产那扇门** `sweepEntries`（判据变、它跟着变；⛔ 不再自己搓形状）。
  //   ⚠️ 这也正是"第二扇门"的真实样本：不在 `readIntents`（那只是薄包装），**在手搓判据输入**。
  const { sweepEntries } = await import('../lib/decay.js')
  const entries = sweepEntries(list, Date.now(), idx.hot_order)
  // ⚠️ 记扫描前的审计条数：真身副本带着**生产容器的历史审计行**，⛔ 别假设副本是空的
  const auditBefore = readAudit(COPY).length
  const sweep = runSweep({ root: COPY, entries, relocate: (id, layer, o) => writer.relocate(id, layer, o), force: true })
  if (!ok('扫描跑起来了', sweep.ran, true)) red++
  if (!ok('目标条目被归档', sweep.archived.includes(target.id), true)) red++

  // ③ 归档真的落到容器里了吗（重新加载再看 —— ⛔ 不信内存）
  const after = new MemoryContainer(COPY)
  if (!ok('容器里层已变 archive', after.entryMeta(target.id).layer, 'archive')) red++

  // ④ 审计与状态文件
  const audit = readAudit(COPY)
  // ⛔ 修（2026-10-15）：修前断言"审计**共** 1 条"、且读 `audit[0]` —— 那是**假设副本是空的**；
  //   真身副本带着生产的历史审计行（实测 6 行）⇒ 总数 7 ⇒ 判据红得莫名其妙。
  //   ⇒ 改成断言**增量**，并读**最后一条**（本次写的那条）。
  if (!ok('审计新增 1 条', audit.length - auditBefore, 1)) red++
  const lastAudit = audit[audit.length - 1]
  if (!ok('审计里记着 from/to', `${lastAudit?.from}→${lastAudit?.to}`, 'longterm→archive')) red++
  if (!ok('状态文件写了 lastAt', typeof readSweepState(COPY)?.lastAt, 'number')) red++

  // ⑤ ⭐【L4 步②·双写】判据：**新日志重放 == 旧 audit（逐字段比）**
  //    ⛔ 不是"看起来一样"—— 比的是 `id:from→to` 三元组的**序列**。
  {
    const { readLog, replay } = await import('../lib/decay-log.js')
    const lg = readLog(COPY)
    if (!ok('⑤ 双写日志解析零问题', lg.problems.length, 0)) red++
    if (!ok('⑤ 日志首条是 begin', lg.records[0]?.phase, 'begin')) red++
    if (!ok('⑤ 日志末条是 commit', lg.records[lg.records.length - 1]?.phase, 'commit')) red++
    const rp = replay(lg.records)
    if (!ok('⑤ 重放零问题', rp.problems.length, 0)) red++
    if (!ok('⑤ 重放无未完成事务（这批没崩）', rp.projection.incompleteTxns.length, 0)) red++
    const logged = lg.records.filter((r) => r.phase === 'step' && r.action === 'moved').map((r) => `${r.id}:${r.from}→${r.to}`)
    const audited = audit.filter((r) => r.batch === rp.projection.lastBatch).map((r) => `${r.id}:${r.from}→${r.to}`)
    if (!ok('⑤ 日志 move 段 == 旧 audit 内容（逐字段比）', JSON.stringify(logged), JSON.stringify(audited))) red++

    // ⭐【步③b 的硬判据】**合并无副作用**：双写期 `readAudit`（旧文件 ∪ 日志，去重）
    //   必须与"只读旧文件"**逐字段一致**。
    //   ⛔ 这一条不成立就说明"合并"偷偷改了行为 —— 那样 ③b 就不是可逆的了。
    const rawRows = fs.readFileSync(path.join(COPY, '.decay-audit.jsonl'), 'utf-8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l))
    if (!ok('⑤ 步③b：合并 readAudit 无副作用（逐字段 == 旧文件）', JSON.stringify(readAudit(COPY)), JSON.stringify(rawRows))) red++
  }

  // ⑤ 回滚（一键撤销最近一批）
  const rb = rollbackLastBatch({ root: COPY, relocate: (id, layer, o) => writer.relocate(id, layer, o) })
  if (!ok('回滚动了 1 条', rb.rolledBack.length, 1)) red++
  const back = new MemoryContainer(COPY)
  if (!ok('层已回滚到 longterm', back.entryMeta(target.id).layer, 'longterm')) red++
  if (!ok('回滚写了审计标记', readAudit(COPY).some((r) => r.rolledBack === true), true)) red++
} catch (e) {
  red++
  rows.push(['❌', '演练中断', String(e?.message ?? e).slice(0, 90), '不该中断'])
}

console.log('\n════ 衰减端到端演练（副本容器 · 真代码）════\n')
for (const [mark, what, got, want] of rows) console.log(`${mark} ${String(what).padEnd(24)} ${String(got).slice(0, 60)}${want === '—' ? '' : `  ｜ 期望 ${want}`}`)
console.log(`\n结论：${red === 0 ? '✅ 全通（衰减这条链真的跑通了）' : `❌ ${red} 处红`}`)
console.log(`（副本已留：${WORK} ｜ ⛔ 生产容器一个字没动）\n`)
process.exit(red === 0 ? 0 : 1)
