/**
 * ── 【P6 · 2026-10-19】档位渲染（默认关）──────────────────────────
 *
 * 一句话：把 `planChainSweep` 的档位翻译成注入形态，**只在 `chainRender=true` 时启用**。
 * full→正文 / snapshot→摘要 / outline→标题 / forget→不注入。
 *
 * ⛔ 本模块只读容器与账本，不写任何东西；是否启用由调用方（index.ts）的开关决定。
 */
import fs from 'node:fs';
import path from 'node:path';
import { planChainSweep } from './chain.js';
import { planDecaySweep, sweepEntries } from './decay.js';
import { loadPins } from './pins.js';
import { dayKey } from './day-boundary.js';
export function tierModeOf(tier) {
    switch (tier) {
        case 'full': return 'full';
        case 'snapshot': return 'summary';
        case 'outline': return 'title';
        case 'forget': return 'none';
    }
}
/**
 * 计算档位覆盖（读容器 + 活跃日账本；⚠️ 会读 147+ 个条目文件，**调用方必须按天缓存**）。
 */
export function computeTierOverrides(container, subjects, ledger, H, theta, opts = {}) {
    const root = container.root;
    const days = [];
    let badLines = 0;
    // 【P1 修复】单遍解析：解析结果存 rows，后续只遍历数组，⛔ 不再二次 JSON.parse
    const rows = [];
    try {
        for (const line of fs.readFileSync(path.join(root, 'active-days.jsonl'), 'utf-8').split('\n')) {
            if (!line.trim())
                continue;
            try {
                rows.push(JSON.parse(line));
            }
            catch {
                badLines++;
            }
        }
    }
    catch (e) {
        // 文件读不到（ENOENT）⇒ 无账本；其它读错误（EISDIR 等）按全坏处理
        const code = e?.code;
        if (code !== 'ENOENT')
            badLines++;
    }
    for (const r of rows)
        if (typeof r.day === 'string' && !days.includes(r.day))
            days.push(r.day);
    days.sort();
    const dayIndex = new Map(days.map((d, i) => [d, i]));
    const lastBySession = new Map();
    for (const r of rows) {
        const idx = r.day ? dayIndex.get(r.day) : undefined;
        if (idx === undefined || !r.sessionId)
            continue;
        const prev = lastBySession.get(r.sessionId);
        if (prev === undefined || idx > prev)
            lastBySession.set(r.sessionId, idx);
    }
    const convBySession = new Map();
    for (const s of subjects.list())
        if (s.kind === 'conversation' && s.session_id)
            convBySession.set(s.session_id, s.id);
    const conversations = [...convBySession].map(([sessionId, convId]) => {
        if (lastBySession.has(sessionId))
            return { convId, lastGrownDay: lastBySession.get(sessionId) };
        // 【P1】回填会话没有活跃日行：用 subject 的真实 last_grown 映射到“<= 那天的最后一个活跃日”
        const rec = subjects.get(convId);
        const iso = rec?.last_grown ?? rec?.last_activated;
        if (!iso)
            return { convId, lastGrownDay: null };
        const key = dayKey(new Date(iso));
        let idx = null;
        for (let i = 0; i < days.length; i++)
            if (days[i] <= key)
                idx = i;
        return { convId, lastGrownDay: idx };
    });
    const index = container.getIndex();
    const delivered = ledger.deliveredCounts();
    const entries = index.entries.map((meta) => {
        let src = null;
        try {
            src = container.readEntry(meta.id)?.frontmatter?.source_session ?? null;
        }
        catch { /* skip */ }
        return {
            id: meta.id,
            layer: meta.layer,
            status: meta.status,
            decayType: meta.decay_type,
            hot: (index.hot_order ?? []).includes(meta.id),
            delivered: delivered.get(meta.id),
            convId: src ? (convBySession.get(src) ?? '') : '',
        };
    });
    // 【B7/P1】有效行=0 且存在坏行/读错误 ⇒ 宁可抛错（调用方回退旧渲染），也不静默按 0 天算
    if (rows.length === 0 && badLines > 0)
        throw new Error(`active-days 账本全坏（${badLines} 行无法解析）`);
    const today = days.length ? days.length - 1 : 0;
    // 【B1 · 2026-10-26】池内分位是退场的真判据；链级只负责资格/档位。
    // ⛔ 不把分位名单当“白名单”忽略——必须并进 moves，否则 p43/p44 会永久误留。
    const legacy = planDecaySweep(sweepEntries(index.entries, undefined, index.hot_order, delivered));
    const quantileMoves = new Set(legacy.moves.map((m) => m.id));
    const plan = planChainSweep({ today, conversations, entries, H, theta, pinned: loadPins(root), quantileMoves, ...(opts.rendering ? { rendering: true } : {}), ...(opts.limit !== undefined ? { limit: opts.limit } : {}) });
    const map = new Map();
    for (const row of plan.tiers)
        map.set(row.id, tierModeOf(row.tier));
    return { map, plan, today, activeDays: days.length };
}
/**
 * 【P6 门禁 · 2026-10-26】`chainRender=true` 的启动前置：
 * 必须有已冻结的 `chain-render-baseline.json`（7 个活跃日、chars.p50>0）。
 * ⛔ 没有基线就退回旧渲染（fail-closed），不许“先开再补基线”。
 */
export function chainRenderBaselineOk(root) {
    const file = path.join(root, 'chain-render-baseline.json');
    if (!fs.existsSync(file))
        return { ok: false, reason: '缺少 chain-render-baseline.json' };
    let b;
    try {
        b = JSON.parse(fs.readFileSync(file, 'utf-8'));
    }
    catch (e) {
        return { ok: false, reason: `基线文件解析失败：${e instanceof Error ? e.message : String(e)}` };
    }
    if (!b || b.frozen !== true)
        return { ok: false, reason: '基线未冻结（frozen!=true）' };
    if (Number(b.days) < 7)
        return { ok: false, reason: `基线仅 ${Number(b.days) || 0}/7 个活跃日` };
    if (!(Number(b.chars?.p50) > 0))
        return { ok: false, reason: '基线 p50<=0（全零基线无效）' };
    return { ok: true, reason: 'ok' };
}
