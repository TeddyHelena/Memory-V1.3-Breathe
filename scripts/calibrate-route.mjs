#!/usr/bin/env node
/**
 * calibrate-route.mjs —— 路由参数离线标定台（V1.2 正事 ②）
 *
 * 存在的理由（提案 §五-②）：
 *   路由的门槛全是**未标定初值**（`gate_in_keep_fraction: 0.5`、`keep_alive_priority: 90`…），
 *   而"注入几条"直接决定每轮花多少钱。没有标定，"调参"就是拍脑袋；
 *   拍脑袋的结果没人能说清是变好了还是变坏了。
 *
 * 判据（提案 §五-② / §六-6）：
 *   ① **该想起的没漏**（标定集上漏掉率 = 0）—— 这是硬线，先于一切
 *   ② 在①的前提下，**注入条数中位 ≤ 6**
 *   ③ 顺带量出精确率（注入里有多少是"该想起的"），防止靠"全注入"刷召回
 *
 * 为什么能离线跑：路由是**确定性纯计算**（不调模型）。
 * 只有"标注"这件事需要人 —— 所以人的成本被压到只做判断题。
 *
 * 用法：
 *   node scripts/calibrate-route.mjs --set calibration/route-set.json
 *   node scripts/calibrate-route.mjs --set <set.json> --root <容器目录> --json
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const ROOT = path.resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : fallback
}
const SET_PATH = path.resolve(ROOT, arg('--set', 'calibration/route-set.json'))
// ⛔ 不许有"默认指向生产"的回落（2026-10-09 安全审稿）：
//    标定台是"读全库、反复跑、输出直接喂参数决定"的工具，默认指向生产等于
//    **一个静默的全库读者**——跑错了没人知道，而且结果会被当成"生产上的读数"。
//    改法与 longrun-drift.mjs 一致：无 --root 即退；且显式拒绝生产容器。
const PRODUCTION_CONTAINER = '/Users/admin/Documents/Obsidian Vault/00_记忆系统/dsh-memory-container'
const RAW_ROOT = arg('--root', process.env.MEMORY_CONTAINER_ROOT ?? '')
if (!RAW_ROOT) {
  console.error('用法：node scripts/calibrate-route.mjs --root <容器目录> [--set <set.json>] [--json]')
  console.error('说明：标定必须在**副本**上跑；--root 无默认值，避免静默读生产。')
  process.exit(2)
}
const CONTAINER = path.resolve(RAW_ROOT)
if (CONTAINER === path.resolve(PRODUCTION_CONTAINER) && !args.includes('--allow-production')) {
  console.error(`❌ 拒绝在生产容器上跑标定：${CONTAINER}`)
  console.error('   请先拷一份副本（或显式加 --allow-production，并清楚你在读真身）。')
  process.exit(2)
}
const AS_JSON = args.includes('--json')

const { MemoryContainer } = await import(path.join(ROOT, 'lib/container.js'))
const { Router } = await import(path.join(ROOT, 'lib/route/router.js'))
const { DEFAULT_ROUTE_CONFIG } = await import(path.join(ROOT, 'lib/route/types.js'))
const { buildInvertedTagIndex, directed } = await import(path.join(ROOT, 'lib/route/recall.js'))

const set = JSON.parse(fs.readFileSync(SET_PATH, 'utf-8'))
const questions = set.questions ?? []

/** 扫的网格：只扫"会改变注入集合"的那几个旋钮（其余是结构性参数，不在本台子范围） */
// 第一轮发现：**条数不由 hard_cap 决定，由 guaranteed_quota 决定**——
// 保底路径（priority ≥ keep_alive）不参与相关性裁决，直接占满额度。
// 实测容器 66/80 条 priority ≥ 70、25 条 ≥ 90 ⇒ 任何问题都会硬塞 ~12 条"重要的"。
// 所以 quota 必须进网格，否则整个扫描看不到"条数"这个维度。
// ⚠️ 方向（2026-10-03 改名时写死）：keep_fraction **越大越松**（1.0 ≈ 全留）。
//    第一版网格按"越大越严"排的，方向正好反了 —— 见 types.ts 的字段注释。
// 第二轮聚焦：**条数的两个杠杆**（max_entries 条数硬上限 / guaranteed_quota 保底额度）。
// 第一轮已经证明 gate_in / hard_cap 对条数几乎无影响（字符预算装得下 15 条摘要）。
const grid = []
for (const keep of [90]) {
  for (const q of [0.5, 1.0]) {
    for (const quota of [0, 12]) {
      for (const maxEntries of [0, 3, 6]) {
        grid.push({
          gate_in_keep_fraction: q, keep_alive_priority: keep,
          guaranteed_quota: quota, max_entries: maxEntries, hard_cap: 1600,
        })
      }
    }
  }
}

