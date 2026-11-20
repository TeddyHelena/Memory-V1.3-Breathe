/**
 * score.ts —— V1.2 双门槛加权和打分（契约清单 §三）
 *
 * ```
 * score_in   = w1·rel + w2·pri + w3·fresh + w4·imp
 * score_cand = process ? w1·rel + w2·pri + w4·imp   （豁免 fresh）
 *                      : 同 score_in
 * ```
 *
 * ── 甲方案：`w2_pri = 0` ─────────────────────────────────────────
 * `fresh` 在 V1.2 恒等于 `pri`（契约 §三）。若 `w2` 保留，priority 会被计两次
 * （`w2·pri + w3·fresh`），到 V1.3 换上真 fresh 后同一套权重下 priority 的实际
 * 权重又腰斩——**V1.2 调出来的门限到 V1.3 就失效了**。所以 V1.2 把 w2 归零，
 * 让 priority 只由 w3 承担；V1.3 恢复 w2 并标 *。
 *
 * ── 归一化：三处刻意的选择 ────────────────────────────────────────
 * ① **rel 用 log + z-score + sigmoid**，不是 min-max：min-max 会把任何一组分数
 *    强行拉开到 [0,1]，候选只有 2 条时也能造出"最高分 1.0"，那是幻觉不是信号。
 * ② **分布只统计 directed 命中的 bm25**：card 与 emergent 的 bm25 是 0（占位值），
 *    把它们算进 mean/std 会把分布往 0 拉——**用占位值污染真实分布**是最容易犯的错。
 * ③ **样本数 < 5 时退化为 percentile 排名**：3 个样本算不出有意义的 std。
 */

import type { ContainerEntry } from '../types.js'
import { DEFAULT_ROUTE_CONFIG, isFreshExempt, type CandidateSeed, type RouteConfig, type ScoredEntry, type Weights } from './types.js'

export interface Bm25Dist {
  mean: number
  std: number
  n: number
  /** true = 样本太少，用了 percentile 退化路径（审计用） */
  degenerated: boolean
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0
  return x < 0 ? 0 : x > 1 ? 1 : x
}

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z))
}

/**
 * 从 directed 命中的原始分估分布。
 *
 * `minSamples` 以下走退化路径：直接按排名给分（最高 1、最低 1/n），
 * 而不是硬算一个 std≈0 的 z-score（那会把所有条目压到同一个 sigmoid 值上）。
 */
function estimateDist(samples: number[], minSamples = 5): Bm25Dist {
  const xs = samples.filter((s) => Number.isFinite(s) && s > 0)
  if (xs.length < minSamples) {
    return { mean: 0, std: 1, n: xs.length, degenerated: true }
  }
  const logs = xs.map((x) => Math.log1p(x))
  const mean = logs.reduce((a, b) => a + b, 0) / logs.length
  const variance = logs.reduce((a, b) => a + (b - mean) ** 2, 0) / logs.length
  const std = Math.sqrt(variance)
  return { mean, std: std > 1e-9 ? std : 1e-9, n: xs.length, degenerated: false }
}

/** 相关性归一化：log 压缩长尾 → z-score → sigmoid 压到 [0,1] */
function normRel(bm25: number, dist: Bm25Dist, rank?: { at: number; of: number }): number {
  if (!Number.isFinite(bm25) || bm25 <= 0) return 0
  if (dist.degenerated) {
    // percentile 退化：排名越靠前分越高（1 → 1.0，最后一名 → 1/n）
    if (rank && rank.of > 0) return clamp01(1 - rank.at / rank.of)
    return 0.5
  }
  const z = (Math.log1p(bm25) - dist.mean) / dist.std
  return clamp01(sigmoid(z))
}

/**
 * 优先级归一（契约 §1.2）：**口径是 0~100，不是 1~5**。
 *
 * 实测容器 68 条取值 55~98，无一落在 1~5。若按「离散档位 1~5 → 0.2/0.4/…」
 * 映射，全部条目都会落进兜底值，priority 因子直接失效——这是照 TechDesign
 * 初稿实现会踩的第一个坑。
 */
function normPri(priority: number | undefined): number {
  const p = Number(priority)
  if (!Number.isFinite(p)) return 0.6 // 缺省值 50/100 = 0.5，取略高（缺省条目多为常规记忆）
  return clamp01(p / 100)
}

/** 重要度归一：V1.2 与 pri 同源（来源可信度表随 V1.3 落地） */
function normImp(imp: number | undefined, priority: number | undefined): number {
  if (Number.isFinite(Number(imp))) return clamp01(Number(imp))
  return normPri(priority)
}

export interface ScoreInput {
  meta: ContainerEntry
  origin: 'directed' | 'emergent'
  bm25: number
  imp?: number
  hop?: number
}

export interface ScoreOptions {
  /**
   * 【E3】fresh 取值器：给了就按它算新鲜度（**没给就回落到 `fresh = pri`，即接线前的行为**）。
   * 传入的是"距上次被想起多久"（由 `clock.elapsed` + 投递账本给出），返回 `null` 表示
   * 这条没有可用依据 ⇒ 回落 pri。
   */
  freshLookup?: (item: ScoreInput) => number | null
  config?: RouteConfig
  now?: Date
}

