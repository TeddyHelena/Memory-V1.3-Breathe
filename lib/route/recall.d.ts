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
import type { MemoryContainer } from '../container.js';
import type { ContainerEntry, MemoryScopeContext } from '../types.js';
import type { CandidateSeed, ScoredEntry } from './types.js';
import type { RouteConfig } from './types.js';
/** tag → 条目元信息（倒排索引；构建一次，写入后由插件置脏重建） */
export type InvertedTagIndex = Map<string, ContainerEntry[]>;
export interface RecallContext {
    container: MemoryContainer;
    config: RouteConfig;
    /** 常驻倒排（见 buildInvertedTagIndex） */
    tagIndex: InvertedTagIndex;
    scopeContext?: MemoryScopeContext;
    now?: Date;
}
/**
 * 构建 tag 倒排。
 *
 * 只在「索引变更」后重建（插件侧用索引指纹判断），**不要每轮调用**。
 * 成本：O(总 tag 数)，68 条规模下亚毫秒级；2000 条量级见 VERIFICATION.md 的检索基线。
 */
export declare function buildInvertedTagIndex(entries: ContainerEntry[]): InvertedTagIndex;
/**
 * ② 定向召回：hot 池倒排（便宜）+ longterm BM25（复用 V1.1）。
 *
 * hot 池命中给一个**保守的伪 BM25 分**（tag 命中计数 × 权重）——
 * 它的作用只是让 hot 命中能参与排序，不假装是 BM25 分。
 * 归一化在 score.ts 里只对 `origin === 'directed' && bm25 > 0` 的样本统计，
 * 所以这里的伪分数**不会污染分布**（见 score.ts 的 dist 说明）。
 */
export declare function directed(ctx: RecallContext, query: string, topK?: number): ScoredEntry[];
/**
 * ③ 联想涌现：对 ② 的种子沿 tags 扩散 1 跳（候选不足时可 2 跳）。
 *
 * 硬约束：
 *   - **种子不回流**（`visited` 一开始就含全部种子 id）——否则同一条目会以
 *     `directed` 与 `emergent` 两个身份进打分，bm25=0 那次会拉低自己的归一化分。
 *   - fan-out 有上限（`max_fanout`），且 `candidateCount` 是**真实计数**。
 *   - 每跳只沿**种子自身的 tags** 走（不做全图游走）。
 */
export declare function emergent(ctx: RecallContext, seeds: ScoredEntry[], opts?: {
    secondHop?: boolean;
}): CandidateSeed[];
/**
 * 宽松分词（V1.2 关键词相似度与 hot 倒排共用）。
 *
 * 单独写一份、不复用 search.ts 的 `tokenize`：后者是**为 BM25 调过的**
 * （带停用词表与固定 2-gram 切法），而门禁要的是「两个短文本有多像」，
 * 口径不同。分成两处的好处是各自的参数可以独立演进，坏处是两套词法——
 * 这里选择「口径独立」而不是「代码复用」。
 */
export declare function tokenizeLoose(text: string): Set<string>;
