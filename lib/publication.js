import { chainPlanToDecayPlan } from './chain-adapter.js';
const CALENDAR_N_DEFAULT = 7;
/** 每批公示上限（与 chain plan 的每批搬走上限分开） */
const NOTICE_LIMIT = 20;
function plusDays(wallDay, days) {
    const [y, m, d] = wallDay.split('-').map(Number);
    const dt = new Date(y, m - 1, d + days);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}
/** 生成公示（剔除已钉住；同时记活跃日与墙钟日两个到期口径） */
export function planNotice(forgetIds, pinned, activeDay, N, wallDay, calendarN = CALENDAR_N_DEFAULT) {
    return {
        ids: forgetIds.filter((id) => !pinned.has(id)),
        publishedDay: activeDay,
        expireDay: activeDay + Math.max(1, N),
        ...(wallDay ? { publishedWallDay: wallDay, expireWallDay: plusDays(wallDay, Math.max(1, calendarN)) } : {}),
    };
}
/** 订阅期到了吗：活跃日 ≥ expireDay **且**（若记了墙钟日）墙钟日 ≥ expireWallDay */
export function isMatured(notice, activeDay, wallDay) {
    if (activeDay < notice.expireDay)
        return false;
    if (notice.expireWallDay && wallDay && wallDay < notice.expireWallDay)
        return false;
    return true;
}
/** 到期可遗忘的 id（仍剔除钉住；订阅期未到返回空） */
export function dueForgetting(notice, pinned, activeDay, wallDay) {
    if (!isMatured(notice, activeDay, wallDay))
        return [];
    return notice.ids.filter((id) => !pinned.has(id));
}
/** 空清单行（“今日无”也是投递，算公示不断档） */
export function emptyNoticeRow(activeDay) {
    return { day: activeDay, ids: [], note: '今日无' };
}
/**
 * 空计划（P7 计算失败时的**保守替身**）：⛔ 只搬 due 的路径绝不能退化成“搬全部”。
 * 只用在“公示批次算不出来”的异常路径；正常路径永远用 `planPublicationBatch().override`。
 */
export function emptyDecayPlan() {
    return chainPlanToDecayPlan({
        moves: [],
        tiers: [],
        stats: { conversations: 0, entries: 0, byTier: { full: 0, snapshot: 0, outline: 0, forget: 0 }, projectState: 0, overLimit: 0, H: 0, theta: 0 },
    });
}
export function planPublicationBatch(input) {
    const prevDue = input.prev !== null && isMatured(input.prev, input.today, input.wallDay);
    const due = prevDue && input.prev ? dueForgetting(input.prev, input.pins, input.today, input.wallDay) : [];
    const dueSet = new Set(due);
    const moveById = new Map(input.plan.moves.map((m) => [m.id, m]));
    const tierById = new Map(input.plan.tiers.map((t) => [t.id, t]));
    // ⛔ 只搬 due：其余候选哪怕也在 forget 档，也必须等自己的订阅期到期。
    // 【B1 · 2026-10-26】到期条目可能因池内分位排名变化已不在当前 moves 里，
    // 但它已经在 N 天前被公示、用户没有 pin ⇒ 不能因为“今天排名变了”就静默留在库里。
    // 只对仍在 longterm、未护栏的 due 补一条到期 move；已 archive（崩后重入）不补，由 due 真值账处理。
    const dueMoves = [];
    for (const id of due) {
        const layer = input.layerOf?.(id);
        if (layer !== undefined && layer !== null && layer !== 'longterm')
            continue;
        const m = moveById.get(id);
        if (m) {
            dueMoves.push(m);
            continue;
        }
        const tier = tierById.get(id);
        if (!tier || tier.guarded)
            continue;
        if (layer !== 'longterm')
            continue;
        dueMoves.push({
            id, from: 'longterm', to: 'archive', state: tier.state, ageDays: tier.ageDays, convId: tier.convId,
            reason: '到期批次（订阅期已满；当前排序已变）',
        });
    }
    const override = chainPlanToDecayPlan({ ...input.plan, moves: dueMoves });
    // ⛔ A：prev 未到期 ⇒ 不落新批次（否则就是重签订阅期，P0-1 复发）
    const publishNew = input.prev === null || prevDue;
    const candidateIds = input.plan.moves.filter((m) => !dueSet.has(m.id)).map((m) => m.id);
    // 每批只公示前 NOTICE_LIMIT 条；due 不占下一批名额（修前 plan 被 limit=20 截断，
    // 到期后下一批只剩 1 条、其余 9 条要再等一期的空洞）
    const noticeIds = candidateIds.slice(0, NOTICE_LIMIT);
    const notice = publishNew
        ? planNotice(noticeIds, input.pins, input.today, input.N ?? 3, input.wallDay, input.calendarN ?? CALENDAR_N_DEFAULT)
        : null;
    const waiting = publishNew
        ? Math.max(0, candidateIds.length - noticeIds.length)
        : input.plan.moves.length;
    const batch = `pub-${input.wallDay}`;
    const seen = new Set(input.seenBatches);
    const prevBatch = input.prev?.batch ?? null;
    const dueBatch = prevBatch === null ? null : `due-${prevBatch}`;
    return {
        batch,
        day: input.today,
        due,
        prevDue,
        prevCount: input.prev?.ids.length ?? 0,
        publishNew,
        override,
        executed: override.moves.map((m) => m.id),
        notice,
        waiting,
        overLimit: waiting,
        prevBatch,
        dueBatch,
        dueDuplicate: dueBatch !== null && seen.has(dueBatch),
        intentBatch: dueBatch === null ? null : `intent-${dueBatch}`,
        intentDuplicate: dueBatch !== null && seen.has(`intent-${dueBatch}`),
        duplicate: publishNew && seen.has(batch),
    };
}