/**
 * 打分主函数。
 *
 * 冷启动豁免的**诚实标注**：V1.2 的 `fresh === pri`，所以 `cold_start_until`
 * 在这里**改不了任何分数**，而 2026-10-09（E 段 · 1.5）Teddy 拍板后**连审计位也取消了**：
「豁免」这一义从未生效过（只写不读），留着它等于留一个"看着有动作、实际无出口"的开关。
`cold_start_until` 按其本义只保留**溯源标记**那一义（"这条的 last_accessed 是回填时编的"）。
 * 真正的豁免（对 fresh 的惩罚做减免）要等 V1.3 有真 fresh 才有意义。
 * 把它写成「V1.2 已生效」就是撒谎。
 */
function scoreEntry(item: ScoreInput, dist: Bm25Dist, rank: { at: number; of: number }, opts: ScoreOptions = {}): ScoredEntry {
  const config = opts.config ?? DEFAULT_ROUTE_CONFIG
  const now = opts.now ?? new Date()
  const w: Weights = config.weights

  const rel = normRel(item.bm25, dist, rank)
  const pri = normPri(item.meta.priority)
  const imp = normImp(item.imp, item.meta.priority)

  // ── 【E3 · 2026-10-09】fresh：默认仍 = pri；接线由**注入的取值器**决定 ────────
  // 契约 §三：V1.2 的 fresh 就是 pri（刻意的静态近似）。E3 把 freshOf 接进这一位，
  // 但**不是无条件接**：A 段证伪只支持"会话内轮次钟"那一支（分数极差 0.126/0.343），
  // 所以是否走真 fresh，由调用方（插件）注入的 `freshLookup` 决定 ——
  // 它同时是**回滚开关**：不注入 ⇒ 行为与接线前逐字相同。
  const freshLookup = opts.freshLookup
  const fresh = freshLookup ? freshLookup(item) ?? pri : pri

  const process = isFreshExempt(item.meta.decay_type)
  const w3 = process ? w.w3_process : w.w3_fresh

  const base = w.w1_rel * rel + w.w2_pri * pri + w.w4_imp * imp
  const score_in = base + w3 * fresh
  // process 豁免 fresh：候选分里不给 w3 项（与 score_in 的差别正在这里）
  const score_cand = process ? base : score_in

  return {
    meta: item.meta,
    origin: item.origin,
    bm25: item.bm25,
    rel,
    pri,
    fresh,
    imp,
    score_in,
    score_cand,
    gatePass: item.origin !== 'emergent',
  }
}

/**
 * 批量打分：**先估分布，再逐条打分**（顺序不能反）。
 *
 * 传进来的候选来自两层，混着 CandidateSeed（扩散产物）与 ScoredEntry（召回产物）。
 * 这里统一收敛成 ScoreInput，再做一次 id 去重——同一条目若被多个 tag 带到，
 * 只保留**跳数最小**的那一次（1 跳优先于 2 跳）。
 */
export function scoreAll(
  items: Array<ScoredEntry | CandidateSeed>,
  opts: ScoreOptions = {},
): { scored: ScoredEntry[]; dist: Bm25Dist } {
  // 用两个 map 分别装两层来源，避免靠类型断言猜身份——
  // 同一条目既可能是召回命中、也可能是扩散产物，靠字段形状判断容易在重构后静默出错。
  const fromRecall = new Map<string, ScoreInput>()
  const fromSeed = new Map<string, { input: ScoreInput; hop: number }>()
  for (const it of items) {
    if ('hop' in it) {
      const seed = it as CandidateSeed
      const prev = fromSeed.get(seed.meta.id)
      // 多条 tag 带出同一条目：只保留跳数最小的一次（1 跳优先于 2 跳）
      if (!prev || seed.hop < prev.hop) {
        fromSeed.set(seed.meta.id, {
          input: { meta: seed.meta, origin: 'emergent', bm25: 0, hop: seed.hop },
          hop: seed.hop,
        })
      }
    } else {
      const sc = it as ScoredEntry
      if (!fromRecall.has(sc.meta.id)) {
        fromRecall.set(sc.meta.id, { meta: sc.meta, origin: sc.origin, bm25: sc.bm25, imp: sc.imp })
      }
    }
  }
  // 召回来源优先于扩散产物（同一条目在两层都出现时，以有 query 相关性背书的那次为准）
  const seen = new Map<string, ScoreInput>(fromRecall)
  for (const [id, v] of fromSeed) if (!seen.has(id)) seen.set(id, v.input)

  const inputs = [...seen.values()]
  // 分布只吃 directed 的真实 BM25 样本（① card/emergent 的 0 是占位值）
  const dist = estimateDist(inputs.filter((i) => i.origin === 'directed').map((i) => i.bm25))

  // 排名只在退化路径下用得上，但仍按 bm25 降序给一个稳定序
  const order = [...inputs].sort((a, b) => b.bm25 - a.bm25).map((i) => i.meta.id)
  const rankOf = new Map(order.map((id, i) => [id, i]))

  const scored = inputs.map((i) =>
    scoreEntry(i, dist, { at: rankOf.get(i.meta.id) ?? 0, of: order.length }, opts),
  )
  return { scored, dist }
}
