import type { SweepSnapshot } from './decay.js';
export declare const STARTUP_FILE = ".decay-startup.jsonl";
/** 一次启动的门槛判定（`monitorStartup` 的返回值形状）*/
export interface GateDecision {
    run: boolean;
    /** 距上次扫描的间隔（毫秒）；无上次则为 null */
    sinceMs: number | null;
    /** 跳过原因（run=true 时为空） */
    reason: string;
    /** 谁判的（`sweepDecision.decidedBy`） */
    decidedBy: string;
}
export interface StartupRecord {
    /** 本行落盘时刻（毫秒）*/
    at: number;
    /** 判定时刻 = 启动时刻（同一次启动两行同值，便于配对）*/
    decidedAt: number;
    /** 记录类型：门槛判定 / 扫描结果 */
    kind: 'gate' | 'sweep';
    /** 算"自然日"用的时区（影子判定口径）*/
    tz: string;
    /** 上次扫描时刻（毫秒）*/
    lastAt: number | null;
    /** 距上次扫描间隔（小时，两位小数；无上次为 null）*/
    sinceHours: number | null;
    /** 实际跑了扫描吗（真值 = `sweepDecision`）*/
    ran: boolean;
    /** 跳过原因（ran=true 时为空串）——⛔ "时钟回拨"字样要保留（分类靠它）*/
    reason: string;
    /** 中途抛错时的错误串（G3 后置校验抛错 / 搬运中断 ⇒ 半批中断的唯一痕迹） */
    error?: string;
    /** 本次**计划**动几条（与 archived 对比能看出"计划 N 条、实际搬了几条"） */
    planned?: number;
    /** 【#7】按类计数的拦截原因（历史可读） */
    blockedByClass?: Record<string, number>;
    /**
     * 【#5 可见化 · 2026-10-14】距**上一次实际扫描**多少天（可能为 null = 从没扫过）。
     * 为什么加它：扫描只在**启动**触发 ⇒ 宿主长时间不重启＝衰减停摆。
     * 这本身是拍过的权衡（"启动是有界时刻，不在请求里改数据"），但**停摆必须看得见**——
     * 每天落一行，一眼看出"已经 N 天没扫过了"，而不是等人发现库只增不减。
     */
    daysSinceSweep?: number | null;
    /** 实扫时：本次归档条数 */
    archived?: number;
    /** 实扫时：被护栏拦下条数 */
    blocked?: number;
    /**
     * 【Breathe-R1 起】谁判的：`sweepDecision.decidedBy`。
     * ⚠️ 旧记录（2026-10-12 ~ 10-14 之间落的）没有这个字段。
     */
    decidedBy?: string;
    /**
     * ⚠️ **字段名沿用旧值、语义已换**（2026-10-14 / Breathe-R1）：现在是"按 **legacy 24h 门槛**会跑吗"。
     * 留这个名是为了让既有 `.decay-startup.jsonl` 与 `decay-monitor-report.mjs` 照读不炸；
     * 新记录请用 `by24h` / `byDay`（两者同时落盘，一眼分得清）。
     */
    shadowWouldRunByDay?: boolean;
    /** 【Breathe-R1 起】影子①：按 **legacy 24h 门槛**会跑吗（⛔ 只记不生效）*/
    by24h?: boolean;
    /** 【Breathe-R1 起】影子②：按 **当地自然日**会跑吗（⛔ 只记不生效）——修后真判据的主项*/
    byDay?: boolean;
    /** 【Breathe-R1 起】跨天了、但被 6h 最小间隔拦下（这类跳过是**刻意**，不是漏跑）*/
    minIntervalBlocked?: boolean;
    /** 判定依据的两个日键 */
    lastDayKey: string | null;
    todayKey: string;
}
export interface MonitorInput {
    root: string;
    /** 判定时刻（默认 Date.now()）*/
    now?: number;
    /** 判定输入快照（必须是**本次扫描之前**的读数）*/
    snap: SweepSnapshot;
    /** 本次 runSweep 的结果（⛔ 中途抛错时也要传：那是**半批中断的唯一痕迹**）*/
    sweep: {
        ran: boolean;
        archived: readonly string[];
        blocked: number;
        error?: string;
        reason?: string;
        planned?: number;
        blockedByClass?: Record<string, number>;
    };
    /**
     * 【#5 可见化】距上次实际扫描多少天（null / 不传 = 从没扫过）。
     * ⚠️ 2026-10-14 教训：一开始只在**记录**接口上加了字段、入参上没加，
     *    而调用方用**展开语法**传 ⇒ **展开绕过 TS 的多余属性检查** ⇒ `tsc ✅` 什么都没证明、
     *    字段根本没落盘。**入参和记录两处都要加**，并且必须跑一次真写盘读回来验。
     */
    daysSinceSweep?: number | null;
}
/**
 * 落这次启动的记录（两行：gate 判定行 + sweep 结果行，同 `decidedAt` 便于配对）。
 * ⛔ 永不抛：写不进去只返回 ok:false，绝不影响插件启动。
 */
