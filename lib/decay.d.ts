/** 陈旧阈值：`fresh < 0.5` ⇔ 超过半衰期 */
export declare const STALE_BELOW = 0.5;
/**
 * 每批上限的**下限**（雪崩保护）——设计文档第 3 条。
 * ⚠️ 2026-10-14 起它只是**下限**，实际上限由 `maxPerSweepFor(池规模)` 派生（见下）。
 */
export declare const MAX_PER_SWEEP = 20;
/**
 * 【#6 · 2026-10-14】每批上限 = **库规模的固定比例**（带上下限），不再是一个裸常量。
 *
 * ## 这个上限到底是干什么的
 * ⛔ 它**不是**吞吐旋钮 —— 吞吐由"退场年龄"决定（详见设计稿 §十/§十一）。
 * 它是**爆炸半径限制器**：判据一旦写坏，也**不许一次性搬空整个库**。
 *
 * ## 为什么裸常量不行
 * 固定 20 在今天的池子（66 条 longterm+active）里是 **18%** —— 合理的爆炸半径；
 * 但库长到 2000 条时它只剩 **1%** ⇒ 那时它不再是"保护"，而是**卡住吞吐的真闸门**
 * （实测推演：库 500 条需退 ~17 条/天、2000 条需 ~67 条/天，全被 20 卡死）。
 *
 * ## 派生口径
 * `clamp(ceil(池 × 0.2), 20, 200)`：
 *   · 0.2  = 单批最多动池子的 20%（爆炸半径口径）
 *   · 20   = 下限（小库不许比过去更保守 → **今天的行为一字不变**：66 条 ⇒ 仍取 20）
 *   · 200  = 绝对上限（再大也不许一次刷掉更多，防"判据坏了 + 库很大"的组合）
 */
export declare function maxPerSweepFor(poolSize: number): number;
/**
 * ═══ 2026-10-16（Breathe）· **池内分位**（作者 拍「甲」）═══
 *
 * ## 判据从"绝对阈值"改成"池内相对排名"
 * 修前：`eff < 0.5`（绝对）⇒ 同龄必同命（30 天处 `2^−1 = 0.5`，频率乘子最大是 1
 * ⇒ `count=2900` 的条目照样退）。修后：**先从超过半衰期的里面挑最该退的那一批**。
 *
 * ## ⭐ 三层排序键（U4 量完才补上的，没有它切线处不可复现）
 * ① `count` 升序 → ② 有效年龄升序（同龄老的先退）→ ③ `id` 升序（兜底：⛔ 不吃数组顺序）
 * 实测依据：池 87 条 ⇒ 末 5% = 5 条，而这 5 条 count **全是 0**、与切线同值的有 **21 条**
 * ⇒ 不给断点规则，**谁退谁留取决于数组顺序**（见 `docs/BREATHE-U4-count-signal_20261016.md`）。
 *
 * ## 为什么还要"半衰期下限"
 * **纯分位会自己吃空库**：全健康的池子按分位每天也得砍尾部一批 ⇒ 那是"为退而退"。
 * 下限把语义锁成「**从超过半衰期的那批里挑最该退的**」，池子健康时一条不动。
 */
