#!/usr/bin/env node
/**
 * longrun-drift.mjs —— 长任务漂移专项压测（2026-10-07 建）
 *
 * ════════════════════════════════════════════════════════════════════
 * 为什么不是"简单压测"
 * ════════════════════════════════════════════════════════════════════
 * 简单压测出一个数（p50/p95/QPS）。**漂移要的是"随时间变化的量"** ——
 * 一条曲线，而且必须能回答"这个变化是载体的、还是负载本身的"。
 * 所以本台子采**三条独立曲线**，每条单独成判据：
 *
 *   曲线① 召回漂移：同一批固定 query，探针条目的 rank 随语料增长怎么变
 *                    （**脱离模型可测** —— 不调 LLM，纯检索，故无模型噪声）
 *   曲线② 成本漂移：写入/检索延迟、注入可用额度随轮次与语料规模怎么变
 *   曲线③ 一致性漂移：索引↔文件投影不符数、entry_count、脱节
 *
 *   另有 曲线④ 预算漂移（独立小测）：上下文占用涨上去后，热段还能塞几条
 *                    —— 这是**唯一一个"设计上就会随时间变化"的量**，
 *                       而且退化是静默的（TokenBudget 的地板机制就是为它加的）
 *
 * ════════════════════════════════════════════════════════════════════
 * 纪律（写进脚本，不靠自觉）
 * ════════════════════════════════════════════════════════════════════
 *   · **拒绝在生产容器上跑**（同 acceptance-sealed.mjs）—— 必须走
 *     `bash scripts/with-container-copy.sh 'node scripts/longrun-drift.mjs --root "$CONTAINER_COPY" ...'`
 *   · **探针唯一性**：探针 token 由内容哈希生成，撞车即报错
 *   · **负控必带**：另埋同形但不同主题的对照条目，它们**不该**被召回；
 *     负控一旦漏进来，说明"命中"不是本事，整条曲线作废
 *   · **留出集**：探针事实只写进副本容器，**一个字都不进任何文档**
 *   · **判据前置**：劣化阈值写在 CONFIG 里，跑完直接给结论，不事后挑
 *
 * 用法：
 *   node scripts/longrun-drift.mjs --root <副本> [--scale 200] [--rounds 200]
 *                                   [--sample-every 20] [--out /tmp/drift]
 * 退出码：0 = 跑完（**不代表没漂**，漂移结论看报告）；1 = 台子自身出错
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import { MemoryContainer } from '../lib/container.js'
import { MemoryWriter } from '../lib/writer.js'
import { searchLongterm } from '../lib/search.js'
import { TokenBudget } from '../lib/budget.js'

// ── 参数 ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d }
const ROOT = arg('root', process.env.MEMORY_CONTAINER_ROOT ?? '')
const SCALE = Number(arg('scale', 200))
const ROUNDS = Number(arg('rounds', 200))
const SAMPLE_EVERY = Number(arg('sample-every', 20))
const OUT = arg('out', '')
if (!ROOT) { console.error('用法：node scripts/longrun-drift.mjs --root <容器副本> [...]'); process.exit(2) }

// ── 生产容器守卫（照抄 acceptance-sealed.mjs 的理由：靠自觉的纪律会被破）────
const PROD_HINTS = ['00_记忆系统/dsh-memory-container', '00_记忆系统\\dsh-memory-container']
const resolved = path.resolve(ROOT)
if (PROD_HINTS.some((h) => resolved.endsWith(h))) {
  console.error(`❌ 拒绝在生产容器上跑压测：${resolved}\n   请用 scripts/with-container-copy.sh 在副本上跑。`)
  process.exit(2)
}

// ── 判据（前置，跑完直接给结论）──────────────────────────────────────
const CONFIG = {
  /** 曲线① 召回：探针 rank 超过这个名次算"丢了" */
  recallRankLost: 20,
  /** 曲线① 召回：期末命中率低于这个数 → 判"召回漂移" */
  recallHitRateFloor: 1.0,
  /** 曲线② 成本：写入 p50 相对首档的放大倍数上限（S2 要治的回归就是这一条） */
  writeAmplifyCeiling: 12,
  /** 曲线③ 一致性：投影不符数上限（超过即判"投影漂移"，今天修的就是这个） */
  projectionDriftCeiling: 0,
  /** 曲线④ 预算：热段可用额度跌破地板（条数）即判"静默缩水" */
  budgetEntryFloor: 1,
}

const now = () => Number(process.hrtime.bigint() / 1000n) / 1000  // ms，微秒精度
const pct = (arr, p) => {
  if (arr.length === 0) return null
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]
}
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 8)

