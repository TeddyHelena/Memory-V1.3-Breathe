#!/usr/bin/env node
/**
 * 衰减扫描监测报告（V1.3 监测补丁 · 2026-10-12）
 *
 * 用法：
 *   node scripts/decay-monitor-report.mjs                    # 默认读本仓容器根
 *   node scripts/decay-monitor-report.mjs --root <路径>       # 指定容器根
 *
 * 它只**读** `.decay-startup.jsonl` 并折成读数，⛔ 不写任何文件、不动判定。
 *
 * 判据（能红）：
 *   · 读不到记录 ⇒ 退出码 2，并明说"监测期还没攒到数据"
 *   · 有效扫描间隔 vs 设计意图（1 天）的偏差 ⇒ 打印倍率
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { summarizeStartups, fmtMs, readStartups, STARTUP_FILE } from '../lib/decay-monitor.js'

const args = process.argv.slice(2)
const rootIdx = args.indexOf('--root')
const root = rootIdx >= 0 ? args[rootIdx + 1] : process.env.MEMORY_CONTAINER_ROOT ?? path.resolve(process.cwd(), '../..')

const file = path.join(root, STARTUP_FILE)
if (!fs.existsSync(file)) {
  console.error(`⛔ 没找到监测记录：${file}`)
  console.error('')
  // ⚠️ 2026-10-14 改：修前这里只说"监测补丁刚上线时这是正常的"，很容易把人带沟里——
  //    最常见的真实原因不是"还没落第一行"，而是**没传 --root**：脚本默认拿 `process.cwd()/../..`，
  //    站在插件仓根目录跑会解析成 `~/Desktop/Harness/…`（一个不存在的路径），
  //    然后报"要等下一次插件启动" ⇒ 人会去查插件，其实只是路径不对。
  console.error('两种可能，按可能性排：')
  console.error('  ① **没传 --root**（最常见）：脚本默认拿 `process.cwd()/../..`，站在插件仓跑会解析成别的目录。')
  console.error('     本机正确用法：')
  console.error(`       node scripts/decay-monitor-report.mjs --root "${path.join(os.homedir(), 'Documents/Obsidian Vault/00_记忆系统/dsh-memory-container')}"`)
  console.error('  ② 容器确实还没有启动记录 ⇒ 那要等下一次插件启动才落第一行（该记录 2026-10-12 才上线）。')
  console.error('')
  console.error(`（本次实际找的是：${file} ｜ 当前工作目录：${process.cwd()}）`)
  process.exit(2)
}

const s = summarizeStartups(root)
const rows = readStartups(root)

console.log('─'.repeat(64))
console.log('衰减扫描 · 监测报告')
console.log('─'.repeat(64))
console.log(`容器根       ${root}`)
console.log(`记录文件     ${STARTUP_FILE}`)
console.log(`样本覆盖     ${fmtMs(s.from)}  →  ${fmtMs(s.to)}`)
console.log()
console.log(`记录行数     ${s.rows}（gate + sweep 两行/次）`)
console.log(`启动次数     ${s.startups}`)
console.log(`  真跑了     ${s.ranCount}`)
console.log(`  被门槛跳过 ${s.gatedCount}`)
console.log(`    ├ 今天已扫过 ${s.gatedCount - s.minIntervalCount - s.clockBackCount}`)
console.log(`    └ 6h 最小间隔 ${s.minIntervalCount}   ← **刻意**跳过，不是漏跑`)
console.log(`  时钟回拨   ${s.clockBackCount}`)
console.log()
const iv = s.intervalHours
// 判据（Breathe-R1 起）：当地自然日一次 + 最小间隔 6h ⇒ 设计意图是 **24h**（一天一次）
if (iv.n > 0) {
  const design = 24
  console.log(`有效扫描间隔（相邻两次真跑）`)
  console.log(`  n=${iv.n}   中位 ${iv.median}h   最短 ${iv.min}h   最长 ${iv.max}h`)
  console.log(`  设计意图 ${design}h ⇒ 实际/设计 = ${(iv.median / design).toFixed(2)}×`)
} else {
  console.log('有效扫描间隔  样本不足（至少两次真跑才算得出来）')
}
console.log()
console.log('换口径的分歧（⭐ 这一对才是"修了什么"的读数）：')
console.log(`  真判据跑了、legacy 24h 不会跑：${s.dayOnlyRuns} 次  ← **修前这几次被静默漏掉**`)
console.log(`  legacy 24h 会跑、真判据没跑  ：${s.legacyOnlyRuns} 次  ← 新口径更慢的次数（正常应为 0）`)
console.log(`  （另：被拦下的里面，自然日口径说该跑 ${s.shadowExtraRuns} 次、legacy 说该跑 ${s.legacyExtraRuns} 次；`)
console.log(`    其中 ${s.minIntervalExtraRuns} 次是 6h 守卫**刻意**拦下的，不算漏跑）`)
console.log(`  真判据 = 当地自然日一次 + 最小间隔 6h（Breathe-R1 · 2026-10-14）`)
console.log()
console.log('最近一次     ' + s.lastLine)
console.log()
console.log('最近 10 次启动：')
for (const r of rows.filter((x) => x.kind === 'gate').slice(-10)) {
  const flag = r.ran ? '跑 ' : '跳过'
  // ⚠️ 新旧记录混读：旧记录没有 by24h/byDay，就按它当时的 `shadowWouldRunByDay`（= 自然日口径）读
  // ⛔ 旧记录的 `shadowWouldRunByDay` 记的是**自然日**，不是 legacy —— 只能兜 byDay
  const by24 = r.by24h ?? false
  const byDay = r.byDay ?? r.shadowWouldRunByDay ?? false
  const by = r.decidedBy ?? '(旧记录)'
  console.log(`  ${fmtMs(r.at)}  ${flag}  距上次 ${r.sinceHours ?? '-'}h  legacy=${by24 ? '会跑' : '不跑'} 自然日=${byDay ? '会跑' : '不跑'} 判=${by}  ${r.reason}`)
}
console.log('─'.repeat(64))