export declare const QUANTILE = 0.05;
/** 小池回退界：池小于它 ⇒ 分位无统计意义（15 条砍 5% = 0.75 条）⇒ 退回绝对阈值 */
export declare const SMALL_POOL = 30;
export interface DecayEntryLike {
    id: string;
    layer?: string;
    status?: string;
    /** 纯年龄新鲜度（`2^(−t/H)`）——对外可见的那个 */
    fresh?: number;
    /**
     * **有效年龄** = `fresh × (1−w+w·S(accessCount))` —— ⭐ **退场判据用的是它**（2026-10-14 起）。
     * 为什么不用 `fresh`：真身实测纯年龄的 p50 = 0.98、陈旧线 0.5 落在空档里 ⇒ 判据不可达（见 `fresh.ts` 注释）。
     */
    effectiveAge?: number;
    /** 被想起过多少轮（`access_count`）—— 只进 `effectiveAge`，⛔ 不单独参与判定 */
    accessCount?: number;
    /**
     * ⭐【2026-10-17】**被投递过几次**（面①+面②）。
     * 用途：把「刚写、还没机会被用」与「投递过但从没被用」分开——
     * 前者**不参与排名**（信息为零），后者才是真信号。`undefined` = 调用方没提供（退回旧行为）。
     */
    deliveredCount?: number;
    /** 距上次访问多少天 —— 只用于**地板**（太新的不进判定，见 `FRESH_FLOOR_RATIO`）*/
    ageDays?: number;
    /** 衰减类型 —— 只用于地板的半衰期换算 */
    decayType?: string;
    /**
     * ⭐【F 投递权威表 · 2026-10-15 · 作者 拍"A 名单赢"】**是否在册（`hot_order` 成员）**。
     *
     * 语义：**名单是「人工策展的必须留」⇒ 衰减不动它**。出口是**人工从名单移除**，⛔ 不是衰减。
     *
     * 为什么必须有这条（实证）：`l73`（V1.3 后四版本的路线图，`memory_type: opinion`
     * ⇒ 按"意见自动常驻"进了名单）**同时**被衰减按年龄判退 ⇒ 10-14 搬进 archive，
     * 而名单仍说"每轮必投" ⇒ **两个机制打架、谁也不知道对方存在**。
     * ⇒ 定优先级：**在册 > 衰减**（与"迁出即剔名单"是同一条规则的两面）。
     */
    inRoster?: boolean;
}
export interface DecayMove {
    id: string;
    from: 'longterm';
    to: 'archive';
    fresh: number;
    reason: string;
    /** ⭐【Breathe】本条在池内的排名（1 = 最该退）与当时的排名阈值 —— 事后要能答"为什么是它" */
    rank?: number;
    rankLimit?: number;
}
/**
 * 【#7 · 2026-10-14】拦截原因**分类**（用于"每批按类计数"）。
 * 为什么要有它：以前只知道"拦了几条"（一个数），**不知道为什么**——
 * 查"为什么这条没退场"只能把整套推演重算一遍。分类计数让历史可读。
 */
export type DecayBlockClass = 'hot-anchor' | 'core-anchor' | 'roster-anchor' | 'other-layer' | 'inactive' | 'no-age-info' | 'age-unknown' | 'floor' | 'healthy' | 'over-limit' | 'never-delivered' | 'rank-above' | 'small-pool-fallback';
/**
 * ⭐【Breathe】**排名窗口的界**（纯函数）。
 *
 * ## ⛔ 这里曾经写错过一次（2026-10-16 判据当场抓到，记在这儿防复发）
 * 第一版返回的是"**第 N 名的有效年龄值**"，闸门写成 `eff <= limit`。
 * 看上去等价，**其实不等价**：U4 实测池内有 **21 条并列 count=0 / 同龄**，
 * 此时阈值**恰好等于所有条目的值** ⇒ `eff <= limit` **对全体为真** ⇒
 * 窗口失效、一次搬满上限（实测 40 条池子搬了 20 条，而窗口本该是 2 条）。
 * ⇒ **窗口定义在"排名"上，就必须按排名判**。并列由三层键预先排定（这正是第③层 id 兜底的理由）。
 *
 * @returns `maxRank` = 允许退场的最大名次（1 = 最该退）；`usedQuantile=false` ⇒ 走小池回退
 *          （回退支不看名次，只看绝对阈值 —— 那是旧口径，逐字保留）
 */
export declare function rankLimitFor(pool: readonly {
    id: string;
    accessCount?: number;
    effectiveAge?: number;
}[]): {
    maxRank: number;
    usedQuantile: boolean;
};
export interface DecayPlan {
    /**
     * ⭐【Breathe · 2026-10-16】**判据自己报的池数** —— 过了全部守卫、进排名池的条目数。
     * 为什么放进返回值：修前这个数只能靠"外部再算一遍"，而**外部每次算得都不一样**
     * （一天之内三套定义、读数互相矛盾）。⇒ 让判据自报，⛔ 谁都不许再推一份。
     */
    pool?: number;
    /** 窗口大小（= min(ceil(池 × QUANTILE), 过地板的候选数)）；回退支为 Infinity 的语义由 `usedQuantile` 表达 */
    windowSize?: number;
    /** 这次走的是分位还是小池回退 */
    usedQuantile?: boolean;
    moves: DecayMove[];
    /** 被拦下的（带原因）——⛔ 静默丢弃是禁止的：拦了就要说得出来为什么 */
    blocked: Array<{
        id: string;
        why: string;
        cls: DecayBlockClass;
    }>;
    /** 按类计数（含 healthy —— 那是最多数的一类，"多少条还在健康区"必须看得见） */
    classes: Record<DecayBlockClass, number>;
}
/**
 * 规划一次扫描。**只判定，不改数据**。
 * @param entries 来自 `/list` 的条目（`fresh` 由宿主 `fresh.ts` 算好）
 * @param limit 每批上限（默认 `MAX_PER_SWEEP`）
 */
