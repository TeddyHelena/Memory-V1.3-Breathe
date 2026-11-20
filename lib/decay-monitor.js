/**
 * 衰减扫描的**监测侧**（V1.3 监测补丁 · 2026-10-12 起；2026-10-14 随门槛改口径）
 *
 * ## 为什么要有这个模块
 * 修前只有 `.decay-sweep.json` 一个 `lastAt`，而 `.decay-audit.jsonl` **只在真的归档了条目时才写行**
 * ⇒ 归档 0 条那天**零落痕**，分不清「被门槛跳过」和「扫了但没动」。
 * 2026-10-12 实测：12:32 那次扫描（归档 0 条）在盘上**只留下一个时间戳**，说不清它是跑过还是没跑。
 *
 * ## 这一版做什么
 *   ① 每次插件启动**必落一行**（含判定结果与跳过原因）⇒ `.decay-startup.jsonl`（只追加）；
 *   ② **两条影子判定**（只记不生效）：同一次启动另算「按 legacy 24h 门槛会怎样」与「按当地自然日会怎样」
 *      ——真实判据（`sweepDecision`）已改成"自然日 + 最小间隔 6h"（Breathe-R1），
 *      两条影子是**修前/修后的对照读数**，不用事后推演；
 *   ③ 提供 `summarizeStartups()` ⇒ 折成「有效扫描间隔」「规则分歧次数」等读数。
 *
 * ## ⛔ 三条硬约束（与 decay-sweep.ts 同源）
 *   · **永不抛到启动路径**：所有写入包在 try 里，失败只返回 ok:false；
 *   · **不改判定**：本模块只观察，不参与「该不该跑」的决策；
 *   · **不新增写入通道**：只写容器**之外**的旁挂文件（⛔ 不走 relocate）。
 *
 * ## 2026-10-14 起：判据只有一份
 * 修前这里有一份 `decideGate` 是 `sweepDue` 的**只读镜像**，靠测试锁同步（文件头当时写着"⛔ 两者必须同步"）。
 * 现在改成**转发 `sweepDecision`**（`src/decay.ts` 是唯一权威）——⛔ 这里不再有第二份判据逻辑。
 */
import fs from 'node:fs';
import path from 'node:path';
import { dayKey, getDayTimeZone } from './day-boundary.js';
import { sweepDecision } from './decay.js';
export const STARTUP_FILE = '.decay-startup.jsonl';
/** ⛔ 这个常量**只用于被测**（`summarize`/测试断言），生产不再用它做判据——判据在 `decay.ts`。 */
const MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** `sweepDecision` ⇒ 监测侧的读法（⛔ 不新增判据，只换字段名）*/
function toGate(d) {
    return { run: d.run, sinceMs: d.sinceMs, reason: d.reason, decidedBy: d.decidedBy };
}
/** 追加一行到 `.decay-startup.jsonl`（⛔ 永不抛）—— 本模块内部用，⛔ 不导出（死导出门禁）*/
function appendStartupRecord(root, rec) {
    try {
        fs.appendFileSync(path.join(root, STARTUP_FILE), JSON.stringify(rec) + '\n', 'utf-8');
        return true;
    }
    catch {
        return false;
    }
}
/**
 * 落这次启动的记录（两行：gate 判定行 + sweep 结果行，同 `decidedAt` 便于配对）。
 * ⛔ 永不抛：写不进去只返回 ok:false，绝不影响插件启动。
 */
