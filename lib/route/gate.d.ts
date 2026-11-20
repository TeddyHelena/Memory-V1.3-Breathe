/**
 * gate.ts —— V1.2 硬门禁（契约清单 §五）
 *
 * ── 校验对象只有一层：联想涌现 ────────────────────────────────────
 * identity_card 与 directed 命中**信任召回**：
 *   - 身份卡是"先验常识"（这人是谁），不参与相关性裁判
 *   - directed 已经过 BM25 相关性筛选，再用关键词相似度复核一遍没有增量信息
 * 只有 emergent 是"引擎自己联想的"——它没有 query 相关性背书，必须过审。
 *
 * ── 两种阈值的分工（曾经混在一起，现在拆开写死）──────────────────
 *   - **硬门禁用绝对阈值**：关键词相似度是一个明确可比的分（0~1），
 *     用绝对线判定"过/不过"语义清晰。
 *   - **分级门禁（gate_in）用相对分位数**：打到分排序层用候选集内部的分位数
 *     切"进 main / 进候选区"。
 * 混用的后果是「阈值随候选集浮动」——同一 query 多召回两条就换了门槛。
 *
 * ── 未过线不等于丢弃 ──────────────────────────────────────────────
 * 未过线 → `gatePass = false` + 进候选区（降权 0.4）。
 * **但降权只在 score_cand 上，不影响 score_in**——所以"禁入 main"这件事
 * 必须由 budget.allocate 显式判 `gatePass`，不能指望降权把分数压下去。
 * TechDesign 初稿正是只做了降权（`score_cand *= 0.4`），而 allocate 按
 * `score_in` 排序——未过线的条目照样能进 main。
 */
import type { RouteConfig, ScoredEntry } from './types.js';
export interface GateResult {
    entries: ScoredEntry[];
    passed: number;
    failed: number;
}
export declare function validate(entries: ScoredEntry[], query: string, config: RouteConfig): GateResult;
