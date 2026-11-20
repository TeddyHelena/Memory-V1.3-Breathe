import { planDecaySweep } from './decay.js';
import type { SweepSnapshot } from './decay.js';
import type { DecayEntryLike } from './decay.js';
export interface SweepState {
    /** 上次扫描时刻（毫秒） */
    lastAt: number;
    /** 上次归档条数 */
    lastCount: number;
    /** 上次批次号（回滚按它找） */
    lastBatch: string;
    /**
     * 上次扫描归属的当地日键（`YYYY-MM-DD`）—— ⚠️ **人读用的对账面**，⛔ 判据不采信它。
     * "今天扫过没有"由 `lastAutoAt`（绝对时刻）现算 ⇒ 改这个字符串**伤不到判据**
     * （2026-10-14 对抗复核攻出的洞就是"信了这个字符串"）。
     * 保留它是为了：状态文件一眼可读、旧代码回滚时还认、以及不一致时能对账（`dayKeyMismatch`）。
     */
    lastDayKey: string;
    /**
     * **上次【自动】扫描时刻**（毫秒）——"一天一次"的真正锚点（绝对时刻，改不动）。
     * ⛔ `force` 手动扫描**不推进它**（不占当天额度）；旧状态文件没有这个字段 ⇒ 读作"不知道"（见 `readSweepStateCompat`）。
     */
    lastAutoAt: number;
}
export interface AuditRecord {
    batch: string;
    id: string;
    from: string;
    to: string;
    /**
     * ⚠️ 可为 null：G1 自愈补写的行，若意图是**旧格式**（没记 fresh）⇒ 如实写 null。
     * 2026-10-14 对抗验证指出这是"类型契约撒谎"（原写 `number`，盘上却能是 null，靠 `as unknown` 强转）
     * ⇒ 改成 `number | null`，让类型说真话。⛔ 任何读者对 fresh 做数值运算前必须先判 null。
     */
    fresh: number | null;
    at: number;
    reason: string;
    /** 回滚时追加的标记；只有匹配 sweep-log 的已提交回滚事务才可信 */
    rolledBack?: boolean;
    /** 产生该回滚事实的事务 ID（必须绑定 .sweep-log.jsonl 的 commit） */
    rollbackTxn?: string;
    /** 【G1】这一行是**自愈补写**的（不是扫描当时写的）—— 用来避免它抢走"最近一批"的身份 */
    healed?: boolean;
}
/**
 * 【L1 · 2026-10-15】**薄适配**（⛔ 不再自己读文件）：`readSweepStateEx` 是**唯一读**。
 *
 * 契约保留：**缺失 / 损坏 都返回 `null`**（与改造前一致）。
 * ⚠️ **一处细微行为差异（如实标注）**：改前用 `typeof === 'number'`（`NaN` 能通过），
 *    改后继承 `Ex` 的 `Number.isFinite`（`NaN` 算损坏）。
 *    下游 `sweepDecision` 本来就 `Number.isFinite` 兜底 ⇒ **效果中性**。
 * ⛔ **退役条款**：本薄适配**只服务老调用方**；新代码一律直接用 `readSweepStateEx`。
 */
export declare function readSweepState(root: string): SweepState | null;
/**
 * 读状态并**补齐** `lastDayKey`（旧状态文件没有这个字段 ⇒ 由 `lastAt` 现算）。
 * ⛔ 只读、不改盘；调用方拿到的形状是完整的 `SweepState`。
 * 兼容性说明：旧文件照样能读；新文件对旧代码是多一个字段而已（回滚安全）。
 * ⛔ **必须导出**（2026-10-14）：启动路径（`index.ts`）也要用它 —— 用原始 `readSweepState` 的话，
 *   旧格式状态文件（缺 `lastAutoAt`）会让 `lastAutoAt` 变成 `undefined` ⇒ `sweepDecision` 里
 *   `autoKey === null` ⇒ **"一天一次"那道判据被整条跳过**，退化成"每 6 小时可跑一次"。
 *   实测现场：10-14 07:39 已扫过，14:31 重启**又扫了一遍**（跨了 6h 但同一自然日）。
 */
