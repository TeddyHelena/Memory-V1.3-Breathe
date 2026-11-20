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
import type { ContainerEntry } from '../types.js';
import { type CandidateSeed, type RouteConfig, type ScoredEntry } from './types.js';
export interface Bm25Dist {
    mean: number;
    std: number;
    n: number;
    /** true = 样本太少，用了 percentile 退化路径（审计用） */
    degenerated: boolean;
}
export interface ScoreInput {
    meta: ContainerEntry;
    origin: 'directed' | 'emergent';
    bm25: number;
    imp?: number;
    hop?: number;
}
export interface ScoreOptions {
    /**
     * 【E3】fresh 取值器：给了就按它算新鲜度（**没给就回落到 `fresh = pri`，即接线前的行为**）。
     * 传入的是"距上次被想起多久"（由 `clock.elapsed` + 投递账本给出），返回 `null` 表示
     * 这条没有可用依据 ⇒ 回落 pri。
     */
    freshLookup?: (item: ScoreInput) => number | null;
    config?: RouteConfig;
    now?: Date;
}
/**
 * 批量打分：**先估分布，再逐条打分**（顺序不能反）。
 *
 * 传进来的候选来自两层，混着 CandidateSeed（扩散产物）与 ScoredEntry（召回产物）。
 * 这里统一收敛成 ScoreInput，再做一次 id 去重——同一条目若被多个 tag 带到，
 * 只保留**跳数最小**的那一次（1 跳优先于 2 跳）。
 */
export declare function scoreAll(items: Array<ScoredEntry | CandidateSeed>, opts?: ScoreOptions): {
    scored: ScoredEntry[];
    dist: Bm25Dist;
};
