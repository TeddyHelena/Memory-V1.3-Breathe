/**
 * **L4 全量 · 一份事务日志（append-only）+ 一个可重建的投影**
 *
 * ## 这个文件要解决什么（施工单 §一 的账单）
 *
 * 修前有**三条事件流说同一件事**——"谁、在什么时候、把哪条从哪层搬到哪层"：
 *
 * | 文件 | 它其实是这日志的哪一段 |
 * |---|---|
 * | `.decay-intent.jsonl`（打算搬谁） | **`begin` 段** |
 * | `.decay-audit.jsonl`（搬了谁） | **`step` 段** |
 * | `.decay-sweep.json`（上次何时/批次） | **`commit` 段 + 投影** |
 *
 * **⇒ 三者不是三件事，是同一事务的三个阶段。** 被人为拆成三个文件，才需要互相补——
 * 而"互相补"就是 `decay-sweep.ts` **一天 226 → 833 行**里那 **600 行对账**的来源
 * （`healAuditFromIntents` / `compactIntents` / `intentHealth` / 意图形状校验 …）。
 *
 * ## 铁律（本模块的立足点）
 *
 * > **从日志重建出来的投影，必须与盘上投影逐字节一致。**
 *
 * ⛔ 这一条成立，"日志是真源、投影是派生物"才是**被证明的**而不是被声明的。
 * 修前那三件**没有任何一条这样的判据**——所以才需要"自愈"那种东西。
 *
 * ## 事务语义（崩溃可识别）
 *
 * - `begin` → `step`* → `commit` ＝ 完整批次
 * - **`begin` 有、`commit`/`abort` 无 ＝ 崩在中途** ⇒
 *   **`step` 段照样生效**（条目**在盘上真的搬了**，⛔ 不假装没发生），
 *   但**事务被标记为未完成**、**`lastBatch` 不推进** ⇒
 *   **读者不需要 `intent` 来"补审计"**了 —— 因为"搬了哪些"本来就在 `step` 段里。
 * - `abort` ⇒ 显式记"这批没成"
 *
 * ## ⛔ 本模块**只读不写**（步 ①）
 *
 * 施工单是三步走：**① 只增**（本文件）→ ② 双写 → ③ 切读。
 * **本步不改任何旧件**：旧三件照旧写、读侧一字未动。
 */
export type DecayLogPhase = 'begin' | 'step' | 'commit' | 'abort';
/**
 * 一步的**四态** —— ⛔ 不许只有"搬了"，"没搬"和"跳过了"同样要留痕（否则读不出判据）。
 *
 * ⭐【2026-10-15 修正 · 判据抓出来的】`intent` 与 `moved` **必须分开**：
 *
 * | 态 | 写在哪 | 意思 |
 * |---|---|---|
 * | `intent` | `relocate` **之前** | "**我要搬它**" —— 崩在中间时，读者知道"可能搬了没记上" |
 * | `moved` | `relocate` **之后**（审计那个点） | "**它确实被搬了**" —— 回滚靠它找批次 |
 *
 * ⛔ **原设计用一个 `move` 兼这两义** ⇒ `readAudit` 一合并就**撒谎**
 *   （把"打算搬"当成"搬成了"）。**F2 测试当场抓住**：
 *   `relocate 中途抛错 ⇒ 已搬的条目每条都有审计` ｜ expected: 4 ｜ actual: 5。
 */
