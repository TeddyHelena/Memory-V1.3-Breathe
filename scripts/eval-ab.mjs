#!/usr/bin/env node
/**
 * 评测台（C-1.1）—— 量的是「召回**好不好**」，不是「内部一致不一致」。
 *
 * ## 为什么要有它
 * V1.3 的验收此前全是**内部一致性**：漂移=0、指纹=0、账本在记、契约不违反……
 * 这些能证明"它按规矩跑"，**证明不了"它想起来的对不对"**。这是外部复核点名的**缺口 C**。
 * 这个台子干三件事：
 *   ① 在同一份**带真值**的样本上跑**两版配置**（A/B）；
 *   ② 给出**逐题差异**：谁进了、谁出了、为什么（归因到 `recall` 还是 `budget`）；
 *   ③ 三个数摆一起：**命中 / 漏掉 / 多余**（多余 = 没被期待却被注入的噪声与成本）。
 *
 * ## 与 `e3-calibrate.mjs` 的分工
 *   · `e3-calibrate.mjs` = **网格调参**（试一堆权重组合，看哪个不掉分）；
 *   · `eval-ab.mjs`     = **版本对比**（A 版 vs B 版，这版到底比上版好还是差）。
 *
 * ## ⚠️ 已知局限（如实，⛔ 不许拿它硬拟合）
 * 样本只有 22 题 / 14 个 expect ⇒ **分辨力到头了**（实测：分辨不出 w2_pri 0.1 与 0.4 的差别）。
 * 扩样是 C-1.2/C-1.3 的事，**要人工标注**。
 *
 * 用法：
 *   node scripts/eval-ab.mjs --root <容器副本> [--set calibration/route-set.json] [--json] [--turn <当前轮次>]
 *   ⛔ `--root` 必填且**拒绝生产容器**（与 calibrate-route.mjs 同一纪律）。
 */

import fs from 'node:fs'
import path from 'node:path'

import { MemoryContainer } from '../lib/container.js'
import { Router } from '../lib/route/router.js'
import { DEFAULT_ROUTE_CONFIG } from '../lib/route/types.js'
import { buildInvertedTagIndex, directed } from '../lib/route/recall.js'
import { E3_WEIGHTS, freshOf } from '../lib/route/fresh.js'
import { elapsed } from '../lib/route/clock.js'

const args = process.argv.slice(2)
const arg = (n, fb) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : fb }
const AS_JSON = args.includes('--json')
const PRODUCTION = '/Users/admin/Documents/Obsidian Vault/00_记忆系统/dsh-memory-container'
const RAW = arg('--root', process.env.MEMORY_CONTAINER_ROOT ?? '')
if (!RAW) { console.error('用法：node scripts/eval-ab.mjs --root <容器副本> [--set …] [--json]'); process.exit(2) }
const ROOT = path.resolve(RAW)
if (ROOT === path.resolve(PRODUCTION)) { console.error(`❌ 拒绝在生产容器上跑评测：${ROOT}`); process.exit(2) }

/**
 * 【C-1.2】标定集格式校验 —— ⛔ 坏标注不许静默通过。
 *
 * 格式（**向后兼容**：老题只有 `q`/`expect`/`why` 也能读）：
 * ```
 * { "q": "问题原文", "expect": ["l03", "p20"],   // 该被"额外想起"的条目 id
 *   "why": "为什么该想起它（人写的理由）",
 *   "note": "标注时的备注", "by": "teddy", "at": "2026-10-10T…" }   // 新增三键，可选
 * ```
 * 校验什么：① `q` 非空且**不重复**（重复题会让同一个判断被计两次）；② `expect` 只含**库里存在**的 id
 * （拼错 id 会**永远漏掉**，且看起来像"召回不行"—— 这是最坑的假数据）；
 * ③ `expect` 不许含常驻名单（它们在面① 每轮都投，写进 expect 是重复计数，标定集 note 里已定这条口径）。
 */