export function monitorStartup(input) {
    const now = input.now ?? Date.now();
    const tz = getMonitorTimeZone();
    /**
     * ⛔ **契约：永不抛**（本函数的文档第一句）。2026-10-14 实测它**破了自己的契约**：
     * 调用方漏传 `snap`（旧 API 形状）时 `sweepDecision(undefined)` 抛 TypeError。
     * 后果不是"少记一行"——而是**"每次启动必落一行"这条保证没了**
     * （正是先前修过的"监测账被吞"那一类，只是换了个入口）。
     * ⇒ `snap` 缺失/非法时**退化成首启快照**照常落账，并在 `reason` 里如实标注，
     *   ⛔ 不假装拿到了真读数。
     */
    const snap = input.snap && typeof input.snap === 'object' ? input.snap : null;
    const snapSafe = snap ?? { lastAt: null, lastAutoAt: null, lastDayKey: null };
    const snapMissing = snap === null;
    // 判定：**转发** `sweepDecision`（唯一权威）——⛔ 本模块不写第二份判据。
    // ⛔ 传进门的 `lastAt`/`lastDayKey` 必须是**本次扫描之前**的读数（调用方负责）。
    const notes = [];
    if (snapMissing)
        notes.push('snap 缺失（调用方没按当前 API 传）⇒ 已退化为首启口径记账');
    let raw;
    try {
        raw = sweepDecision(snapSafe, now);
    }
    catch (e) {
        // 判定本身炸了也**不许抛**：退化成"首启 + 记下异常"，账照落
        notes.push(`sweepDecision 抛错（已退化为首启记账）：${e instanceof Error ? e.message : String(e)}`);
        snapSafe.lastAt = null;
        snapSafe.lastAutoAt = null;
        snapSafe.lastDayKey = null;
        raw = sweepDecision(snapSafe, now);
    }
    const decision = toGate(raw);
    const todayKey = dayKey(new Date(now), tz);
    const lastDayKey = raw.lastDayKey;
    // 两条影子判定（⛔ 只记不生效）：
    //   ① legacy 24h 门槛会跑吗（修前口径）② 按当地自然日会跑吗（修后真判据的主项）
    const by24h = sweepDecision(snapSafe, now, MIN_INTERVAL_MS).run;
    const byDay = lastDayKey === null || lastDayKey !== todayKey;
    const sinceHours = decision.sinceMs === null ? null : Number((decision.sinceMs / 3600000).toFixed(2));
    // ⛔ 退化/异常要**如实记进账**（放在 reason 前缀）—— 不假装拿到了真读数
    const notePrefix = notes.length ? `【记账降级】${notes.join('；')} ｜ ` : '';
    const base = {
        tz, lastAt: snapSafe.lastAt, sinceHours, lastDayKey, todayKey,
        // ⚠️ 字段名沿用旧值、语义已换成 legacy 24h（见接口注释）：既有记录与报告脚本照读不炸。
        shadowWouldRunByDay: by24h,
        by24h,
        byDay,
        decidedBy: decision.decidedBy,
        minIntervalBlocked: decision.decidedBy === 'min-interval',
    };
    const okGate = appendStartupRecord(input.root, {
        ...base,
        at: now,
        decidedAt: now,
        kind: 'gate',
        ran: decision.run,
        reason: notePrefix + (decision.run ? '' : decision.reason),
    });
    const okSweep = appendStartupRecord(input.root, {
        ...base,
        // ⛔ 用判定时刻，**不是** Date.now()：全局两次调用之间只差几毫秒，
        //    用它当扫描时刻会让"有效扫描间隔"全部塌成 0（2026-10-12 测试当场抓到）。
        at: now,
        decidedAt: now,
        kind: 'sweep',
        ran: input.sweep.ran,
        // 【修复】硬停摆（gate.block）时 runDueSweep 的真实原因必须优先于 monitor 自己的影子判定
        reason: input.sweep.ran ? '' : (input.sweep.reason ?? decision.reason),
        archived: input.sweep.ran ? input.sweep.archived.length : undefined,
        blocked: input.sweep.ran ? input.sweep.blocked : undefined,
        ...(input.sweep.error ? { error: input.sweep.error } : {}),
        ...(input.sweep.blockedByClass ? { blockedByClass: input.sweep.blockedByClass } : {}),
        // 【#5】入参 → 记录，两处都要（见 MonitorInput.daysSinceSweep 的教训注释）
        ...(typeof input.daysSinceSweep === 'number' ? { daysSinceSweep: input.daysSinceSweep } : {}),
        ...(typeof input.sweep.planned === 'number' ? { planned: input.sweep.planned } : {}),
    });
    return { ok: okGate && okSweep, decision };
}
/** 测试用覆盖值；默认 null ⇒ 走 `day-boundary` 的时区（"一天"的单一权威）*/
let _tzOverride = null;
/**
 * 可选注入：**默认直接读 `day-boundary` 的时区**（那才是"一天"的单一权威）。
 * 只有测试要固定时区时才需要调它 —— ⛔ 这里不许另立一套"一天"的口径。
 */