// ════════════════════════════════════════════════════════════════════
// 0 · 起容器
// ════════════════════════════════════════════════════════════════════
const container = new MemoryContainer(ROOT)
container.load()
const writer = new MemoryWriter(container)

const timeline = []          // 采样点
let skippedPendingUpdate = 0   // 因「候选不可 update」规则跳过的次数（⛔ 不静默）
const writeLat = []          // 全部写入耗时（含播撒期）
const searchLat = []

console.log('════════ 长任务漂移专项压测 ════════')
console.log(`容器副本 ${resolved}`)
console.log(`语料 ${SCALE} 条 ｜ 轮次 ${ROUNDS} ｜ 每 ${SAMPLE_EVERY} 轮采样`)
console.log(`起始 entry_count = ${container.getIndex().entries.length}\n`)

// ════════════════════════════════════════════════════════════════════
// 1 · 播撒语料（写延迟曲线在播撒期就采到了，一举两得）
// ════════════════════════════════════════════════════════════════════
const TOPICS = ['架构', '性能', '安全', '流程', '检索', '存储', '契约', '运维']
console.log(`[1/5] 播撒语料 ${SCALE} 条…`)
const seedStart = now()
for (let i = 0; i < SCALE; i++) {
  const t0 = now()
  // ⚠️ 契约用 snake_case，且 remember **没有 layer 参数**（固定落 longterm）——
  //    第一版照 tools 的入参写成驼峰，当场被 assertSource 拒了（MISSING_SOURCE）。
  writer.remember({
    title: `语料 ${i} · ${TOPICS[i % TOPICS.length]} 记录`,
    content: `${TOPICS[i % TOPICS.length]} 主题的第 ${i} 条合成记录。`
      + `标记 ${sha(`seed-${i}`)}。用于长任务漂移压测，不含真实内容。`,
    memory_type: 'world',
    tags: [TOPICS[i % TOPICS.length]],
    source_session: 'drift-loadtest',
    source_message: `seed ${i}`,
  })
  writeLat.push({ n: container.getIndex().entries.length, ms: now() - t0 })
  if ((i + 1) % 100 === 0) {
    const recent = writeLat.slice(-100).map((w) => w.ms)
    console.log(`      ${i + 1}/${SCALE}  p50 ${pct(recent, 0.5)?.toFixed(1)}ms  p95 ${pct(recent, 0.95)?.toFixed(1)}ms`)
  }
}
console.log(`      播撒完成 ${((now() - seedStart) / 1000).toFixed(1)}s\n`)

// 曲线②-a：写入延迟**按语料规模分桶**（播撒期就是天然的规模梯度）
// 这是 S2「写入回归 8.4×」那一栏最直接的证据，也是本次压测最容易复现的一条。
const writeBySize = []
{
  const BUCKET = Math.max(20, Math.floor(SCALE / 10))
  const buckets = new Map()
  for (const w of writeLat) {
    const b = Math.floor((w.n - 100) / BUCKET) * BUCKET + 100   // 从起始 99 条往后分桶
    if (b < 100) continue
    if (!buckets.has(b)) buckets.set(b, [])
    buckets.get(b).push(w.ms)
  }
  for (const b of [...buckets.keys()].sort((x, y) => x - y)) {
    writeBySize.push({ atEntries: b, p50: pct(buckets.get(b), 0.5), n: buckets.get(b).length })
  }
  const line = writeBySize.map((x) => `${x.atEntries}条:${x.p50?.toFixed(0)}ms`).join('  ')
  console.log(`      写入 p50 随规模：${line}\n`)
}