function validateSet(set, container) {
  const problems = []
  const ids = new Set(container.getIndex().entries.map((e) => e.id))
  const roster = new Set(container.getIndex().hot_order ?? [])
  const seen = new Map()
  for (const [i, q] of (set.questions ?? []).entries()) {
    const at = `第 ${i + 1} 题`
    if (!q?.q || !String(q.q).trim()) problems.push(`${at}：缺 q`)
    const key = String(q?.q ?? '').trim()
    if (key && seen.has(key)) problems.push(`${at}：与第 ${seen.get(key)} 题**重复**（同一个判断会被计两次）`)
    else if (key) seen.set(key, i + 1)
    for (const id of q?.expect ?? []) {
      if (!ids.has(id)) problems.push(`${at}：expect 里的 \`${id}\` **库里没有** ⇒ 它永远不会命中，看起来像"召回不行"`)
      if (roster.has(id)) problems.push(`${at}：expect 里含**常驻**条目 \`${id}\`（面① 每轮都投，写进来是重复计数）`)
    }
  }
  return problems
}

const SET = JSON.parse(fs.readFileSync(path.resolve(arg('--set', 'calibration/route-set.json')), 'utf-8'))
const questions = SET.questions ?? []
const NOW = new Date()
const TURN = Number(arg('--turn', '0')) || undefined

/** 从**真实投递账本**重建"每条最近一次被投递"（只看 route 面） */
function buildLedgerLookup(ledgerPath) {
  const last = new Map()
  let curTurn = 0
  if (fs.existsSync(ledgerPath)) {
    for (const line of fs.readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean)) {
      let e; try { e = JSON.parse(line) } catch { continue }
      if (e.turn !== undefined) curTurn = Math.max(curTurn, e.turn)
      if (e.face !== 'route') continue
      for (const id of e.ids ?? []) last.set(id, { session: e.session, turn: e.turn, at: e.at })
    }
  }
  return { last, curTurn }
}

/** 两版配置：A = 接线前（`fresh≡pri` + 冻结权重）；B = 接线后（真 fresh + 标定权重） */
function makeConfigs(container, ledger) {
  const A = { cfg: DEFAULT_ROUTE_CONFIG, lookup: undefined }
  const B = {
    cfg: { ...DEFAULT_ROUTE_CONFIG, weights: { ...E3_WEIGHTS } },
    lookup: (item) => freshOf({
      elapsed: elapsed({
        sessionId: 'eval', turn: TURN ?? ledger.curTurn,
        now: NOW, last: ledger.last.get(item.meta.id), lastAccessed: item.meta.last_accessed,
      }),
    }),
  }
  return { A, B }
}

/** 漏掉归因：是被**召回**漏了，还是召回到了但**预算**没装上 */
function attribute(cfg, question, missIds) {
  const tagIndex = buildInvertedTagIndex(container.getIndex().entries)
  const recalled = new Set(directed({ container, config: cfg, tagIndex }, question).map((e) => e.meta.id))
  return missIds.map((id) => ({ id, stage: recalled.has(id) ? 'budget' : 'recall' }))
}

let container = new MemoryContainer(ROOT)
container.load()

// ⛔ 坏标注必须**当场喊**，不许跑完给一堆看着像"召回差"的数
const setProblems = validateSet(SET, container)
if (setProblems.length) {
  console.error('❌ 标定集有问题（先修数据，再信读数）：')
  for (const p of setProblems.slice(0, 12)) console.error(`   · ${p}`)
  if (setProblems.length > 12) console.error(`   …还有 ${setProblems.length - 12} 条`)
  if (!args.includes('--allow-bad-set')) process.exit(3)
}
const ledger = buildLedgerLookup(path.join(ROOT, 'injection-ledger.jsonl'))
const { A, B } = makeConfigs(container, ledger)

function run(which) {
  const c = new MemoryContainer(ROOT); c.load()
  const conf = which === 'A' ? A : B
  const router = new Router(c, conf.cfg)
  const out = []
  for (const item of questions) {
    const expect = new Set(item.expect ?? [])
    const res = router.route(item.q, conf.lookup ? { freshLookup: conf.lookup } : {})
    const ids = res.main.map((e) => e.meta.id)
    out.push({ q: item.q, expect, ids })
  }
  return out
}