export type DecayLogAction = 'intent' | 'moved' | 'block' | 'skip';
export interface DecayLogRecord {
    /** 批次 id（与旧 `batch` 同口径：`sweep-<时间戳>`） */
    txn: string;
    /** 事务内序号，**从 0 起且连续** —— 跳号 = 日志被改过 */
    seq: number;
    phase: DecayLogPhase;
    at: number;
    dayKey?: string;
    plan?: {
        pool: number;
        cap: number;
    };
    id?: string;
    action?: DecayLogAction;
    from?: string;
    to?: string;
    why?: string;
    cls?: string;
    /** 回滚事务提交时指向原始扫描批次；只有完整 begin→commit 才构成回滚事实 */
    rollbackOf?: string;
    /** 本次回滚事务实际完成回滚的原始条目 ID */
    rolledBackIds?: string[];
    moved?: number;
    blocked?: number;
    archived?: string[];
    /**
     * ⭐【L4 步④a · 2026-10-15】**"上次自动扫描的绝对时刻"** —— 闸门「一天一次」判据的**真正依托**。
     *
     * ⛔ 为什么必须补：`state` 文件停写前，读侧要改走投影；而投影若没有这个字段，
     *   `sweepDecision` 里 `autoKey=null` ⇒ **同日判据整条失效**、退化成"每 6h 可跑一次"
     *   （实测事故：**07:39 扫过、14:31 又扫一遍** —— 见 `readSweepStateCompat` 注释）。
     * ⚠️ `force` 手动扫描**不推进它**（不占当天额度）⇒ 日志里照记当时的值，⛔ 不自己编。
     */
    lastAutoAt?: number;
    reason?: string;
}
/** 投影 = **从日志重放出来的当前状态**（⛔ 不是另存的一份事实）*/
export interface DecayProjection {
    /** 最近一次**完成**批次的时刻（⛔ 未完成的批次不推进它） */
    lastCommitAt: number | null;
    /** 最近一次**完成**批次的 txn id */
    lastBatch: string | null;
    lastMoved: number;
    /** ⭐ 最近一次完成批次记下的「上次自动扫描时刻」（⛔ 缺失 ⇒ 闸门同日判据会失效） */
    lastAutoAt: number | null;
    /** 日志里出现过的全部已归档 id（按出现顺序） */
    archivedAll: string[];
    /** 按日志推进后的层归属：id → layer */
    layers: Record<string, string>;
    /** **有 begin 没有 commit/abort 的事务** ＝ 崩在中途（⛔ 必须能报出来） */
    incompleteTxns: string[];
}
/**
 * **重放日志 → 投影。**
 *
 * ⛔ 不抛异常（日志坏了也要能读出"坏在哪"）；坏行/坏结构一律进 `problems`。
 * 这就是"篡改一行 ⇒ 必须报出不一致"那条判据的落点。
 */
export declare function replay(records: readonly DecayLogRecord[]): {
    projection: DecayProjection;
    problems: string[];
};
/**
 * **逐字节比较**：投影一致吗？（施工单里最硬的那条判据的入口）
 * ⚠️ 用**规范化 JSON**（键序固定）比，⛔ 不用 `===`（对象引用比不出内容）。
 */
export declare function projectionFingerprint(p: DecayProjection): string;
/** 序列化一行（⛔ 不写盘、不碰文件 —— 落盘由调用方决定，步 ① 只提供能力）*/
export declare function serializeRecord(r: DecayLogRecord): string;
/** 逐行解析（容错；坏行进 problems）—— 与 `replay` 的"坏行要报出来"同一条原则 */
export declare function parseLog(text: string): {
    records: DecayLogRecord[];
    problems: string[];
};
/** 日志文件名（相对容器根） */
export declare const SWEEP_LOG_FILE = ".sweep-log.jsonl";
/** 追加一批记录（append-only：⛔ 不读改写、⛔ 不截断）。**失败不抛**。 */
export declare function appendLog(root: string, records: readonly DecayLogRecord[]): {
    ok: boolean;
    err?: string;
};
/** 启动期对账：日志里有 begin 但没有 commit/abort 的事务（半批/崩溃现场）。⛔ 只报告，不自动修。 */
export declare function readIncompleteSweeps(root: string): {
    txns: string[];
    problems: string[];
};
/** 读整份日志（⛔ 容错：坏行进 problems，不抛） */
export declare function readLog(root: string): {
    records: DecayLogRecord[];
    problems: string[];
};
