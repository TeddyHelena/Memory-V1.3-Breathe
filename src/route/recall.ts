/**
 * recall.ts —— V1.2 三层召回（契约清单 §五）
 *
 * ┌ 层 ────────┬ 数据源 ─────────────────┬ 成本 ─┬ 去向 ────────────┐
 * │ ② directed  │ hot 倒排 + longterm BM25 │ 复用 V1.1 │ 动态打分 → main      │
 * │ ③ emergent  │ 对 ② 的种子做 1 跳扩散    │ 受 fanout 限 │ 过硬门禁 → 候选区 │
 * └────────────┴──────────────────────────┴────────┴──────────────────┘
 *
 * ── 两条刻意的实现选择 ────────────────────────────────────────────
 * ① **emergent 收 seeds 参数，不自己再跑一遍 directed**。
 *    TechDesign 初稿里 `emergent(query, ctx)` 内部又调了一次 `directed(query, ctx)`——
 *    而 router 在同一轮的 `Promise.all` 里已经跑过。那是每轮白跑一遍全量 BM25。
 * ② **`invertedTagIndex` 是显式构建的常驻 Map**，不是每轮现搭。
 *    TechDesign 从没定义它的类型和构建时机，落地时最容易被写成"每轮重建"，
 *    而那恰好把 V1.1 好不容易压到 77ms 的检索又拖回去。
 */

import type { MemoryContainer } from '../container.js'
import type { ContainerEntry, MemoryScopeContext } from '../types.js'
import { searchLongterm } from '../search.js'
import { isInjectable, scopeAllowsMeta, temporalState } from '../policy.js'
import type { CandidateSeed, Origin, ScoredEntry } from './types.js'
import type { RouteConfig } from './types.js'

/** tag → 条目元信息（倒排索引；构建一次，写入后由插件置脏重建） */
export type InvertedTagIndex = Map<string, ContainerEntry[]>

export interface RecallContext {
  container: MemoryContainer
  config: RouteConfig
  /** 常驻倒排（见 buildInvertedTagIndex） */
  tagIndex: InvertedTagIndex
  scopeContext?: MemoryScopeContext
  now?: Date
}

/**
 * 构建 tag 倒排。
 *
 * 只在「索引变更」后重建（插件侧用索引指纹判断），**不要每轮调用**。
 * 成本：O(总 tag 数)，68 条规模下亚毫秒级；2000 条量级见 VERIFICATION.md 的检索基线。
 */
export function buildInvertedTagIndex(entries: ContainerEntry[]): InvertedTagIndex {
  const index: InvertedTagIndex = new Map()
  for (const e of entries) {
    for (const tag of e.tags ?? []) {
      const bucket = index.get(tag)
      if (bucket) bucket.push(e)
      else index.set(tag, [e])
    }
  }
  return index
}

/** 未参与打分的裸命中（card 层零成本，直接给满分语义） */
function toScored(meta: ContainerEntry, origin: Origin, bm25: number, imp: number): ScoredEntry {
  return {
    meta,
    origin,
    bm25,
    rel: 0,
    pri: 0,
    fresh: 0,
    imp,
    score_in: 0,
    score_cand: 0,
    gatePass: origin !== 'emergent', // card/directed 信任召回；emergent 待门禁判定
  }
}

/*
 * ── ① 「身份卡」层已删除（2026-10-03，V1.2 清悬空 ④）────────────────────
 *
 * 原设计：identityCards() 产出 prefixStable，声称"每轮不变 → 进系统提示词缓存前缀"。
 * 实测（生产容器）：它产出 22 条，其中 10 条与 hot_order 完全相同，
 * 另外 12 条（a07–a12 归档、l-e03–l-e08 证据版）**从来没有进过提示词**——
 * 而路由结果里的 prefixStable 也没有任何消费方（注入面只有 main）。
 *
 * 为什么删而不是接：**hot_order 已经是"什么进前缀"的唯一真源**
 * （人工策展 + 16000 字符预算）。再算一份卡片集合 = 第二个真源，
 * 而它多出来的 12 条恰恰是人工决定不注入的归档/证据条目。
 * 接上去的真实效果是"绕过人工策展多注入约 12 条常驻内容"，那是成本决策，不是清理。
 *
 * 边界（写死）：身份内容的投递路径是 hot 层（见 persona.renderHotBlockDetailed
 * 与 index.ts 的 hot 段），**不经过路由**。路由只管"这一轮该想起什么"。
 */

/**
 * ② 定向召回：hot 池倒排（便宜）+ longterm BM25（复用 V1.1）。
 *
 * hot 池命中给一个**保守的伪 BM25 分**（tag 命中计数 × 权重）——
 * 它的作用只是让 hot 命中能参与排序，不假装是 BM25 分。
 * 归一化在 score.ts 里只对 `origin === 'directed' && bm25 > 0` 的样本统计，
 * 所以这里的伪分数**不会污染分布**（见 score.ts 的 dist 说明）。
 */