// ════════════════════════════════════════════════════════════════════
// 2 · 埋探针 + 负控
// ════════════════════════════════════════════════════════════════════
// 探针：主题唯一、含罕见字与唯一 token，保证"只有真检索到才可能答对"
// 负控：同形但主题完全无关，**不该**出现在任何探针 query 的结果里
console.log('[2/5] 埋探针 + 负控…')
// ⚠️ 负控设计（2026-10-07 第二版）：
//   第一版探针叫「碲钨铯探针主题」、负控叫「锕钍镤负控主题」——**共用了「主题」二字和整套句式模板**
//   （都是「…的第 i 条。唯一标记 DRIFTxxx-」），于是负控本来就该被召回到，实测泄漏 9/9。
//   那不是"系统把它们混淆了"，是**我造了一对本来就像的东西**，然后怪检索器。
//   这一版：两边**不共用任何实词、编号前缀也不同、句式也不同**，只有"都是中文"这一个共同点。
const PROBE_TOPIC = '碲钨铯探针'
const CTRL_TOPIC = '沿海季风洋流'
const probes = []
const controls = []
for (let i = 0; i < 3; i++) {
  const tok = sha(`probe-${i}-${SCALE}`)
  const r = writer.remember({
    title: `${PROBE_TOPIC} ${i}`,
    content: `${PROBE_TOPIC}·标记 PROBE-${tok}。仅存在于副本容器。`,
    memory_type: 'world', tags: [PROBE_TOPIC],
    source_session: 'drift-loadtest', source_message: `probe ${i}`,
  })
  probes.push({ id: r.id, token: `PROBE-${tok}`, query: `${PROBE_TOPIC} ${tok}` })
}
for (let i = 0; i < 3; i++) {
  const tok = sha(`ctrl-${i}-${SCALE}`)
  const r = writer.remember({
    title: `${CTRL_TOPIC} ${i}`,
    // ⚠️ 第三版（2026-10-07）：第二版这里写的是「与探针无关」——**它自己把「探针」两个字写进去了**，
    //   于是当然跟探针 query 匹配，实测 9/9 全泄漏。**为了"说明它无关"，制造了它的相关性。**
    //   负控正文里 ⛔ 一个字都不许提探针侧的实词。
    content: `${CTRL_TOPIC}·编号 CTRL-${tok}。`,
    memory_type: 'world', tags: [CTRL_TOPIC],
    source_session: 'drift-loadtest', source_message: `ctrl ${i}`,
  })
  controls.push({ id: r.id, token: `CTRL-${tok}`, query: `${CTRL_TOPIC} ${tok}` })
}
// 唯一性自检：token 撞车则整轮作废（探针不唯一 = 曲线没意义）
const allTokens = [...probes, ...controls].map((p) => p.token)
if (new Set(allTokens).size !== allTokens.length) { console.error('❌ 探针 token 撞车，作废'); process.exit(1) }
console.log(`      探针 ${probes.map((p) => p.token).join(', ')}`)
console.log(`      负控 ${controls.map((p) => p.token).join(', ')}\n`)

// ════════════════════════════════════════════════════════════════════
// 3 · 采样函数（三条曲线共用一个采样点）
// ════════════════════════════════════════════════════════════════════
const sample = (round) => {
  // 曲线①：召回 —— 固定 query，看探针 rank
  const recall = probes.map((p) => {
    const t0 = now()
    const hits = searchLongterm(container, p.query, { topK: 20 })
    searchLat.push(now() - t0)
    const rank = hits.findIndex((h) => h.id === p.id)
    return { probe: p.id, token: p.token, rank: rank < 0 ? null : rank + 1 }
  })
  // 负控（**双向**）：探针 query 不许召回负控；负控 query 也不许召回探针。
  // 单向只能证明"没混进来"，双向才能证明"是主题在起作用"而不是"什么都能召回"。
  const leaked = []
  for (const p of probes) {
    const hits = searchLongterm(container, p.query, { topK: 20 })
    for (const c of controls) if (hits.some((h) => h.id === c.id)) leaked.push(`${p.id}←${c.id}`)
  }
  for (const c of controls) {
    const hits = searchLongterm(container, c.query, { topK: 20 })
    for (const p of probes) if (hits.some((h) => h.id === p.id)) leaked.push(`${c.id}→${p.id}`)
  }

  // 曲线③：一致性 —— 重新 load 一次（= 对账），读投影不符
  const auditor = new MemoryContainer(ROOT)
  auditor.load()
  const drift = auditor.getProjectionDrift()

  const idx = auditor.getIndex()
  return {
    round,
    entryCount: idx.entries.length,
    recall,
    recallHit: recall.filter((r) => r.rank !== null && r.rank <= CONFIG.recallRankLost).length,
    controlLeak: leaked.length,
    leakSample: leaked.slice(0, 4),
    projectionDrift: drift.length,
    projectionDriftSample: drift.slice(0, 3),
    writeP50: pct(writeLat.slice(-SAMPLE_EVERY * 3).map((w) => w.ms), 0.5),
    searchP50: pct(searchLat.slice(-SAMPLE_EVERY * 3), 0.5),
  }
}

const t0sample = now()
timeline.push(sample(0))
console.log(`[3/5] 采样点 #0（基线）：命中 ${timeline[0].recallHit}/${probes.length} ｜ 负控泄漏 ${timeline[0].controlLeak} ｜ 投影不符 ${timeline[0].projectionDrift}`)

