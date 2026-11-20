#!/usr/bin/env node
/**
 * **衰减机制体检**：一条命令回答"它还在转吗"。
 *
 * 为什么要它：机制是**启动时**动一次的，所以"它到底转没转"平时看不出来 ——
 * 只能靠翻三个账本对齐：归档账（做过什么）· 闸门账（什么时候做的）· 层分布（结果对不对）。
 * 本脚本把这三个 + "下一次会做什么" 一次打出来。⛔ 只读，不写任何东西。
 *
 * 用法：node scripts/decay-status.mjs [--root <容器>]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const argv = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=')
  return [k, v.join('=') || 'true']
}))
const ROOT = argv.root ?? path.join(os.homedir(), 'Documents/Obsidian Vault/00_记忆系统/dsh-memory-container')
const LIB = path.resolve(import.meta.dirname, '..', 'lib')
const { readAudit, readSweepStateCompat, resolveGateSnapshot } = await import(path.join(LIB, 'decay-sweep.js'))
const { MemoryContainer } = await import(path.join(LIB, 'container.js'))
const { planDecaySweep, sweepEntries } = await import(path.join(LIB, 'decay.js'))
const { setDayTimeZone, dayKey } = await import(path.join(LIB, 'day-boundary.js'))
setDayTimeZone('Asia/Shanghai')

const fmt = (ms) => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 19) : '—')
const st = readSweepStateCompat(ROOT)
const audit = readAudit(ROOT)
const gate = resolveGateSnapshot(ROOT, Date.now())
const c = new MemoryContainer(ROOT); c.load()
const now = Date.now()
const es = sweepEntries(c.getIndex().entries, now)
const plan = planDecaySweep(es)

console.log('═══ 衰减机制体检（只读）═══')
console.log(`  容器            ${ROOT}`)
console.log('')
console.log('  ① 做过什么（归档账）')
console.log(`     累计归档      ${audit.length} 条 ｜ 批次 ${new Set(audit.map((r) => r.batch)).size} 个`)
for (const r of audit.slice(-5)) {
  console.log(`       ${fmt(r.at)}  ${String(r.id).padEnd(6)} ${r.from}→${r.to}${r.rolledBack ? '（已撤销）' : ''}${r.healed ? '（自愈补记）' : ''}`)
}
if (!audit.length) console.log('       （还没有任何归档记录）')
console.log('')
console.log('  ② 什么时候做的（闸门账）')
console.log(`     上次自动扫描  ${fmt(st?.lastAutoAt)} ｜ 当天日键 ${st?.lastDayKey ?? '—'} ｜ 今天 ${dayKey(new Date(now))}`)
console.log(`     上次批次      ${st?.lastBatch ?? '—'}（${st?.lastCount ?? 0} 条）`)
console.log(`     判定依据来自  ${gate.from}${gate.note ? ' ｜ ' + gate.note : ''}${gate.block ? ' ｜ ⛔ 本次会拦下' : ''}`)
console.log('')
console.log('  ③ 结果（层分布）')
const by = {}
for (const e of c.getIndex().entries) by[e.layer] = (by[e.layer] ?? 0) + 1
console.log(`     ${Object.entries(by).map(([k, v]) => `${k} ${v}`).join(' ｜ ')}`)
console.log('')
console.log('  ④ 下一次会做什么（按当前判据）')
console.log(`     现在到期      ${plan.moves.length} 条${plan.moves.length ? '：' + plan.moves.map((m) => m.id).join(', ') : '（没有到期的）'}`)
const L = { 'hot-anchor': 'hot/人格锚点', 'core-anchor': 'core 永不衰减', 'other-layer': '不在 longterm', inactive: '非 active', 'no-age-info': '无有效年龄', 'age-unknown': '年龄未知', floor: '未过地板（太新）', healthy: '健康', 'over-limit': '超每批上限' }
console.log(`     ${Object.entries(plan.classes).filter(([, v]) => v).map(([k, v]) => `${L[k] ?? k} ${v}`).join(' ｜ ')}`)
console.log('')
console.log('  ⚠️ 触发点是**启动**：宿主不重启，那段时间不动（但不会丢 —— 条目只会继续变老，下次启动一次补齐，受每批上限约束）')