/**
 * 【#7 · 2026-10-14】**为什么这条没退场？** —— 给一个 id，把判据逐条走一遍，给出结论。
 *
 * ## 为什么要有它
 * 判据有 6 个拦点（层 / 状态 / 无年龄信息 / 年龄未知 / 地板 / 上限）+ 1 个"健康、不该退"。
 * 以前只把 `blocked` 存个条数就丢 ⇒ **事后想查"为什么 X 没退"只能把整套推演重算一遍**。
 * 这个函数把那次重算固化成一个**只读、可 curl** 的答案（对照 `introspect` 端点的思路）。
 *
 * ## 为什么不做"每条理由全量落盘"
 * 121 条里每天有 ~114 条被拦 ⇒ 全量落盘一年四十万行、库大了是七百多万行，**而且是重复的话**。
 * 按需算 ⇒ 零存储增长，且**永远能回答**（包括"当时没记进 blocked 的那些健康条目"）。
 *
 * @returns verdict 是给人看的一句话；**任何 id 都有答案**（含"不在扫描范围"这类）
 */
export declare function explainDecay(entries: readonly DecayEntryLike[], id: string, limit?: number): {
    id: string;
    planned: boolean;
    /** `planned` = 会退场（不是"被拦"）；其余是被拦的原因分类 */
    cls: DecayBlockClass | 'not-found' | 'planned';
    verdict: string;
    effectiveAge?: number;
    ageDays?: number;
    decayType?: string;
    accessCount?: number;
    floorDays?: number;
    gapToThreshold?: number;
};
export declare function planDecaySweep(entries: readonly DecayEntryLike[], limit?: number): DecayPlan;
/**
 * **唯一一处**把容器索引条目变成扫描入参（⛔ 调用方不许自己拼这个数组）。
 *
 * 为什么必须提成函数（2026-10-11 实测的坑）：两处调用点各写了一遍
 * `fresh: (e as { fresh?: number }).fresh` —— 而 `fresh` **不是索引字段**：
 * 它是 `freshForEntry()` 现算给 `/list` 与 `/graph` 看的展示值，**从不落库**。
 * 于是每条都传 `undefined`，被护栏「没有 fresh ⇒ 不判」全部拦下
 * ⇒ **自动降层在真身里恒为 0 条**；而状态文件在写、日志在打、面板在显示"今天无自动归档"，
 * 从外面**看不出它没在跑**。这是"两处要同步"栽的第 N 次，所以这次只留一个出口。
 */
export declare function sweepEntries(entries: readonly SweepSourceEntry[], nowMs?: number, 
/** ⭐【F】在册名单（`hot_order`）—— 传进来 ⇒ 在册条目标 `inRoster`，衰减不动它 */
roster?: readonly string[], 
/**
 * ⭐【2026-10-17】每条被投递过几次（`InjectionLedger.deliveredCounts()`）。
 * ⛔ 不传 = 不知道（退回旧行为）；传了但某条不在 map 里 ⇒ **0**（即"从没投递过"）。
 */
deliveredCounts?: ReadonlyMap<string, number>): DecayEntryLike[];
/** 索引条目里、算 fresh 真正需要的那几个字段（⛔ 只挑需要的，不整条传） */
export interface SweepSourceEntry {
    id: string;
    layer?: string;
    status?: string;
    last_accessed?: string;
    decay_type?: string;
    /** 被想起过多少轮（索引字段，`contract/fields.ts` 注为 mirror）—— 供有效年龄用 */
    access_count?: number;
}
/**
 * 判定的输入快照（⛔ 调用方一律打包传这个，别再各传各的 —— 2026-10-14 就是这么栽的）。
 */
