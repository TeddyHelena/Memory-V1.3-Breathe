#!/usr/bin/env node
/**
 * E3 标定台（网格版）—— 回答**两个可分别回答的问题**，并**如实标出哪个答不了**。
 *
 * ## 它能答的：`w2_pri` 该取多少
 * 标定集（`calibration/route-set.json`，22 题，`expect` = 该被想起的条目，Teddy 人工校正过 3 条）
 * **有真值** ⇒ 可以用"命中 / 漏掉 / 多余"三个数衡量不同权重向量。
 *
 * ## 它答不了（如实标出，⛔ 不许拿它硬拟合）的：`H_turn` 该取多少
 * 标定集是一串**问题**，不是带时间轴的回放 ⇒ 里面没有"这一轮距上次投递几轮"的信息。
 * 而 A 段实测：真身 `last_accessed` 全在当天（墙钟支的分数极差 0.0009 = 空转）⇒
 * **在这份数据上 H_turn 不可辨识**。它的初值由 A 段的分布推（p50=2 轮 / p90=10 轮 ⇒ 5 轮），
 * 标 `*`；真标定需要"带真值的会话内回放"，**尚未建**。
 *
 * 用法：node scripts/e3-calibrate.mjs --root <容器副本> [--json]
 *   ⛔ `--root` 必填且拒绝生产容器（与 calibrate-route.mjs 同一纪律）。
 */

import fs from 'node:fs'
import path from 'node:path'

import { MemoryContainer } from '../lib/container.js'
import { Router } from '../lib/route/router.js'
import { DEFAULT_ROUTE_CONFIG } from '../lib/route/types.js'
import { elapsed } from '../lib/route/clock.js'
import { freshOf } from '../lib/route/fresh.js'

const args = process.argv.slice(2)
const arg = (n, fb) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : fb }
const AS_JSON = args.includes('--json')
const PRODUCTION = '/Users/admin/Documents/Obsidian Vault/00_记忆系统/dsh-memory-container'
const RAW = arg('--root', process.env.MEMORY_CONTAINER_ROOT ?? '')
if (!RAW) { console.error('用法：node scripts/e3-calibrate.mjs --root <容器副本> [--json]'); process.exit(2) }
const ROOT = path.resolve(RAW)
if (ROOT === path.resolve(PRODUCTION)) { console.error(`❌ 拒绝在生产容器上跑标定：${ROOT}`); process.exit(2) }

const SET = JSON.parse(fs.readFileSync(path.resolve(arg('--set', 'calibration/route-set.json')), 'utf-8'))
const questions = SET.questions ?? []
const NOW = new Date()

/**
 * 标定集是一串问题 ⇒ 每条当作**新会话**：走墙钟支。
 * ⛔ 这是这份数据的上限，不是"我们选了墙钟"——见文件头"它答不了"。
 */
function makeLookup() {
  return (item) => {
    const e = elapsed({ now: NOW, lastAccessed: item.meta.last_accessed })
    return freshOf({ elapsed: e })
  }
}

function evaluate(container, cfg, useFresh) {
  const router = new Router(container, cfg)
  const lookup = useFresh ? makeLookup() : undefined
  let injected = 0, expectN = 0, hit = 0, extra = 0, miss = 0
  for (const item of questions) {
    const expect = new Set(item.expect ?? [])
    const res = router.route(item.q, lookup ? { freshLookup: lookup } : {})
    const ids = res.main.map((e) => e.meta.id)
    injected += ids.length
    expectN += expect.size
    hit += ids.filter((id) => expect.has(id)).length
    miss += [...expect].filter((id) => !ids.includes(id)).length
    extra += ids.filter((id) => !expect.has(id)).length
  }
  return { injected, expect: expectN, hit, miss, extra }
}

const rows = []
// 基线：接线前的行为（fresh ≡ pri）
rows.push({ 配置: '基线（fresh≡pri，w2=0）', ...evaluate(new MemoryContainer(ROOT), DEFAULT_ROUTE_CONFIG, false) })

for (const w2 of [0, 0.1, 0.2, 0.3, 0.4]) {
  for (const H of [5, 10]) {
    const c = new MemoryContainer(ROOT)
    c.load()
    const cfg = { ...DEFAULT_ROUTE_CONFIG, weights: { ...DEFAULT_ROUTE_CONFIG.weights, w2_pri: w2 } }
    const r = evaluate(c, cfg, true)
    rows.push({ 配置: `接线 w2_pri=${w2} · H_turn=${H}`, ...r })
  }
}

if (AS_JSON) {
  console.log(JSON.stringify({ root: ROOT, questions: questions.length, rows }, null, 2))
} else {
  console.log(`\n════ E3 标定（网格）════\n容器 ${ROOT}\n题数 ${questions.length}｜expect 合计 ${rows[0].expect}\n`)
  console.log('  配置'.padEnd(30) + '注入  expect  命中  漏掉  多余')
  for (const r of rows) {
    console.log('  ' + r.配置.padEnd(28) + String(r.injected).padStart(4) + String(r.expect).padStart(8) + String(r.hit).padStart(6) + String(r.miss).padStart(6) + String(r.extra).padStart(6))
  }
  console.log('\n读法：**命中**要高、**漏掉**要低；**多余**是没被期待却被注入的（成本与噪声）。')
  console.log('⚠️ 在这份数据上 `H_turn` 不可辨识（标定集无时间轴 + 真身 last_accessed 全在当天）——')
  console.log('   它的初值由 A 段分布推（5 轮），标 `*`；真标定需要"带真值的会话内回放"（未建）。\n')
}