/**
 * 【L1 · 2026-10-15】**薄适配**：唯一的读是 `readSweepStateEx`，本函数只补旧格式缺的两个字段。
 * ⛔ **退役条款**：真身状态文件一旦全部含 `lastAutoAt`/`lastDayKey`（由 `checkSweepState` 报出），
 *    本函数**退休**，改用 `readSweepStateEx(root).state` 直接读。
 */
export declare function readSweepStateCompat(root: string): SweepState | null;
/**
 * 【F1 · 2026-10-14 对抗验证 B】读状态并**区分三种情况**：没有文件 / 有文件但坏了 / 读到了。
 *
 * 为什么非要区分：`readSweepState` 把"没有文件"和"文件是垃圾"**都返回 null** ⇒
 * `checkSweepState(null)` 返回 `[]`（首启本来就该没问题）⇒ **状态文件损坏时自检一片安静，
 * 而闸门会把它当"首次运行"照跑**（实测：同日连跑多批）。
 * ⛔ 这两种情况的处置完全不同：没有文件 = 正常首启；有文件读不出 = **必须喊**。
 */
export declare function readSweepStateEx(root: string): {
    state: SweepState | null;
    missing: boolean;
    corrupt: boolean;
    /**
     * ⭐【L4 步④c-β 前置 · 2026-10-15】**这份状态是从哪儿读出来的。**
     *
     * ⛔ 为什么必须说实话：停写状态文件之后，值会来自**日志的 `commit` 记录** ——
     *   那时若还报 `file`，**读数就在撒谎**（闸门那一档来源就成了假的）。
     * ⚠️ 本步**只加管道、不改行为**：`log` 那一支等 ④c-β 一起上。
     */
    from: 'file' | 'log';
};
/**
 * **解析闸门快照：状态文件坏了就由审计兜底**（2026-10-14 · Teddy 拍"报+拦"后我改的做法）。
 *
 * ## 为什么不直接"拦"
 * G2 报的十来类不一致里，**大多数不影响闸门** —— 判据是从**时间戳现算**的
 * （`dayKey(lastAutoAt)`），不是从日键字符串读的。真要"拦住不扫"，代价是**衰减停摆**
 * （库只增不减）—— 那正是我们花一天修掉的病。**用停摆换正确性，方向错了。**
 *
 * ## 该做的是"兜底"
 * `.decay-audit.jsonl` 是**只追加**的 ⇒ 它**扛得住状态写失败**（A9 那个场景：状态没落盘、
 * 闸门不推进、同日连跑多批）。所以：**状态缺失/损坏/落后于审计时，用审计里最新的扫描时刻
 * 当 `lastAt`/`lastAutoAt`** ⇒ 闸门恢复有效、**不会重复扫**，也不用停摆。
 *
 * ## 诚实标注
 * 返回值里的 `from` 说清"这次的时刻是从哪来的"：`state` / `audit` / `none`。
 * ⛔ 不许把"从审计推的"说成"状态里就是对的"。
 *
 * @returns snap 判定用快照；from 来源；block 是否应当**本次不扫**
 *   （⛔ block 只在一种情况为真：**有状态文件但读不出来，且审计也给不出可用时刻**
 *     —— 那时"今天扫没扫"真的无从得知，宁可不扫）
 */