/**
 * 「漏」的归因 —— 这是这个台子最值钱的一格。
 *
 * 一条该想起的条目没进 main，可能死在三个完全不同的地方，修法也完全不同：
 *   · `recall`  —— 检索层压根没找到（分词 / 字段权重 / 索引问题）→ 修检索
 *   · `gate`    —— 找到但被硬门禁拒了（只对 emergent 生效）→ 修门禁
 *   · `budget`  —— 找到也被放行，但分数低于 gate_in 门槛或字符预算截断 → 修门槛/预算
 * 不归因的话，看到"漏 1 题"只能猜；p05 那次就是靠这一格才定位到 decay_type 的。
 */
function attribute(container, cfg, question, expectIds) {
  const tagIndex = buildInvertedTagIndex(container.getIndex().entries)
  const recalled = new Set(directed({ container, config: cfg, tagIndex }, question).map((e) => e.meta.id))
  return expectIds.map((id) => ({ id, stage: recalled.has(id) ? 'budget' : 'recall' }))
}

function evaluate(container, cfg) {
  const router = new Router(container, cfg)
  let injectedTotal = 0
  let injectedCharsTotal = 0
  let expectTotal = 0
  let hitTotal = 0
  const perQuestion = []
  const sizes = []
  for (const item of questions) {
    const expect = new Set(item.expect ?? [])
    const res = router.route(item.q)
    const injected = res.main.map((e) => e.meta.id)
    // 成本口径：注入的是 summary（见 budget.injectedChars），加每行前缀的固定开销。
    // token 换算按插件配置的 charsPerToken=1.5（中文摘要为主；这是插件的既有口径，不是新拍的数）。
    injectedCharsTotal += res.main.reduce((n, e) => n + (e.meta.summary ?? '').length + 12, 0)
    const hit = injected.filter((id) => expect.has(id))
    const miss = [...expect].filter((id) => !injected.includes(id))
    injectedTotal += injected.length
    expectTotal += expect.size
    hitTotal += hit.length
    if (expect.size > 0) sizes.push(injected.length)
    perQuestion.push({
      q: item.q,
      injected,
      expect: [...expect],
      miss,
      missStage: miss.length ? attribute(container, cfg, item.q, miss) : [],
      extra: injected.filter((id) => !expect.has(id)),
    })
  }
  const median = sizes.length ? [...sizes].sort((a, b) => a - b)[Math.floor((sizes.length - 1) / 2)] : 0
  // "有期望的问题"与"期望为空的问题"要分开算：
  //   · 前者考召回（该想起的漏没漏）
  //   · 后者考噪音（本来就都有，路由再塞就是纯浪费）
  const informative = perQuestion.filter((p) => p.expect.length > 0)
  const charsPerQuestion = +(injectedCharsTotal / questions.length).toFixed(0)
  const quiet = perQuestion.filter((p) => p.expect.length === 0)
  const infInjected = informative.reduce((n, p) => n + p.injected.length, 0)
  const infHit = informative.reduce((n, p) => n + p.injected.filter((id) => p.expect.includes(id)).length, 0)
  return {
    missed: perQuestion.filter((p) => p.miss.length > 0).length,
    injectedAvg: +(injectedTotal / questions.length).toFixed(2),
    injectedMedian: median,
    injectedCharsAvg: charsPerQuestion,
    injectedTokensAvg: +(charsPerQuestion / 1.5).toFixed(0),
    precision: injectedTotal ? +(hitTotal / injectedTotal).toFixed(3) : null,
    precisionInformative: infInjected ? +(infHit / infInjected).toFixed(3) : null,
    noiseOnQuiet: quiet.length ? +(quiet.reduce((n, p) => n + p.injected.length, 0) / quiet.length).toFixed(2) : null,
    recall: expectTotal ? +(hitTotal / expectTotal).toFixed(3) : null,
    perQuestion,
  }
}

const container = new MemoryContainer(CONTAINER)
container.load({ verify: false })

// ── 现状体检（用线上那套默认参数跑一遍）：先知道"现在漏在哪"，再谈调参 ──
const current = evaluate(container, DEFAULT_ROUTE_CONFIG)