export function directed(ctx: RecallContext, query: string, topK = 12): ScoredEntry[] {
  const index = ctx.container.getIndex()
  const hotIds = new Set(index.hot_order ?? [])
  const tokens = tokenizeLoose(query)
  const seen = new Set<string>()
  const out: ScoredEntry[] = []

  // hot 倒排：tag 与 query token 的交集计数
  // ⛔ 作用域过滤（2026-10-09 安全修复）：这条路此前**一行过滤都没有**，
  //    而 hot 倒排是"按 id 名单直取"，绕过 searchLongterm 的作用域闸 ⇒ 泄漏。
  if (tokens.size > 0) {
    for (const meta of index.entries) {
      if (!hotIds.has(meta.id)) continue
      if (!scopeAllowsMeta(meta, ctx.scopeContext)) continue
      // ⛔ 时态过滤（与面①共用 `isInjectable`）：过期/废弃/stale 不许经面②注入。
      //    修前实测：面①挡住了，面②照样把它注进来。
      if (!isInjectable(temporalState(meta, ctx.now))) continue
      const hit = (meta.tags ?? []).filter((t) => tokens.has(t.toLowerCase())).length
      if (hit === 0) continue
      seen.add(meta.id)
      out.push(toScored(meta, 'directed', hit, 1))
    }
  }

  // longterm/archive：复用既有 BM25（唯一被改动的既有检索入口是调用方，不是实现）
  const hits = searchLongterm(ctx.container, query, {
    topK,
    scopeContext: ctx.scopeContext,
    now: ctx.now,
  })
  for (const h of hits) {
    if (seen.has(h.id)) continue
    const meta = ctx.container.entryMeta(h.id)
    if (!meta) continue
    seen.add(h.id)
    out.push(toScored(meta, 'directed', Number.isFinite(h.score) ? h.score : 0, 0.8))
  }
  return out
}

/**
 * ③ 联想涌现：对 ② 的种子沿 tags 扩散 1 跳（候选不足时可 2 跳）。
 *
 * 硬约束：
 *   - **种子不回流**（`visited` 一开始就含全部种子 id）——否则同一条目会以
 *     `directed` 与 `emergent` 两个身份进打分，bm25=0 那次会拉低自己的归一化分。
 *   - fan-out 有上限（`max_fanout`），且 `candidateCount` 是**真实计数**。
 *   - 每跳只沿**种子自身的 tags** 走（不做全图游走）。
 */
export function emergent(
  ctx: RecallContext,
  seeds: ScoredEntry[],
  opts: { secondHop?: boolean } = {},
): CandidateSeed[] {
  const visited = new Set(seeds.map((s) => s.meta.id))
  const out: CandidateSeed[] = []
  let candidateCount = 0

  const hopOnce = (from: ScoredEntry[], hop: number) => {
    for (const seed of from.slice(0, ctx.config.max_seeds)) {
      for (const tag of seed.meta.tags ?? []) {
        const bucket = ctx.tagIndex.get(tag)
        if (!bucket) continue
        for (const neighbor of bucket) {
          if (visited.has(neighbor.id)) continue
          // ⛔ 作用域过滤（2026-10-09 安全修复）：倒排索引由**全量 entries** 构建
          //    （见 router 的 buildInvertedTagIndex 调用），tag 相同的别作用域条目
          //    会顺着种子跳进来 —— 这是本仓"跨项目记忆泄漏"的另一条路径。
          if (!scopeAllowsMeta(neighbor, ctx.scopeContext)) continue
          // ⛔ 时态过滤：墓碑/过期条目的 tags 仍躺在倒排里，会把邻居带进候选区
          //    （既占名额，又让"已删除"的内容顺着关联浮现）。
          if (!isInjectable(temporalState(neighbor, ctx.now))) continue
          if (candidateCount >= ctx.config.max_fanout) return
          if (out.length >= ctx.config.max_candidates) return
          visited.add(neighbor.id)
          candidateCount += 1
          out.push({ meta: neighbor, origin: 'emergent', hop, via: tag })
        }
      }
    }
  }

  hopOnce(seeds, 1)

  // 2 跳：只在候选不足时触发（契约 §五：2 跳是补救，不是常态）
  if (opts.secondHop && out.length < Math.floor(ctx.config.max_candidates / 2)) {
    const asScored = out.map((s) => toScored(s.meta, 'emergent', 0, 0.5))
    hopOnce(asScored, 2)
  }

  return out
}

/**
 * 宽松分词（V1.2 关键词相似度与 hot 倒排共用）。
 *
 * 单独写一份、不复用 search.ts 的 `tokenize`：后者是**为 BM25 调过的**
 * （带停用词表与固定 2-gram 切法），而门禁要的是「两个短文本有多像」，
 * 口径不同。分成两处的好处是各自的参数可以独立演进，坏处是两套词法——
 * 这里选择「口径独立」而不是「代码复用」。
 */
export function tokenizeLoose(text: string): Set<string> {
  const out = new Set<string>()
  const lower = text.toLowerCase()
  for (const w of lower.match(/[a-z0-9]{2,}/g) ?? []) out.add(w)
  const cn = lower.replace(/[^\u4e00-\u9fa5]+/g, '')
  for (let i = 0; i < cn.length - 1; i++) out.add(cn.slice(i, i + 2))
  if (cn.length === 1) out.add(cn)
  return out
}
