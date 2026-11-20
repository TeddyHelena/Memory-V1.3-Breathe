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
const round3 = (x) => (x === null ? null : Math.round(x * 1000) / 1000);
function mean(xs) {
    if (xs.length === 0)
        return null;
    return xs.reduce((a, b) => a + b, 0) / xs.length;
}
/**
 * 最近秩法（nearest-rank）：向上取整到**实际存在**的那个值，不做插值。
 * 理由同本项目其它统计：不造不存在的数。n=2 的 p50 就是较小那个，不是两者的均值。
 */
function percentile(xs, p) {
    if (xs.length === 0)
        return null;
    const sorted = [...xs].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
    return sorted[idx];
}
function cloneRound(r) {
    if (!r)
        return null;
    return {
        at: r.at,
        query: r.query,
        queryKey: r.queryKey,
        recalled: { ...r.recalled },
        scored: r.scored,
        gated: { ...r.gated },
        gateIn: { ...r.gateIn },
        injected: r.injected,
        candidates: r.candidates,
        capped: r.capped,
        picked: r.picked.map((p) => ({ ...p })),
        renderedChars: r.renderedChars,
        ms: r.ms,
        skipped: r.skipped,
        ...(r.error === undefined ? {} : { error: r.error }),
    };
}
export class RouteDashboard {
    capacity;
    rounds = [];
    constructor(capacity = 20) {
        this.capacity = Math.max(1, Math.trunc(capacity));
    }
    get size() {
        return this.rounds.length;
    }
    record(round) {
        this.rounds.push(round);
        if (this.rounds.length > this.capacity)
            this.rounds.splice(0, this.rounds.length - this.capacity);
    }
    reset() {
        this.rounds = [];
    }
    snapshot() {
        const rounds = this.rounds;
        const active = rounds.filter((r) => r.skipped === null);
        const injected = active.map((r) => r.injected);
        const cappedTotal = active.reduce((n, r) => n + (r.capped ?? 0), 0);
        const scores = active.map((r) => r.scored);
        const chars = active.map((r) => r.renderedChars);
        const totalInjected = injected.reduce((a, b) => a + b, 0);
        const totalScored = scores.reduce((a, b) => a + b, 0);
        let pairs = 0;
        let base = 0;
        let hit = 0;
        for (let i = 1; i < rounds.length; i++) {
            const prev = rounds[i - 1];
            const cur = rounds[i];
            if (prev.skipped !== null || cur.skipped !== null)
                continue;
            if (prev.picked.length === 0)
                continue;
            const now = new Set(cur.picked.map((p) => p.id));
            pairs++;
            base += prev.picked.length;
            hit += prev.picked.filter((p) => now.has(p.id)).length;
        }
        return {
            window: {
                capacity: this.capacity,
                rounds: rounds.length,
                distinctQueries: new Set(rounds.map((r) => r.queryKey)).size,
                firstAt: rounds[0]?.at ?? null,
                lastAt: rounds[rounds.length - 1]?.at ?? null,
            },
            aggregates: {
                injected: {
                    total: totalInjected,
                    avg: round3(mean(injected)),
                    p50: percentile(injected, 0.5),
                    max: injected.length > 0 ? Math.max(...injected) : null,
                },
                scoredAvg: round3(mean(scores)),
                /** 窗口内被条数上限挡掉的总条数（>0 说明上限正在起作用，值得看一眼挡了谁） */
                cappedTotal,
                injectionRatio: totalScored > 0 ? round3(totalInjected / totalScored) : null,
                renderedChars: {
                    avg: round3(mean(chars)),
                    max: chars.length > 0 ? Math.max(...chars) : null,
                },
                latencyMs: {
                    p50: percentile(rounds.map((r) => r.ms), 0.5),
                    p90: percentile(rounds.map((r) => r.ms), 0.9),
                },
                skipped: {
                    'empty-query': rounds.filter((r) => r.skipped === 'empty-query').length,
                    'empty-main': rounds.filter((r) => r.skipped === 'empty-main').length,
                    error: rounds.filter((r) => r.skipped === 'error').length,
                },
                reuse: { pairs, base, hit, rate: base > 0 ? round3(hit / base) : null },
            },
            last: cloneRound(rounds[rounds.length - 1] ?? null),
            series: rounds.map((r) => ({
                at: r.at,
                query: r.query,
                injected: r.injected,
                candidates: r.candidates,
                capped: r.capped,
                scored: r.scored,
                gatedPassed: r.gated.passed,
                gatedFailed: r.gated.failed,
                pickedIds: r.picked.map((p) => p.id),
                renderedChars: r.renderedChars,
                ms: r.ms,
                skipped: r.skipped,
            })),
        };
    }
}
