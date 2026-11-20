/**
 * V1.2 路由共享类型（契约清单 §五）
 *
 * 与 TechDesign §2.4 的 ScoredEntry 一致，但补了两处**实现必需**的定义：
 *   ① `CandidateSeed` —— 扩散阶段的中间类型。TechDesign 里直接把
 *      `{entry, origin, bm25:0, hop}` 塞进 `Map<string, ScoredEntry>`，
 *      而 ScoredEntry 有 7 个必填字段——那个 Map 的类型根本不成立。
 *      拆成「扩散产出 seed」→「打分补全 entry」两段，类型才自洽。
 *   ② `gatePass` 在 seed 阶段不存在：门禁是打分之**后**的事，提前给默认值
 *      会让「未过线」和「还没校验」两种状态无法区分。
 */
/**
 * 甲方案：`w2_pri = 0`。
 *
 * 理由（契约 §3.1）：`fresh = pri` 时若 `w2` 保留，实际权重变成 `(w2 + w3)·pri`——
 * priority 在 V1.2 翻倍、到 V1.3 又腰斩，**标定结论跨不了版本**。
 * 把 w2 归零让 priority 只由 w3 承担，V1.3 再把 w2 恢复并重新标定。
 *
 * ⚠️ 权重是**初值，不是标定值**——契约 §七 表里标 * 的那批等同处理。
 */
/**
 * ⚠️ 本表所有数值均为**初值，未标定**。
 * 标定是 V1.3 的工作（虚拟时钟回放 + 参数标定方法论），标定结果在项目回执的
 * 「V1.3 更新」章节逐条加 `*`。**不要把这些值当成调优结论引用。**
 */
export const DEFAULT_ROUTE_CONFIG = {
    /**
     * 【D1 · 去重投递】已常驻（`hot_order`）的条目是否**排除**在动态段之外。
     *
     * 为什么默认 true：面①（系统提示词 hot 段）每轮都在投这些条目，面②再投一次 =
     * **同一份内容付两次 token**，而且第二份进的是"不可自替换"的那类通道
     * （实测：某查询 6 个动态槽位里 3 个是已常驻条目）。排除后**补位自动发生**。
     * 回滚：置 false 即回到旧行为（两面都投）。
     */
    exclude_hot_from_route: true,
    weights: { w1_rel: 0.4, w2_pri: 0, w3_fresh: 0.4, w4_imp: 0.2, w3_process: 0 },
    /**
     * `max_entries: 6` 是 **2026-10-03 标定出来的**，不是拍的（证据在验收报告 §四-⑤）：
     *   · 现状（0 = 不限）：注入中位 9 条、空期望题平均 7 条、709 token/轮
     *   · 6：注入中位 6 条（判据 ≤6 ✓）、漏掉率 0、约 550 token/轮
     *   · 3：更省，但标定集上开始漏（2 题）—— "省到开始丢东西"的位置
     * 回滚：把这一行改回 `max_entries: 0`（或整行删掉，字段默认 0）。
     */
    budget: { hard_cap: 16_000, guaranteed_quota: 12, max_entries: 6 },
    gate_threshold_abs: 0.34,
    gate_in_keep_fraction: 0.5,
    keep_alive_priority: 90,
    max_seeds: 10,
    max_candidates: 20,
    max_fanout: 60,
};
/** 衰减类型 → 是否参与新鲜度计算（process 豁免） */
export function isFreshExempt(decayType) {
    return decayType === 'process';
}
