#!/usr/bin/env node
/**
 * 衰减机制体检（**只读**，不写容器）。
 *
 * 回答两个问题：
 *   ① 衰减"在不在跑"——访问记录、生命周期、decay_type 是活的还是静的；
 *   ② 有没有 BUG —— 用真数据跑一遍降层规划器（dry-run），并检查字段合法性。
 *
 * 用法：node scripts/decay-health.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { planDecaySweep, STALE_BELOW } from '../lib/decay.js'
import { freshForEntry, FRESH_PARAMS, halfLifeFor } from '../lib/route/fresh.js'

const ROOT = process.argv[2] ?? path.join(os.homedir(), 'Documents/Obsidian Vault/00_记忆系统/dsh-memory-container')
const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'index.json'), 'utf-8'))
const entries = idx.entries ?? idx
const list = Array.isArray(entries) ? entries : Object.values(entries)

const now = Date.now()
const days = (iso) => (iso ? (now - Date.parse(iso)) / 86_400_000 : NaN)
// ⛔ 体检口径必须与产品**同一个函数**（2026-10-11 修）：旧版自己拼 freshOf 且**不传 decay_type**
//    ⇒ 半衰期一律按 30 天算 ⇒ `process` 条目（真半衰期 7 天）被严重低估陈旧度，
//    而且缺 last_accessed 的条目被当成"刚访问过"（fresh=1）。体检报告因此会骗人。
const fresh = (e) => freshForEntry(typeof e === 'string' ? e : e.last_accessed, typeof e === 'string' ? undefined : e.decay_type, now)

const cnt = (k, v) => list.filter((e) => (e[k] ?? '') === v).length
console.log(`\n════ 衰减体检（只读） ════\n容器 ${ROOT}\n条目 ${list.length}\n`)

console.log('【① 在不在跑】')
const withAccess = list.filter((e) => e.last_accessed).length
const newest = list.map((e) => e.last_accessed).filter(Boolean).sort().at(-1)
console.log(`  last_accessed 有值      ${withAccess}/${list.length}   最新 ${String(newest).slice(0, 16)}`)
console.log(`  access_count  有值      ${list.filter((e) => e.access_count != null).length}/${list.length}`)
console.log(`  lifecycle = active      ${cnt('lifecycle', 'active')}/${list.length}   ← 全是 active 说明**没有任何生命周期转换**`)
console.log(`  decay_type: core ${cnt('decay_type', 'core')} / recent ${cnt('decay_type', 'recent')} / process ${cnt('decay_type', 'process')} / 未标 ${list.filter((e) => !e.decay_type).length}`)

console.log('\n【② 合法性（BUG 检查）】')
const badAccess = list.filter((e) => e.last_accessed && !Number.isFinite(Date.parse(e.last_accessed)))
const future = list.filter((e) => Number.isFinite(Date.parse(e.last_accessed)) && Date.parse(e.last_accessed) > now)
const noAccess = list.filter((e) => !e.last_accessed)
console.log(`  last_accessed 非法       ${badAccess.length}   ${badAccess.slice(0, 3).map((e) => e.id).join(', ')}`)
console.log(`  last_accessed 在未来     ${future.length}   ${future.slice(0, 3).map((e) => e.id).join(', ')}`)
console.log(`  缺 last_accessed         ${noAccess.length}   ${noAccess.slice(0, 3).map((e) => e.id).join(', ')}`)
const ages = list.map((e) => days(e.last_accessed)).filter(Number.isFinite).sort((a, b) => a - b)
if (ages.length) console.log(`  距上次访问（天）         p50 ${ages[Math.floor(ages.length * 0.5)].toFixed(1)} · p90 ${ages[Math.floor(ages.length * 0.9)].toFixed(1)} · max ${ages.at(-1).toFixed(1)}`)

console.log('\n【③ 现在跑一次降层会怎样（dry-run）】')
const plan = planDecaySweep(list.map((e) => ({ id: e.id, layer: e.layer, status: e.status, fresh: fresh(e) })))
const stale = list.filter((e) => fresh(e) < STALE_BELOW)
console.log(`  fresh < ${STALE_BELOW}（陈旧）      ${stale.length} 条`)
console.log(`  会被降层                 ${plan.moves.length} 条   ${plan.moves.slice(0, 5).map((m) => m.id).join(', ')}`)
console.log(`  被拦下                   ${plan.blocked.length} 条（原因前三：${[...new Set(plan.blocked.map((b) => b.why.replace(/=.*/, '')))].slice(0, 3).join(' / ')}）`)
if (plan.moves.length) console.log(`  例：${plan.moves[0].id} → ${plan.moves[0].reason}`)

console.log(`\n【④ decay_type 影响什么】半衰期：core = ∞ · process = ${halfLifeFor('process')} 天 · recent = ${halfLifeFor('recent')} 天（同会话 ${FRESH_PARAMS.halfLifeTurn} 轮）`)
console.log('  ✅ 2026-10-10 起 decay_type **真的参与**半衰期（`HALF_LIFE_BY_DECAY`）：快衰 7 天、常规 30 天、核心不衰减')
console.log('     ⛔ 改这三个数 = 改产品行为，先跟 作者 说（本条以前写过"不参与"，已作废）\n')
