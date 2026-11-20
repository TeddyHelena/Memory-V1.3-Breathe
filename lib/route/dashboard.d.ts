/**
 * route/dashboard.ts —— 路由仪表盘（V1.2 出口件）
 *
 * 存在理由（事故，不是设计偏好）：
 * `RouteStats` 从 09-23 起每轮都在算，但**没有任何出口**——"这一轮为什么选了这几条"
 * 只活在一次性内存里，验收只能靠"读日志"。没有出口，标定（②）与接线（③）都无法验收：
 * 你没法证明自己改好了，也没法证明没改坏。
 *
 * ── 边界（写死，防止它长成第二个真源）────────────────────────────────
 *   ① **只读观测**：不参与召回 / 打分 / 门禁 / 预算的任何决策，不改分值、不改集合。
 *   ② **不落盘**：进程重启即清空。历史真源是容器与对话存档，这里只是观察窗。
 *   ③ **有界**：容量固定，超出丢最旧；内存占用与总轮数无关。
 *   ④ **诚实**：skipped 的轮次照记（empty-query / empty-main / error）——
 *      「没注入」和「注入了 0 条」在聚合口径里是两件事，不许平均掩盖。
 */
/** 被选中注入的条目（id + 分项，用于回答"为什么是它"） */
export interface RoutePicked {
    id: string;
    origin: string;
    rel: number;
    pri: number;
    score: number;
}
export type RouteSkip = 'empty-query' | 'empty-main' | 'error' | null;
/** 一次装配（= 宿主调一次 text()）的完整观测 */
export interface RouteRound {
    at: string;
    /** 查询正文（截断，只用于人看） */
    query: string;
    /** 查询指纹：同一轮多次装配可辨重 */
    queryKey: string;
    recalled: {
        directed: number;
        emergent: number;
    };
    scored: number;
    gated: {
        passed: number;
        failed: number;
    };
    gateIn: {
        baseSet: string;
        fraction: number;
        value: number | null;
        eligible: number;
    };
    /** 真正注入条数 */
    injected: number;
    /** 联想候选区条数（不注入） */
    candidates: number;
    /** 本轮被**条数硬上限**挡掉的条数（0 = 没挡）。改行为必须同时改可观测性 */
    capped: number;
    picked: RoutePicked[];
    /** 实际渲染进上下文的字符数（宿主计费口径，不是估算） */
    renderedChars: number;
    ms: number;
    skipped: RouteSkip;
    error?: string;
}
export interface RouteSeriesRow {
    at: string;
    query: string;
    injected: number;
    candidates: number;
    capped: number;
    scored: number;
    gatedPassed: number;
    gatedFailed: number;
    pickedIds: string[];
    renderedChars: number;
    ms: number;
    skipped: RouteSkip;
}
export interface RouteDashboardSnapshot {
    window: {
        capacity: number;
        rounds: number;
        distinctQueries: number;
        firstAt: string | null;
        lastAt: string | null;
    };
    aggregates: {
        injected: {
            total: number;
            avg: number | null;
            p50: number | null;
            max: number | null;
        };
        scoredAvg: number | null;
        /** 窗口内被条数上限挡掉的总条数（>0 说明上限正在起作用——值得看一眼挡了谁） */
        cappedTotal: number;
        /** 注入条数 / 进入打分的条数。精确率的下界直觉，不是精确率本身。 */
        injectionRatio: number | null;
        renderedChars: {
            avg: number | null;
            max: number | null;
        };
        latencyMs: {
            p50: number | null;
            p90: number | null;
        };
        skipped: {
            'empty-query': number;
            'empty-main': number;
            error: number;
        };
        /** 复用：上一次注入了的条目，这一次又被选中的比例（按条目加权，跨 skipped 轮跳过） */
        reuse: {
            pairs: number;
            base: number;
            hit: number;
            rate: number | null;
        };
    };
    /** 最近一次装配的完整记录（含分项 → "为什么是这几条"） */
    last: RouteRound | null;
    series: RouteSeriesRow[];
}
export declare class RouteDashboard {
    private readonly capacity;
    private rounds;
    constructor(capacity?: number);
    get size(): number;
    record(round: RouteRound): void;
    reset(): void;
    snapshot(): RouteDashboardSnapshot;
}
