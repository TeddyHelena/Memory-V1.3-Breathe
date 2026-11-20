/**
 * ── 【P8 · 2026-10-19】候选转正配额（纯函数；接线开关默认关）────────────
 * 口径：每活跃日最多 3 条；必须有真会话 id；相似度超闸门的先不进。
 * ⛔ 只决定“谁可以转”，不执行转正本身。
 */
export interface PendingCandidate {
    id: string;
    source_session?: string;
    /** 与已有条目的最大相似度（0~1）；缺省 0 = 不拦 */
    similarity?: number;
}
export declare function selectPromotable(candidates: readonly PendingCandidate[], alreadyToday: number, options?: {
    cap?: number;
    maxSimilarity?: number;
}): string[];