// ════════════════════════════════════════════════════════════════════
// 4 · 主循环（轮次）—— 混合操作，让库在长任务里持续变化
// ════════════════════════════════════════════════════════════════════
console.log(`\n[4/5] 主循环 ${ROUNDS} 轮（读/写/改/忘 混合）…`)
const me = container.getIndex().entries.map((e) => e.id)
for (let r = 1; r <= ROUNDS; r++) {
  const op = r % 4
  try {
    if (op === 0) {                                  // 写：库持续变大
      const t = now()
      const out = writer.remember({
        title: `轮次写入 ${r}`, content: `第 ${r} 轮新写入，标记 ${sha(`r-${r}`)}。`,
        memory_type: 'world', tags: ['轮次写入'],
        source_session: 'drift-loadtest', source_message: `round ${r}`,
      })
      writeLat.push({ n: container.getIndex().entries.length, ms: now() - t, id: out.id })
      if (out.id) me.push(out.id)
    } else if (op === 1) {                           // 读
      const t = now()
      searchLongterm(container, `语料 ${r % Math.max(1, SCALE)} ${TOPICS[r % TOPICS.length]}`, { topK: 5 })
      searchLat.push(now() - t)
    } else if (op === 2) {                           // 改：原地更新（走 patch 路径）
      const target = me[r % me.length]
      // 2026-10-10 修：脚本的"忘"操作会 propose 出**候选**，而候选不能被 update
      //   （产品规则「候选必须先转正或丢弃」是对的，不是 bug）。
      //   修复前第 102 轮报 2 次 [INVALID_INPUT] pending 候选不可直接 update ⇒ 那是**脚本期望过时**。
      //   ⇒ 改之前先看它是不是候选；是就跳过**并计数**，⛔ 不静默。
      const meta = container.entryMeta(target)
      if (meta && meta.layer === 'pending') {
        skippedPendingUpdate++
      } else if (target) {
        const t = now()
        // update 的 patch **没有 summary 字段**（只有 content/title/tags/reason/valid_*），
        // 且必须带 reason —— 契约比 tools 暴露出来的窄，这里按真契约写。
        writer.update(target, { reason: `第 ${r} 轮更正`, source_session: 'drift-loadtest', source_message: `round ${r}` })
        writeLat.push({ n: container.getIndex().entries.length, ms: now() - t })
      }
    } else {                                          // 忘：偶尔删，制造墓碑与投影变化
      if (r % 40 === 0 && me.length > 50) {
        const victim = me.shift()
        const t = now()
        try { writer.forget(victim, { mode: 'tombstone', reason: '长任务漂移压测', source_session: 'drift-loadtest', source_message: `round ${r}` }) } catch { /* 已被删过 */ }
        writeLat.push({ n: container.getIndex().entries.length, ms: now() - t })
      }
    }
  } catch (e) {
    console.log(`      ⚠️ 第 ${r} 轮 ${op} 出错：${String(e.message).slice(0, 80)}`)
  }

  if (r % SAMPLE_EVERY === 0) {
    const s = sample(r)
    timeline.push(s)
    console.log(`      #${String(r).padStart(3)}  条目 ${String(s.entryCount).padStart(4)} ｜ 召回 ${s.recallHit}/${probes.length}（rank ${s.recall.map((x) => x.rank ?? '—').join('/')}）｜ 负控 ${s.controlLeak} ｜ 投影 ${s.projectionDrift} ｜ 写p50 ${s.writeP50?.toFixed(0)}ms`)
  }
}

// ════════════════════════════════════════════════════════════════════
// 5 · 曲线④ 预算漂移（独立小测，不需要模型）
// ════════════════════════════════════════════════════════════════════
console.log('\n[5/5] 预算漂移（模拟上下文占用爬升）…')
const budget = new TokenBudget()
const windows = [10_000, 50_000, 100_000, 200_000, 400_000, 600_000, 800_000, 950_000, 999_000]
const budgetCurve = windows.map((ctx) => {
  budget.reset()
  budget.record({ totalTokens: ctx })
  const chars = budget.budgetChars({ contextWindow: 1_000_000, hotMaxChars: 16000, hotMinChars: 2000, charsPerToken: 1.6 })
  return { contextTokens: ctx, chars, entriesEstimate: Math.floor(chars / 900) }  // 900 字符/条是 V1.2 标定口径
})
for (const b of budgetCurve) console.log(`      上下文 ${String(b.contextTokens).padStart(7)} tok → 热段 ${String(b.chars).padStart(5)} 字符 ≈ ${b.entriesEstimate} 条`)