export function setMonitorTimeZone(tz) {
    _tzOverride = typeof tz === 'string' && tz.trim() ? tz.trim() : null;
}
/** 当前生效的时区（测试断言用；生产由 index.ts 启动时注入）*/
function getMonitorTimeZone() {
    return _tzOverride ?? getDayTimeZone();
}
/**
 * 【P0-5 · 2026-10-18】自动扫描总开关关闭时的启动记账。
 *
 * 语义：本次启动**没有扫描**，原因不是门槛而是**开关**。
 * ⛔ 只写**一行**（不写 gate 行）——验收口径是「恰好一行（未扫）」。
 */
export function monitorSwitchOff(input) {
    const now = input.now ?? Date.now();
    const tz = getMonitorTimeZone();
    const snap = input.snap && typeof input.snap === 'object'
        ? input.snap
        : { lastAt: null, lastAutoAt: null, lastDayKey: null };
    const lastDayKey = snap.lastDayKey ?? null;
    const todayKey = dayKey(new Date(now), tz);
    const sinceMs = typeof snap.lastAt === 'number' && Number.isFinite(snap.lastAt) ? now - snap.lastAt : null;
    // 【修复】影子不能写死：按 legacy 24h 门槛真实算一次（否则关闭期账面永远“不会跑”）
    let by24h = false;
    try {
        by24h = sweepDecision(snap, now, MIN_INTERVAL_MS).run;
    }
    catch {
        by24h = false;
    }
    const ok = appendStartupRecord(input.root, {
        at: now,
        decidedAt: now,
        kind: 'sweep',
        tz,
        lastAt: typeof snap.lastAt === 'number' ? snap.lastAt : null,
        sinceHours: sinceMs === null ? null : Number((sinceMs / 3600000).toFixed(2)),
        ran: false,
        reason: '自动扫描关闭（开关）',
        decidedBy: 'switch-off',
        lastDayKey,
        todayKey,
        by24h,
        byDay: lastDayKey === null || lastDayKey !== todayKey,
        shadowWouldRunByDay: by24h,
        minIntervalBlocked: false,
    });
    return { ok };
}
/** 读回录制的启动记录（只读，⛔ 不改文件）*/
export function readStartups(root) {
    try {
        // 【P2-3 修复 · 2026-10-19】逐行容错：修前一把 `JSON.parse` 包在 try 里，
        //   任一行坏（append-only 文件在崩/ENOSPC 时恰好会留半截行）⇒ **整账判空**
        //   ⇒ 监控账反而最先丢。坏行跳过，别的照读。
        const out = [];
        for (const line of fs.readFileSync(path.join(root, STARTUP_FILE), 'utf-8').split('\n')) {
            if (!line.trim())
                continue;
            try {
                out.push(JSON.parse(line));
            }
            catch { /* 坏行跳过 */ }
        }
        return out;
    }
    catch {
        return [];
    }
}
function median(xs) {
    if (!xs.length)
        return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : Number(((s[m - 1] + s[m]) / 2).toFixed(2));
}
/**
 * 把启动记录折成读数（修前/修后对照靠它）。
 * ⚠️ **新旧记录混读**：2026-10-14 之前落的记录里 `shadowWouldRunByDay` 是"按自然日"，
 *    之后落的记录里它已换成"按 legacy 24h"（详见 `StartupRecord` 注释）——
 *    所以这里对旧记录按 `shadowWouldRunByDay` 兜底、对新记录优先读 `byDay`/`by24h`。
 */
