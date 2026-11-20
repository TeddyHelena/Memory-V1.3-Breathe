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
import type { ContainerEntry, DecayType } from '../types.js';
/** 召回来源（门禁只对 emergent 做硬校验） */
export type Origin = 'directed' | 'emergent';
/** 扩散阶段的中间产物：只有结构信息，没有分数 */
export interface CandidateSeed {
    meta: ContainerEntry;
    origin: 'emergent';
    /** 从种子到这里走了几跳（1 或 2） */
    hop: number;
    /** 触达路径（哪个 tag / source 把它带进来的），供审计 */
    via: string;
}
/** 打分中间结构（完整） */
export interface ScoredEntry {
    meta: ContainerEntry;
    origin: Origin;
    /** BM25 原始分；card 与 emergent 为 0（**不参与分布统计**） */
    bm25: number;
    /** 归一化相关性 0~1 */
    rel: number;
    /** 优先级 0~1（由 0~100 归一，见契约 §1.2） */
    pri: number;
    /**
     * 新鲜度 0~1。
     * **V1.2 恒等于 `pri`**（契约 §三：`fresh = pri`）——
     * 这不是占位待办，而是刻意的静态近似：V1.3 把 `decay.freshOf` 插进这一位即可，
     * `w` 向量的结构不动。
     */
    fresh: number;
    /** 重要度 0~1。V1.2 与 pri 同源（来源可信度表随 V1.3 落地） */
    imp: number;
    score_in: number;
    score_cand: number;
    /** 硬门禁是否通过；emergent 未过线 = false → 禁入 main */
    gatePass: boolean;
}
/** 路由统计：用于审计与效果指标 */
export interface RouteStats {
    recall: {
        directed: number;
        emergent: number;
    };
    scanned: number;
    scored: number;
    gated: {
        passed: number;
        failed: number;
    };
    main: number;
    candidates: number;
    /**
     * 因**条数硬上限**被挤进候选区的条数（`budget.max_entries`）。
     * 为什么必须观测它：上限是"主动少注入"，一旦它开始挡掉该想起的东西，
     * 唯一能发现的地方就是这里 —— 静默的截断等于静默的遗忘。
     */
    capped: number;
    /**
     * gate_in 实际用的基准集合与门槛值（**可审计的运行期事实**，不是注释里的承诺）。
     * `value === null` = 基准集合（gatePassed）为空 → 未抬门槛。
     */
    gateIn: {
        baseSet: 'gatePassed';
        fraction: number;
        value: number | null;
        eligible: number;
    };
    /** 每个未进 main 的目标：hot-resident/gate/max-entries/gate-in/budget-chars（R1 trace） */
    drops?: Record<string, string>;
    /** 各阶段耗时（ms） */
    timing: {
        recall: number;
        score: number;
        gate: number;
        budget: number;
        total: number;
    };
}
export interface RouteResult {
    /** 注入「用户轮次」的条目（过 gate_in，受字符预算约束）——**不进系统前缀** */
    main: ScoredEntry[];
    /** 联想候选区（低置信度，不注入主上下文） */
    candidates: ScoredEntry[];
    stats: RouteStats;
}
/** 权重向量（甲方案：V1.2 的 w2_pri = 0，priority 由 w3 独扛，避免 priority 双计） */
export interface Weights {
    w1_rel: number;
    w2_pri: number;
    w3_fresh: number;
    w4_imp: number;
    /** process 豁免 fresh 的专用第三位 */
    w3_process: number;
}
export interface RouteBudget {
    /** 主注入 summary 字符上限 */
    hard_cap: number;
    /** 保底条数上限（identity_card 或 priority >= 90） */
    guaranteed_quota: number;
    /**
     * **主注入条数硬上限**；`0` = 不限（默认，保持既有行为）。
     *
     * 为什么需要它（2026-10-03 标定实测）：条数实际由 `guaranteed_quota` 决定，
     * 而保底路径**不参与相关性裁决** —— 容器里 66/80 条 `priority ≥ 70`，
     * 于是一句「嗯」也会被塞进约 12 条"重要的"。字符预算拦不住它：
     * 2000 字符装得下 15 条摘要（实测 hard_cap=2000 与 16000 的注入条数完全相同）。
     *
     * 语义写死（免得日后各说各话）：**硬上限，保底条目也计入**。
     * 想保住全部身份卡，就把值设得不小于保底条数。
     * **值本身是标定项，不在这里拍**（判据：注入中位 ≤ 6 且标定集漏掉率 0）。
     */
    max_entries: number;
}
export interface RouteConfig {
    weights: Weights;
    budget: RouteBudget;
    /**
     * 【D1 · 去重投递】已常驻（`hot_order`）的条目**是否排除在动态段之外**。
     *
     * 为什么默认 `true`：面①（系统提示词 hot 段）每轮都在投这些条目，面②再投一次 =
     * **同一份内容付两次 token**，而且第二份进的是**不可自替换**的那类通道。
     * 实测（真身 375 次装配）：某些查询 6 个动态槽位里 **3 个**是已常驻条目。
     * 排除放在 `allocate` 的 eligible **之前** ⇒ **补位自动发生**（会照常取下一名）。
     * 回滚：置 `false` 即回到旧行为（两面都投）。
     */
    exclude_hot_from_route: boolean;
    /** 硬门禁关键词相似度阈值（绝对阈值，不是分位数） */
    gate_threshold_abs: number;
    /**
     * gate_in 的**保留比例**：保留分数最高的前 X 比例（0.5 = 留一半）。
     *
     * ⚠️ 方向写死：**值越大越松**（1.0 ≈ 全留，0.1 = 只留前 10%）。
     * 原名 `gate_in_quantile` + 注释"相对分位数门槛"是**反向误导**——
     * 2026-10-03 控制变量实测：0.1 → 门槛 0.82（严，2 条）、0.9 → 门槛 0.42（松，7 条）；
     * 照名字"调高一点让它更严"的人，会把注入条数从 2 条调到 7 条。
     * 行为一字未改，只把名字与语义对齐（见 contract/layer.ts 的 quantileOver：
     * 降序取「前 fraction 比例的边界值」）。
     */
    gate_in_keep_fraction: number;
    /** 保底判定阈值（priority 口径 0~100，契约 §1.2） */
    keep_alive_priority: number;
    /** 扩散参数 */
    max_seeds: number;
    max_candidates: number;
    max_fanout: number;
}
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
export declare const DEFAULT_ROUTE_CONFIG: RouteConfig;
/** 衰减类型 → 是否参与新鲜度计算（process 豁免） */
export declare function isFreshExempt(decayType: DecayType | undefined): boolean;