export declare function monitorStartup(input: MonitorInput): {
    ok: boolean;
    decision: GateDecision;
};
/**
 * 可选注入：**默认直接读 `day-boundary` 的时区**（那才是"一天"的单一权威）。
 * 只有测试要固定时区时才需要调它 —— ⛔ 这里不许另立一套"一天"的口径。
 */
export declare function setMonitorTimeZone(tz: string): void;
/**
 * 【P0-5 · 2026-10-18】自动扫描总开关关闭时的启动记账。
 *
 * 语义：本次启动**没有扫描**，原因不是门槛而是**开关**。
 * ⛔ 只写**一行**（不写 gate 行）——验收口径是「恰好一行（未扫）」。
 */
export declare function monitorSwitchOff(input: {
    root: string;
    now?: number;
    snap: SweepSnapshot;
}): {
    ok: boolean;
};
export interface StartupSummary {
    /** 记录行数（gate + sweep 两行算两条）*/
    rows: number;
    /** 启动次数（按 decidedAt 去重）*/
    startups: number;
    /** 其中：真跑了扫描的次数 */
    ranCount: number;
    /** 其中：被门槛跳过（不含时钟回拨）的次数 */
    gatedCount: number;
    /** 其中：跨天了但被 **6h 最小间隔**拦下的次数（刻意跳过，不是漏跑）*/
    minIntervalCount: number;
    /** 其中：时钟回拨跳过的次数 */
    clockBackCount: number;
    /** **有效扫描间隔**（小时）：相邻两次"真跑"的间隔 */
    intervalHours: {
        n: number;
        median: number | null;
        max: number | null;
        min: number | null;
    };
    /**
     * **规则分歧计数**（Breathe-R1 起）——这一对才是"换口径到底改了什么"的读数：
     *   · `legacyOnlyRuns`：**legacy 24h 门槛会跑、真判据没跑**的次数（新口径更慢；正常应为 0）
     *   · `dayOnlyRuns`　：**真判据跑了、legacy 24h 门槛不会跑**的次数（== 修前会静默漏掉的那几次）
     */
    legacyOnlyRuns: number;
    /** 见 `legacyOnlyRuns` 注释 */
    dayOnlyRuns: number;
    /**
     * 被拦下的启动里，按**当地自然日**其实该跑的（含 6h 守卫刻意拦下的那些）。
     * ⛔ 与 `dayOnlyRuns` 不是一回事：这个**不要求 legacy 说不跑**，读的时候要分清。
     */
    shadowExtraRuns: number;
    /** 被拦下的启动里，按 **legacy 24h** 其实会跑的（含被 6h 守卫拦下的） */
    legacyExtraRuns: number;
    /** 【Breathe-R1 起】被拦下的启动里，属"过 6h 守卫（我们故意的）"的次数 */
    minIntervalExtraRuns: number;
    /** 最近一次记录的判读（给人看的一行）*/
    lastLine: string;
    /** 样本覆盖的起止时刻 */
    from: number | null;
    to: number | null;
}
/** 读回录制的启动记录（只读，⛔ 不改文件）*/
export declare function readStartups(root: string): StartupRecord[];
/**
 * 把启动记录折成读数（修前/修后对照靠它）。
 * ⚠️ **新旧记录混读**：2026-10-14 之前落的记录里 `shadowWouldRunByDay` 是"按自然日"，
 *    之后落的记录里它已换成"按 legacy 24h"（详见 `StartupRecord` 注释）——
 *    所以这里对旧记录按 `shadowWouldRunByDay` 兜底、对新记录优先读 `byDay`/`by24h`。
 */
export declare function summarizeStartups(root: string): StartupSummary;
/** 供报告脚本用：把 ms 折成可读的本地时间（⛔ 不引入新依赖）*/
export declare function fmtMs(ms: number | null): string;