// ════════════════════════════════════════════════════════════════════
// 汇总与判据
// ════════════════════════════════════════════════════════════════════
const first = timeline[0]
const last = timeline[timeline.length - 1]
const verdicts = []
verdicts.push({
  curve: '① 召回漂移',
  value: `${first.recallHit}/${probes.length} → ${last.recallHit}/${probes.length}`,
  pass: last.recallHit >= probes.length * CONFIG.recallHitRateFloor,
  note: `探针 rank 轨迹（每格一次采样，三个探针用 / 分隔）：${timeline.map((s) => s.recall.map((x) => x.rank ?? '—').join('/')).join(' → ')}`,
})
verdicts.push({
  curve: '①b 负控（前提校验）',
  value: `泄漏 ${timeline.reduce((a, s) => a + s.controlLeak, 0)} 次`,
  pass: timeline.every((s) => s.controlLeak === 0),
  note: '负控一旦泄漏，"命中"就不是本事，曲线①作废',
})
const wFirst = timeline[0].writeP50
const wLast = last.writeP50
verdicts.push({
  curve: '② 成本（写入 p50）',
  value: `${wFirst?.toFixed(1)}ms → ${wLast?.toFixed(1)}ms（${(wLast / wFirst).toFixed(2)}×）`,
  pass: wLast / wFirst <= CONFIG.writeAmplifyCeiling,
  note: `上限 ${CONFIG.writeAmplifyCeiling}×（S2 要治的回归就是这一条）`,
})
verdicts.push({
  curve: '②b 成本（检索 p50）',
  value: `${timeline[0].searchP50?.toFixed(1)}ms → ${last.searchP50?.toFixed(1)}ms`,
  pass: true, note: '本轮只记录，不设判据（绝对上限 200ms 归 S2 口径）',
})
verdicts.push({
  curve: '③ 一致性（投影不符）',
  value: `${first.projectionDrift} → ${last.projectionDrift} 处`,
  pass: timeline.every((s) => s.projectionDrift <= CONFIG.projectionDriftCeiling),
  note: `上限 ${CONFIG.projectionDriftCeiling}；只计数不阻断是容器现在的设计`,
})
const minEntries = Math.min(...budgetCurve.map((b) => b.entriesEstimate))
verdicts.push({
  curve: '④ 预算漂移（热段可塞条数）',
  value: `${budgetCurve[0].entriesEstimate} 条 → ${minEntries} 条`,
  pass: minEntries >= CONFIG.budgetEntryFloor,
  note: `地板 ${CONFIG.budgetEntryFloor} 条；跌破即"记忆静默缩水"`,
})

console.log('\n════════ 判据 ════════')
for (const v of verdicts) console.log(`   ${v.pass ? '✅' : '❌'} ${v.curve}｜${v.value}\n        ${v.note}`)

const report = {
  meta: { ranAt: new Date().toISOString(), root: resolved, scale: SCALE, rounds: ROUNDS, sampleEvery: SAMPLE_EVERY, config: CONFIG },
  timeline,
  writeBySize,
  budgetCurve,
  verdicts,
  latency: {
    write: { p50: pct(writeLat.map((w) => w.ms), 0.5), p95: pct(writeLat.map((w) => w.ms), 0.95), n: writeLat.length },
    search: { p50: pct(searchLat, 0.5), p95: pct(searchLat, 0.95), n: searchLat.length },
  },
  notCovered: [
    '口径/人格漂移（版本号、纪律在长会话后期还守不守）—— 必须在**有模型的真实会话**里测，本台子测不了',
    '注入质量的端到端效果 —— 本台子只测"检索到没检索到"，不测"模型用没用上"',
    '崩溃恢复 / 锁竞争（S3 面）—— 本轮未施加并发',
  ],
}
if (OUT) {
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, `drift-scale${SCALE}-rounds${ROUNDS}.json`), JSON.stringify(report, null, 2))
  console.log(`\n报告已落：${path.join(OUT, `drift-scale${SCALE}-rounds${ROUNDS}.json`)}`)
}
console.log(`\n未覆盖（⛔ 不许沉默地漏掉）：`)
for (const s of report.notCovered) console.log(`   · ${s}`)

// 2026-10-10：把"因规则跳过"的次数打出来（⛔ 不静默 —— 静默跳过等于把一件事藏起来）
console.log(`\n（本轮因「候选不可直接 update」规则跳过 ${skippedPendingUpdate} 次 —— 那是产品规则的正确拒绝，不是错误）`)