export function summarizeStartups(root) {
    const all = readStartups(root);
    const gates = all.filter((r) => r.kind === 'gate');
    const sweeps = all.filter((r) => r.kind === 'sweep');
    const ran = sweeps.filter((r) => r.ran);
    const gated = gates.filter((r) => !r.ran && !/时钟回拨/.test(r.reason));
    const clockBack = gates.filter((r) => /时钟回拨/.test(r.reason));
    const times = ran.map((r) => r.at).sort((a, b) => a - b);
    const gaps = [];
    for (let i = 1; i < times.length; i++)
        gaps.push(Number(((times[i] - times[i - 1]) / 3600000).toFixed(2)));
    const blocked = gates.filter((r) => !r.ran);
    // 新记录：byDay/by24h 显式落了；**旧记录只有 `shadowWouldRunByDay`，它当时记的是"自然日口径"**，
    // 所以只能拿来兜 `daySaysRun`。⛔ legacy 侧对旧记录一律按"没有影子"处理（⛔ 不许拿自然日的读数
    // 冒充 legacy —— 那会把"修前就漏掉的次数"算成 0 或算成双倍，两种错法都踩过）。
    const daySaysRun = (r) => r.byDay ?? r.shadowWouldRunByDay ?? false;
    const legacySaysRun = (r) => r.by24h ?? false;
    // ⚠️ `shadowExtraRuns` 的口径：**跨日 + 非 6h 守卫**才算"本可以多跑一次"。
    //    6h 守卫拦下的那些是**刻意的**（同一天不该扫两遍），单列 `minIntervalExtraRuns`，⛔ 不与漏跑混算。
    const shadowExtra = blocked.filter((r) => daySaysRun(r) && r.minIntervalBlocked !== true).length;
    const legacyExtra = blocked.filter((r) => legacySaysRun(r)).length;
    const minIntervalExtra = blocked.filter((r) => r.minIntervalBlocked === true).length;
    // 真·分歧：两条规则在同一组输入上给出**不同结论**的那些次（这才是"换口径改了什么"）
    const legacyOnly = gates.filter((r) => legacySaysRun(r) && !r.ran).length;
    const dayOnly = gates.filter((r) => r.ran && !legacySaysRun(r)).length;
    const last = all.at(-1);
    return {
        rows: all.length,
        // 【修复】按全量行去重：开关关闭时每次启动只落 sweep 行，只数 gate 会让“启动次数”恒 0
        startups: new Set(all.map((r) => r.decidedAt)).size,
        ranCount: ran.length,
        gatedCount: gated.length,
        minIntervalCount: minIntervalExtra,
        clockBackCount: clockBack.length,
        intervalHours: {
            n: gaps.length,
            median: median(gaps),
            max: gaps.length ? Math.max(...gaps) : null,
            min: gaps.length ? Math.min(...gaps) : null,
        },
        shadowExtraRuns: shadowExtra,
        legacyExtraRuns: legacyExtra,
        minIntervalExtraRuns: minIntervalExtra,
        legacyOnlyRuns: legacyOnly,
        dayOnlyRuns: dayOnly,
        lastLine: last
            ? `${new Date(last.at).toISOString()} ${last.kind} ran=${last.ran} since=${last.sinceHours ?? '-'}h by=${last.decidedBy ?? '(旧记录)'} 自然日说=${daySaysRun(last)} legacy说=${legacySaysRun(last)} ${last.reason || ''}`.trim()
            : '(无记录)',
        from: all.length ? Math.min(...all.map((r) => r.at)) : null,
        to: all.length ? Math.max(...all.map((r) => r.at)) : null,
    };
}
/** 供报告脚本用：把 ms 折成可读的本地时间（⛔ 不引入新依赖）*/
export function fmtMs(ms) {
    if (ms === null)
        return '-';
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