const results = grid.map((g) => {
  const cfg = {
    ...DEFAULT_ROUTE_CONFIG,
    gate_in_keep_fraction: g.gate_in_keep_fraction,
    keep_alive_priority: g.keep_alive_priority,
    budget: { ...DEFAULT_ROUTE_CONFIG.budget, hard_cap: g.hard_cap, guaranteed_quota: g.guaranteed_quota, max_entries: g.max_entries },
  }
  return { cfg: g, ...evaluate(container, cfg) }
})

// 选优：先"漏 = 0"，再注入条数中位最小；并列看精确率
const feasible = results.filter((r) => r.missed === 0).sort((a, b) => a.injectedMedian - b.injectedMedian || (b.precision ?? 0) - (a.precision ?? 0))
const best = feasible[0] ?? [...results].sort((a, b) => a.missed - b.missed || a.injectedMedian - b.injectedMedian)[0]

if (AS_JSON) {
  // 机器可读输出要小：perQuestion 只留 best 的（全网格 48 组 × 22 问会撑爆管道）
  const slim = (r) => ({
    cfg: r.cfg, missed: r.missed, injectedMedian: r.injectedMedian, injectedAvg: r.injectedAvg,
    precision: r.precision, precisionInformative: r.precisionInformative, noiseOnQuiet: r.noiseOnQuiet, recall: r.recall,
  })
  console.log(JSON.stringify({
    set: SET_PATH, container: CONTAINER, questions: questions.length,
    best: { ...slim(best), perQuestion: best.perQuestion },
    top: feasible.slice(0, 10).map(slim),
  }, null, 2))
} else {
  console.log(`标定集: ${SET_PATH}（${questions.length} 问）`)
  console.log(`容器  : ${CONTAINER}\n`)
  console.log('── 现状体检（线上默认参数）──')
  console.log(
    `  注入中位 ${current.injectedMedian} 条｜平均 ${current.injectedCharsAvg} 字符 ≈ ${current.injectedTokensAvg} token/轮` +
    `｜空期望题平均注入 ${current.noiseOnQuiet} 条｜漏题 ${current.missed}`,
  )
  for (const p of current.perQuestion.filter((p) => p.miss.length)) {
    const why = p.missStage.map((m) => `${m.id}（${m.stage === 'recall' ? '检索没找到' : '找到但被门槛/预算挡'}）`).join('，')
    console.log(`  漏「${p.q}」→ ${why}`)
  }
  console.log('')
  console.log('保留比例 quota 条数上限 | 漏题 注入中位(≤6?) 空期望题注入 精确率(有期望题) 召回率')
  for (const r of [...results].sort((a, b) => a.missed - b.missed || a.injectedMedian - b.injectedMedian).slice(0, 12)) {
    console.log(
      `${String(r.cfg.gate_in_keep_fraction).padEnd(7)} ${String(r.cfg.guaranteed_quota).padEnd(5)} ${String(r.cfg.max_entries).padEnd(8)} | ` +
      `${String(r.missed).padEnd(4)} ${(String(r.injectedMedian) + (r.injectedMedian <= 6 ? ' ✓' : ' ✗')).padEnd(12)} ${String(r.noiseOnQuiet).padEnd(12)} ${String(r.precisionInformative ?? '-').padEnd(15)} ${r.recall ?? '-'}`,
    )
  }
  console.log(`\n★ 推荐（漏=0 优先，其次条数最少）：keep_fraction=${best.cfg.gate_in_keep_fraction} quota=${best.cfg.guaranteed_quota} max_entries=${best.cfg.max_entries} hard_cap=${best.cfg.hard_cap}`)
  console.log(`  漏题 ${best.missed}｜注入中位 ${best.injectedMedian}（判据 ≤6）｜有期望题的精确率 ${best.precisionInformative}｜空期望题平均注入 ${best.noiseOnQuiet}｜召回率 ${best.recall}`)
  if (best.missed > 0) {
    console.log('\n漏掉的题（硬线：先修漏，再谈收紧）—— 每条都标了死在那一层：')
    for (const p of best.perQuestion.filter((p) => p.miss.length)) {
      const why = p.missStage.map((m) => `${m.id}(${m.stage === 'recall' ? '检索没找到' : '找到被门槛挡'})`).join(' ')
      console.log(`  「${p.q}」漏 ${why}`)
    }
  }
  const noisy = best.perQuestion.filter((p) => p.extra.length)
  if (noisy.length) {
    console.log('\n多注入的（不是漏，但费钱；供收紧参考）：')
    for (const p of noisy.slice(0, 8)) console.log(`  「${p.q}」多: ${p.extra.join(',')}`)
  }
}

// 回滚路径：本台子只读容器、不写任何文件；参数不生效到生产 —— 改配置是人的一步
process.exit(0)
