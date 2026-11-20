/** state = 2^(−age/H) */
export function stateOf(ageDays, H) {
    if (!Number.isFinite(ageDays) || ageDays <= 0)
        return 1;
    return Math.pow(2, -ageDays / Math.max(0.0001, H));
}
/** 档位：完整 / 快照 / 轮廓 / 遗忘 */
export function tierOf(state, theta, full = 0.5, snapshot = 0.25) {
    if (state < theta)
        return 'forget';
    if (state >= full)
        return 'full';
    if (state >= snapshot)
        return 'snapshot';
    return 'outline';
}
/**
 * 纯函数：只算「该动谁 / 谁在哪一档」，⛔ 不改任何数据。
 * 护栏优先级：core > hot > never-delivered > 无年龄。
 */
export function planChainSweep(input) {
    const H = Math.max(0.0001, input.H);
    const theta = input.theta;
    const full = input.tierFull ?? 0.5;
    const snap = input.tierSnapshot ?? 0.25;
    const byConv = new Map(input.conversations.map((c) => [c.convId, c]));
    const rows = [];
    const moves = [];
    const byTier = { full: 0, snapshot: 0, outline: 0, forget: 0 };
    let projectState = 0;
    for (const conv of input.conversations) {
        const age = conv.lastGrownDay === null ? null : Math.max(0, input.today - conv.lastGrownDay);
        const state = age === null ? 0 : stateOf(age, H);
        if (state > projectState)
            projectState = state;
    }
    for (const e of input.entries) {
        const conv = byConv.get(e.convId);
        const hasAge = conv !== undefined && conv.lastGrownDay !== null;
        const age = hasAge ? Math.max(0, input.today - conv.lastGrownDay) : null;
        const state = age === null ? 1 : stateOf(age, H);
        let tier = age === null ? 'full' : tierOf(state, theta, full, snap);
        let guarded;
        if (input.pinned?.has(e.id)) {
            tier = 'full';
            guarded = 'pinned';
        }
        else if (e.decayType === 'core') {
            tier = 'full';
            guarded = 'core';
        }
        // 【P0-2 修复 · 2026-10-19】非 active 一律不参与遗忘（墓碑/已替代/过期）。
        // 旧判据 decay.ts 本来就有这道护栏；链级判据漏了 ⇒ 墓碑进 moves ⇒ relocate 抛错。
        else if (e.status !== undefined && e.status !== 'active') {
            tier = 'full';
            guarded = 'inactive';
        }
        else if (!input.rendering && e.hot) {
            tier = 'full';
            guarded = 'hot';
        }
        else if (!input.rendering && (e.delivered === undefined || e.delivered <= 0)) {
            tier = 'full';
            guarded = 'never-delivered';
        }
        else if (age === null) {
            tier = 'full';
            guarded = 'no-session';
        }
        // 【B1】池内分位选中：护栏之后仍要退；tier 同步改 forget（P6 不能再注入它）。
        const quantileSelected = !guarded && input.quantileMoves?.has(e.id) === true
            && e.layer !== 'archive' && e.layer !== 'pending'
            && (e.status === undefined || e.status === 'active');
        if (quantileSelected && tier !== 'forget')
            tier = 'forget';
        byTier[tier]++;
        rows.push({ id: e.id, convId: e.convId, state, ageDays: age ?? -1, tier, ...(guarded ? { guarded } : {}) });
        if (tier === 'forget' && !guarded && e.layer !== 'archive' && e.layer !== 'pending'
            && (e.status === undefined || e.status === 'active')) {
            moves.push({
                id: e.id,
                from: e.layer,
                to: 'archive',
                state,
                ageDays: age ?? -1,
                convId: e.convId,
                reason: quantileSelected
                    ? `池内分位（Breathe 目标口径；state=${state.toFixed(3)}，H=${H}）`
                    : `链龄 ${age ?? '?'} 活跃日（state=${state.toFixed(3)} < θ=${theta}；H=${H}）`,
            });
        }
    }
    // 【B3】每批上限：按 state 升序（最该忘的先走），超出的记 overLimit，⛔ 不许一次搬空
    const limit = input.limit;
    let overLimit = 0;
    let capped = moves;
    if (limit !== undefined && Number.isFinite(limit) && moves.length > Math.max(0, limit)) {
        capped = [...moves].sort((a, b) => a.state - b.state || a.id.localeCompare(b.id)).slice(0, Math.max(0, limit));
        overLimit = moves.length - capped.length;
    }
    return {
        moves: capped,
        tiers: rows,
        stats: { conversations: input.conversations.length, entries: input.entries.length, byTier, projectState, overLimit, H, theta },
    };
}
