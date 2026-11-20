const ZERO_CLASSES = {
    'hot-anchor': 0, 'core-anchor': 0, 'roster-anchor': 0, 'other-layer': 0, inactive: 0, 'no-age-info': 0,
    'age-unknown': 0, floor: 0, healthy: 0, 'over-limit': 0, 'never-delivered': 0, 'rank-above': 0, 'small-pool-fallback': 0,
};
export function chainPlanToDecayPlan(plan) {
    const classes = { ...ZERO_CLASSES };
    const blocked = [];
    const moves = [];
    for (const m of plan.moves) {
        // 【B3】只允许 longterm→archive；其它层（hot 等）拒收并记账，⛔ 不许硬编码 from
        if (m.from !== 'longterm') {
            classes['other-layer']++;
            blocked.push({ id: m.id, why: `链级判据只搬 longterm→archive（本条 from=${m.from}）`, cls: 'other-layer' });
            continue;
        }
        moves.push({ id: m.id, from: 'longterm', to: 'archive', fresh: m.state, reason: m.reason });
    }
    // 【B3】把护栏计数搬进 classes（否则账面永远零拦截、阳性对照判不了）
    for (const row of plan.tiers) {
        if (!row.guarded)
            continue;
        const cls = row.guarded === 'core' ? 'core-anchor'
            : row.guarded === 'hot' ? 'hot-anchor'
                : row.guarded === 'pinned' ? 'roster-anchor'
                    : row.guarded === 'never-delivered' ? 'never-delivered'
                        : row.guarded === 'inactive' ? 'inactive'
                            : 'no-age-info';
        classes[cls]++;
    }
    classes['over-limit'] += plan.stats.overLimit;
    return { moves, blocked, classes, pool: plan.stats.entries };
}