/** 闸门解析的返回形状（2026-10-14 起有名字 —— `runDueSweep` 要引用它） */
export type GateSnapshot = {
    snap: SweepSnapshot;
    from: 'state' | 'audit' | 'none' | 'log';
    block: boolean;
    note?: string;
};
export declare function resolveGateSnapshot(root: string, nowMs: number): GateSnapshot;
/** 把一个 `SweepState` 折成判定用的快照（⛔ 判定只看绝对时刻，不看日键字符串）*/
export declare function snapshotOf(st: SweepState | null): SweepSnapshot;
interface IntentRecord {
    phase: 'begin';
    batch: string;
    id: string;
    from: string;
    to: string;
    at: number;
    /** ⚠️ 2026-10-14 补：意图里记下当时的有效年龄 ⇒ 自愈补出来的审计行**有真值**（不是 null，
     *  否则任何对 `fresh` 做数值操作的读者都会炸）。旧意图没有这个字段 ⇒ 补写时仍写 null 并如实标注。 */
    fresh?: number | null;
}
/** 读意图日志（只读、逐行容错；读不到当空）*/
export declare function readIntents(root: string): IntentRecord[];
export declare function checkSweepState(st: SweepState | null, nowMs: number, opts?: {
    corrupt?: boolean;
    auditNewestAt?: number | null;
}): string[];
export declare function readAudit(root: string): AuditRecord[];
/** 审计文件的健康读数（坏行数要能被看见，⛔ 不许静默）*/
export declare function auditHealth(root: string): {
    rows: number;
    badLines: number;
    badShapes: number;
    unboundRows: number;
    logProblems: number;
};
export interface SweepDeps {
    root: string;
    entries: readonly DecayEntryLike[];
    /** 容器写入通道（api.ts 里那个 writer）*/
    relocate: (id: string, layer: 'hot' | 'longterm' | 'archive', opts: {
        operator: string;
        reason: string;
    }) => unknown;
    now?: number;
    limit?: number;
    /**
     * 强制忽略"今天跑过"这一层（测试/手动用）。
     * ⛔ 强制跑**不推进 `lastDayKey`**（见 `runSweep` 头部注释）——不许顶掉当天的自动扫描。
     */
    force?: boolean;
    /**
     * 判定输入快照（缺省 ⇒ 从状态文件现读）。宿主启动路径显式传 `snapshotOf(prevSweep)`
     * ——与状态文件同源、同时刻，不重复读盘。
     */
    snap?: SweepSnapshot;
    /**
     * 【P7 · 2026-10-19】计划覆盖：链级判据接管时由调用方传入**唯一计划**。
     * 缺省 undefined ⇒ 旧行为（`planDecaySweep`）。⛔ 两种来源不许同时在一次扫描里生效。
     */
    planOverride?: ReturnType<typeof planDecaySweep>;
    /** 状态写失败时的记账回调（⛔ 不许吞掉调用方的原始异常）*/
    onStateWriteFail?: (e: unknown) => void;
    /**
     * 【P0-2 修复 · 2026-10-19】钉住名单：**所有**扫描路径都要让 pin 生效。
     * 修前只有链级判据读 pins ⇒ 默认配置（chainJudge=false）下「钉住=永不遗忘」是谎报。
     */
    pins?: ReadonlySet<string>;
    /**
     * 【G3】搬运后回查"这条现在在哪一层"（容器索引真值）。
     * 给了就在每条搬完后立刻校验 `== 目标层`，不符即抛 ⇒ **静默漂移当场变红**，不留到下次加载。
     */
    readLayer?: (id: string) => string | undefined;
}
export interface SweepResult {
    ran: boolean;
    archived: string[];
    blocked: number;
    /**
     * 【#7 · 2026-10-14】按类计数的拦截原因 —— 修前只记"拦了几条"（一个数），
     * **不知道为什么**。分类计数让历史可读（"今天 66 条里 58 条卡在地板"一眼看见）。
     */
    blockedByClass?: Record<string, number>;
    reason?: string;
    /** 谁判的（`sweepDecision.decidedBy`）——没跑时用来区分"今天扫过 / 最小间隔 / 时钟回拨" */
    decidedBy?: string;
    /** 本次是否被 `force` 强制（强制跑不占当天自动额度）*/
    forced?: boolean;
    /**
     * 【修 6】意图落盘失败的条目 id（2026-10-14 对抗验证 2.2）：
     * 意图写不进去 ⇒ G1 那道闸门对**这条**静默缺席。⛔ 不许吞——如实回报，由调用方 warn。
     */
    intentFailures?: string[];
    /**
     * 【F3 · 2026-10-14 对抗验证 B 的 A9（最重）】状态文件**没写成功**。
     * 后果不是"少记一笔"：闸门（`lastAutoAt`/`lastDayKey`）**没推进** ⇒ 下一次启动会再扫一遍，
     * 同一自然日可以连跑多批，而日志全绿（实测 3 次启动搬走 9 条）。
     * ⛔ 必须如实回报并由调用方喊出来。
     */
    stateWriteFailed?: boolean;
    /**
     * ⭐【步④c-α】日志写失败。
     * ⛔ 双写期它只是「新的坏了」（可忽略）；**停写旧件之后，日志是唯一真源** ——
     *   它失败 ⇒ 什么都没记下 ⇒ 闸门会当「首启」 ⇒ **同日重复扫描**。
     * ⇒ 所以这个信号**必须能传到调用方**（对照 `stateWriteFailed` 的来历）。
     */
    logWriteFailed?: boolean;
    /**
     * 【G3 · 对抗验证 B 的第 7 条】本次是否做了后置校验。
     * ⛔ `readLayer` 是**可选**依赖（不传则行为不变，既有测试主动钉住这个 fail-open 形状），
     *   但"校验了没有"本身要说出来，免得"没校验"被当成"校验通过"。
     */
    verified?: boolean;
}
/**
 * 回滚也走 `.sweep.lock`：手动回滚与启动/手动扫描不许交错。
 * rollbackLastBatch 内部调用本函数；两者都不嵌套持锁。
 */