export interface SweepSnapshot {
    /** 上次扫描时刻（毫秒；读不到传 null）—— 管"距上次多久"（6h 守卫）*/
    lastAt: number | null;
    /**
     * **上次【自动】扫描时刻（毫秒；读不到传 null）** —— 管"今天扫过没有"（一天一次）。
     *
     * ⛔ 为什么单独记这个（对抗复核攻出的洞 + 修法演进，两段都留在这里）：
     *   ① 修前判据直接信状态文件里的 `lastDayKey`（日键字符串）⇒ **把它改成别的日子就能骗过"一天一次"**，
     *      同一天跑出第二批（`adversarial.mjs` 攻 1② 一攻就破）。
     *   ② 第一版修法改成"日键一律由 `lastAt` 现算"——**方向对、锚点错**：
     *      `force` 手动扫描只推进 `lastAt`、**刻意不占当天自动额度**，于是"强制扫完 1 分钟后的自动判定"
     *      会被误判成 `same-day`（实际该是 `min-interval`）—— force 反而把当天额度吃掉了，
     *      正是我们花力气防的那类静默少跑。回归测试当场红（`test/decay-wiring.test.mjs` R1 ③）。
     *   ③ 最终锚点 = **时间戳**：`lastAutoAt` 是绝对时刻，改不动；日键由它现算。
     *      `force` 不推进它 ⇒ 额度语义自然成立；改文件里的日键字符串则**完全伤不到判据**。
     */
    lastAutoAt: number | null;
    /** 状态文件里那个日键 —— ⚠️ **只用于对账**（`dayKeyMismatch`），⛔ 判据绝不采信它 */
    lastDayKey: string | null;
}
/**
 * 这次该不该跑（**扫描门槛的唯一权威** · 2026-10-14 起）。
 *
 * 判定顺序（顺序即语义，⛔ 不许调）：
 *   ① 没有上次记录 ⇒ 跑（`first`）
 *   ② `lastAt > now` ⇒ **不跑**（`clock-back`，保守：时钟错了就什么都不动）
 *   ③ **上次自动扫描就在今天**（由 `lastAutoAt` 现算；当地时区）⇒ 不跑（`same-day`）
 *   ④ 跨天了但距上次不足 `MIN_RUN_INTERVAL_MS` ⇒ 不跑（`min-interval`）
 *   ⑤ 其余 ⇒ 跑（`day` / `first`）
 *
 * ⛔ 调用方（`runSweep` / `decay-monitor` / 报告）一律走这里，**不许另写一份判据**——
 * 2026-10-12 那份"只读镜像"就是教训：两份判据靠测试锁同步，迟早漂。
 *
 * @param snap 判定输入（见 `SweepSnapshot`）
 * @param nowMs 判定时刻（毫秒）
 * @param minIntervalMs 次判据阈值（默认 6h；**留口子给测试与参照物**）
 */
export declare function sweepDecision(snap: SweepSnapshot, nowMs: number, minIntervalMs?: number): SweepDecision;
/** 门槛判定结果（`sweepDecision` 的返回值）*/
export interface SweepDecision {
    run: boolean;
    /** 不跑的原因（跑时为空串）；⛔ "时钟回拨"四个字要保留——`decay-monitor` 按它分类 */
    reason: string;
    /** 谁判的：first=首次 / day=跨自然日 / min-interval=跨日但没过最小间隔 / same-day=今天扫过 / clock-back=时钟回拨 */
    decidedBy: 'first' | 'day' | 'min-interval' | 'same-day' | 'clock-back';
    /** 距上次扫描（毫秒）；无上次为 null */
    sinceMs: number | null;
    /** 上次扫描归属的当地日键（**由 `lastAt` 现算**；无上次为 null）*/
    lastDayKey: string | null;
    /** 判定时刻的当地日键 */
    todayKey: string;
    /**
     * 传进来的 `lastDayKey` 与由 `lastAt` 现算的**不一致** ⇒ 已忽略传进来的值。
     * ⛔ 判据永远是"现算的那个"（见 `sweepDecision` 里的说明）；这个字段只用来**如实记账**：
     * 它非空就说明状态文件被手改过、或调用方传错了 —— 值得看一眼，但**不影响判定**。
     */
    dayKeyMismatch: boolean;
}
/**
 * 【L3-B3 · 2026-10-15 · 作者 拍**删**】`sweepDue` 已删（原 12 行）。
 *
 * 删的依据：
 *   ① 门禁 `scan:dead` 判它 **「无任何使用 → 整段可删」**（仅测试当 oracle）
 *   ② **它不是独立实现，是薄适配** —— 原文就一行：
 *      `sweepDecision({ lastAt: at, lastAutoAt: at, lastDayKey: null }, nowMs, intervalMs).run`
 *      ⇒ 保留它 = **同一规则两份门面**（重复的权威，正是 Lite 要治的病）
 *   ③ 它的历史使命（钉住"新旧判据分歧"）**已结案入册**
 *
 * ⭐ **判据价值搬到两处，一处不丢**：
 *   · `test/decay-monitor.test.mjs` 里那 8 条 A5 判据**改成直接断言 `sweepDecision`**
 *     （legacy 输入形状由**测试自己**构造 ⇒ 参照物归测试所有）
 *   · `试验场/decay-stress-20261011` 的 A5 八条同样改成**脚本自持**的 legacy 助手
 *
 * ⇒ ⛔ **今后要做"新旧口径对照"，参照物写在调用方（测试/试验场），⛔ 不许再在 src 里养第二份门面。**
 */