const ra = run('A'), rb = run('B')
const stat = (rows) => rows.reduce((acc, r) => {
  acc.injected += r.ids.length
  acc.expect += r.expect.size
  acc.hit += r.ids.filter((id) => r.expect.has(id)).length
  acc.miss += [...r.expect].filter((id) => !r.ids.includes(id)).length
  acc.extra += r.ids.filter((id) => !r.expect.has(id)).length
  return acc
}, { injected: 0, expect: 0, hit: 0, miss: 0, extra: 0 })
const sa = stat(ra), sb = stat(rb)

// 逐题差异
const diffs = []
for (let i = 0; i < questions.length; i++) {
  const a = ra[i], b = rb[i]
  const entered = b.ids.filter((id) => !a.ids.includes(id))
  const left = a.ids.filter((id) => !b.ids.includes(id))
  if (!entered.length && !left.length) continue
  diffs.push({
    q: a.q,
    entered, left,
    // 出去的条目若本来就在 expect 里 ⇒ 这是**变差**；进来的若在 expect 里 ⇒ **变好**
    regressions: left.filter((id) => a.expect.has(id)),
    gains: entered.filter((id) => b.expect.has(id)),
    missAttribution: attribute(B.cfg, a.q, [...b.expect].filter((id) => !b.ids.includes(id))),
  })
}
const changed = diffs.length

if (AS_JSON) {
  console.log(JSON.stringify({ root: ROOT, questions: questions.length, A: sa, B: sb, diffs }, null, 2))
} else {
  console.log(`\n════ 评测台 A/B ════`)
  console.log(`容器 ${ROOT}\n题数 ${questions.length}（有 expect 的 ${questions.filter((q) => (q.expect ?? []).length).length} 题，expect 合计 ${sa.expect}）`)
  console.log(`\nA = 接线前（fresh≡pri · w2_pri=0）\nB = 接线后（轮次钟 fresh · w2_pri=${E3_WEIGHTS.w2_pri}）\n`)
  const pad = (s, n) => String(s).padEnd(n)
  console.log('  ' + pad('版本', 8) + pad('注入', 6) + pad('命中', 6) + pad('漏掉', 6) + '多余')
  for (const [k, s] of [['A', sa], ['B', sb]]) {
    console.log('  ' + pad(k, 8) + pad(s.injected, 6) + pad(s.hit, 6) + pad(s.miss, 6) + s.extra)
  }
  console.log(`\n  ⇒ 命中 ${sa.hit} → ${sb.hit} ｜ 漏掉 ${sa.miss} → ${sb.miss} ｜ 多余 ${sa.extra} → ${sb.extra}`)

  console.log(`\n──── 逐题差异（${changed}/${questions.length} 题有变化）────`)
  if (!changed) console.log('  （无差异：这一版的改动不改变本样本上的注入集合）')
  for (const d of diffs) {
    console.log(`\n「${d.q}」`)
    if (d.gains.length) console.log(`  ✅ 补上：${d.gains.join(' ')}`)
    if (d.regressions.length) console.log(`  ⚠️ 丢掉：${d.regressions.join(' ')}  ← 这题**变差**`)
    if (d.entered.length) console.log(`  ➕ 进：${d.entered.join(' ')}`)
    if (d.left.length) console.log(`  ➖ 出：${d.left.join(' ')}`)
    if (d.missAttribution.length) {
      console.log(`  漏掉归因：${d.missAttribution.map((m) => `${m.id}(${m.stage === 'recall' ? '没召回到' : '召回到了但没装上'})`).join(' ')}`)
    }
  }
  console.log(`\n读法：**命中**要高、**漏掉**要低；\`⚠️ 丢掉\` 是硬伤（本来在 expect 里，被换出去了）。`)
  console.log(`⚠️ 样本 ${questions.length} 题 / ${sa.expect} 个 expect —— **分辨力到顶了**，⛔ 不许拿它硬拟合。\n`)
}