export declare function rollbackBatch(deps: Omit<SweepDeps, 'entries' | 'lastDayKey'> & {
    batch: string;
}): {
    rolledBack: string[];
    batch?: string;
    reason?: string;
};
/**
 * 回滚**最近一批**。身份由 `.decay-sweep.json` 的 `lastBatch` 决定，⛔ 不由"审计文件末行"决定。
 *
 * 【对抗验证 4.4】修前用 `all.filter(!rolledBack).at(-1)` ⇒ 谁最后被追加谁就是"最近一批"：
 *   G1 自愈补写一行**老批次**的审计后，它就抢走这个身份 ⇒ 撤销去撤老批次，
 *   而 `/decay-state` 显示的仍是 `state.lastBatch` ⇒ **显示与动作脱钩**。
 * 修后：先认 state（权威），state 读不到才退回"最新的非自愈行"。
 */
export declare function rollbackLastBatch(deps: Omit<SweepDeps, 'entries' | 'lastDayKey'> & {
    limit?: number;
}): {
    rolledBack: string[];
    batch?: string;
    reason?: string;
};
/** 列出**可回滚的批次**（人要知道"还有哪些能撤"）—— 只读 */
export declare function listRollbackBatches(root: string): Array<{
    batch: string;
    count: number;
    rolledBack: boolean;
    healed: boolean;
}>;
/**
 * 【启动/手动/定时共用 · 2026-10-26】扫描级互斥：同一容器同一时刻只允许一个 runDueSweep。
 * 修前 concurrent startup 会各写一条 begin/commit（10-24 实证：同一 txn 两条空 commit），
 * 搬空条目时看不出，真到 due 就可能双账。锁拿不到直接 LOCK_BUSY（不排队），由调用方记日志。
 */
export declare function runDueSweep(deps: SweepDeps & {
    gate?: GateSnapshot;
}): SweepResult & {
    gateFrom: string;
};
/**
 * 手动/强制扫描的同一把 `.sweep.lock`：force 也不能绕过单生产者。
 * runDueSweep 内部调用 runSweepLocked，避免自己锁自己。
 */
export declare function runSweep(deps: SweepDeps): SweepResult;
export {};
