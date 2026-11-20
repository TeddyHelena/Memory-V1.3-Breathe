/**
 * 自动降层（衰减执行）—— **纯函数层，不碰容器**。
 *
 * 口径（Teddy 2026-10-10 拍）：「先按照超过半衰期吧」+「B（陈旧 ⇒ 自动降层）」
 *   · 陈旧 ⇔ `fresh < 0.5` ⇔ 没被访问超过半衰期（跨会话 30 天 / 同会话 5 轮）
 *   · 陈旧 + `layer = longterm` + `status = active` ⇒ 降为 `archive`
 *
 * 设计见 `docs/decay-design.md`（六条护栏）。**这里只做"该动谁"的判定**，
 * 真正的写入由调用方走容器既有写入通道（单一写入时刻），并逐条落审计。
 *
 * ═══ 2026-10-14（MemoryV1.3-Breathe-R1）· 扫描门槛改口径 ═══
 * **改的是"什么时候跑"，不是"该动谁"**——下面 `planDecaySweep` 的判定与六条护栏一行没碰。
 *   修前：`距上次扫描 ≥ 24h`（硬门槛）。病根不是这个数字，是**它和"每天差不多同一时刻重启"叠在一起**：
 *         重启时刻落在门槛**刀刃**上，比上次晚几秒就当天跑、早几秒就**跳一天**⇒ 静默漏跑。
 *         实测（生产 `.decay-startup.jsonl`）：2 天 4 次启动只真扫 1 次；合成 30 天每天重启 ±90s 抖动 ⇒ 只扫 20 次。
 *   修后：**主判据 = 当地自然日**（上次扫描不在"今天"⇒ 到点）＋ **次判据 = 最小间隔 6h**。
 *         读出来的性质：①同一自然日绝不跑两次；②没有自然日会被跳过。
 */
import { dayKey } from './day-boundary.js';
import { FRESH_FLOOR_RATIO, effectiveAge, floorDaysFor, freshForEntry, halfLifeFor } from './route/fresh.js';
/** 陈旧阈值：`fresh < 0.5` ⇔ 超过半衰期 */
export const STALE_BELOW = 0.5;
/**
 * 每批上限的**下限**（雪崩保护）——设计文档第 3 条。
 * ⚠️ 2026-10-14 起它只是**下限**，实际上限由 `maxPerSweepFor(池规模)` 派生（见下）。
 */
export const MAX_PER_SWEEP = 20;
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
export function maxPerSweepFor(poolSize) {
    if (!Number.isFinite(poolSize) || poolSize <= 0)
        return MAX_PER_SWEEP;
    return Math.min(200, Math.max(MAX_PER_SWEEP, Math.ceil(poolSize * 0.2)));
}
/**
 * 最小扫描间隔（次判据）：跨自然日后，距上次扫描仍需 ≥ 这个量才跑。
 * 拦的是**跨日双跑**（例如当地 23:30 扫过、次日 00:10 又启动 ⇒ 同一天多搬 20 条），
 * 顺带兜住时钟回拨与时区跳变。⛔ 不是"一天一次"的替代品——那一层由自然日判据负责。
 */
const MIN_RUN_INTERVAL_MS = 6 * 60 * 60 * 1000;
/**
 * ═══ 2026-10-16（Breathe）· **池内分位**（Teddy 拍「甲」）═══
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
export const QUANTILE = 0.05;
/** 小池回退界：池小于它 ⇒ 分位无统计意义（15 条砍 5% = 0.75 条）⇒ 退回绝对阈值 */
export const SMALL_POOL = 30;
/** 排名比较的容差（浮点相等判定） */
const RANK_EPS = 1e-9;
/**
 * ⭐【Breathe · 2026-10-16】**三层排序键**（退出候选的排名口径，纯函数、可直连测）。
 *
 * `count` 升序 → 有效年龄升序 → `id` 升序。
 * ⛔ 第三层不是装饰：前两层仍可能并列，没有它就等于**让数组顺序决定谁退谁留**。
 */
function rankKeyOf(e) {
    const c = Number.isFinite(Number(e.accessCount)) ? Number(e.accessCount) : 0;
    const eff = Number.isFinite(Number(e.effectiveAge)) ? Number(e.effectiveAge) : Number.POSITIVE_INFINITY;
    return [c, eff];
}
function sortRanked(arr) {
    return [...arr].sort((a, b) => {
        const [ca, ea] = rankKeyOf(a);
        const [cb, eb] = rankKeyOf(b);
        if (ca !== cb)
            return ca - cb;
        if (ea !== eb)
            return ea - eb;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}
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
export function rankLimitFor(pool) {
    if (pool.length < SMALL_POOL)
        return { maxRank: Number.POSITIVE_INFINITY, usedQuantile: false };
    return { maxRank: Math.max(1, Math.ceil(pool.length * QUANTILE)), usedQuantile: true };
}
/**
 * ⭐【Breathe】**窗口的最终大小**：`min(池 × QUANTILE, 真正够格的人数)`。
 *
 * ## 为什么要箝位（2026-10-16 真身 dry-run 抓出来的）
 * 池 87 条 ⇒ 窗口 `ceil(87×0.05) = 5` 名；**可过得了半衰期下限的只有 3 条**
 * （其余 79 条没过地板、82 条根本没到 30 天半衰期）。
 * ⇒ 窗口(5) > 候选(3) 时，"第 5 名"是**名次表里不存在的人**：
 *   报出去的阈值是 `undefined`、解释里读起来像"还有更该退的"——两样都不诚实。
 * ⇒ 箝到候选数：窗口**永远不超过真正站在起跑线上的人**。
 */
function windowSizeFor(eligibleCount, maxRank) {
    if (!Number.isFinite(maxRank))
        return eligibleCount;
    return Math.max(0, Math.min(maxRank, eligibleCount));
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
export function explainDecay(entries, id, limit) {
    const target = entries.find((e) => e.id === id);
    if (!target)
        return { id, planned: false, cls: 'not-found', verdict: `条目 ${id} 不在本次扫描的条目集里（检查 id 拼写 / 是否已被归档后不再出现在扫描输入中）` };
    const plan = planDecaySweep(entries, limit);
    const moved = plan.moves.find((m) => m.id === id);
    const eff = typeof target.effectiveAge === 'number' && Number.isFinite(target.effectiveAge)
        ? target.effectiveAge
        : (typeof target.fresh === 'number' && Number.isFinite(target.fresh) ? target.fresh : undefined);
    const floorD = typeof target.ageDays === 'number' ? floorDaysFor(halfLifeFor(target.decayType)) : undefined;
    const base = {
        id, effectiveAge: eff, ageDays: target.ageDays, decayType: target.decayType,
        accessCount: target.accessCount, floorDays: floorD,
        gapToThreshold: eff === undefined ? undefined : Number((eff - STALE_BELOW).toFixed(4)),
    };
    if (moved) {
        return { ...base, planned: true, cls: 'planned', verdict: `**会退场**：${moved.reason}` };
    }
    const blocked = plan.blocked.find((b) => b.id === id);
    if (blocked)
        return { ...base, planned: false, cls: blocked.cls, verdict: `**不退场**（${blocked.cls}）：${blocked.why}` };
    // 没进 moves 也没进 blocked ⇒ 只可能是两件事：硬护栏跳过，或"健康（有效≥阈值）"
    if (target.layer === 'hot' || /^h/i.test(id)) {
        return { ...base, planned: false, cls: 'hot-anchor', verdict: '**不退场**：hot 层 / h* 人格锚点——硬护栏，**绝不参与自动降层**（hot 只人工维护）' };
    }
    if (eff !== undefined) {
        return { ...base, planned: false, cls: 'healthy', verdict: `**不退场（健康）**：有效年龄 ${eff.toFixed(3)} ≥ 阈值 ${STALE_BELOW}（高出 ${(eff - STALE_BELOW).toFixed(3)}）⇒ 还够"新鲜"，不该退` };
    }
    return { ...base, planned: false, cls: 'no-age-info', verdict: '**不退场**：拿不到有效年龄 ⇒ 不判（⛔ 不猜）' };
}
/**
 * ⭐【Breathe · 2026-10-16】**唯一的"池"定义** —— 判据里只许有这一处。
 *
 * ## 为什么必须收成一处（真身实测的教训，一天之内绊了我三次）
 * 修前并行着**三套**"池"：
 *   · `pool`（只滤 layer+status+h*）⇒ **87**（还被 `maxPerSweepFor` 拿去做爆炸半径）
 *   · 真正的候选（过完全部护栏）⇒ **82**
 *   · 我自己的诊断脚本里又写了一套 ⇒ 与上面两个都对不上
 * ⇒ 同一个问题在三个地方有**三个答案** ⇒ 每轮读数自相矛盾，最后是判据 ⑥ 把我钉住的。
 * ⇒ 现在：「这个条目算不算可降层池的一员」只有这一个函数说了算；
 *    `pool` / 窗口基数 / 诊断工具**全部从它派生**（含「在册不占分母」那条）。
 */
function isDecayCandidate(e) {
    if (e.layer === 'hot' || /^h/i.test(e.id))
        return false; // 护栏 1
    if (String(e.decayType ?? '') === 'core' || !Number.isFinite(halfLifeFor(e.decayType)))
        return false; // 护栏 1.5
    if (e.layer !== 'longterm')
        return false; // 护栏 2
    if (e.inRoster)
        return false; // 在册 > 衰减（10-15 拍）
    if ((e.status ?? 'active') !== 'active')
        return false; // 护栏 3
    return true;
}
export function planDecaySweep(entries, limit) {
    // 【#6】没显式给 limit ⇒ 按**传入条目的池规模**派生（⛔ 不再写死 20，见 maxPerSweepFor）
    const pool = entries.filter(isDecayCandidate).length;
    const cap = limit ?? maxPerSweepFor(pool);
    const moves = [];
    const blocked = [];
    const classes = {
        'hot-anchor': 0, 'core-anchor': 0, 'roster-anchor': 0, 'other-layer': 0, inactive: 0, 'no-age-info': 0,
        'age-unknown': 0, floor: 0, healthy: 0, 'over-limit': 0, 'never-delivered': 0, 'rank-above': 0, 'small-pool-fallback': 0,
    };
    /**
     * ⭐【Breathe】趟①：过完**全部护栏**之后、还没判退场的条目 —— 它们构成"分位排名池"。
     * ⛔ 两趟是必须的：排名要看**整个池子**，而池子只有走完护栏才知道（⛔ 不能边判边算）。
     */
    const eligible = [];
    /**
     * ⭐【Breathe】走分位还是走小池回退 —— **按池规模**定（Teddy 2026-10-16 拍）。
     *
     * ⛔ 曾经按"过完地板的候选数"算 —— 真身实测证明那是错的：
     * 池 87 条 ⇒ 地板后只剩 **3** 条 ⇒ `3 < 30` ⇒ **走回退支、纯分位永不生效**；
     * 更糟的是**地板成了分位的前置闸门**（地板放行几条就决定跑哪套判决）
     * ⇒ 两层保护互相决定对方，谁都说不清当下到底在跑哪一支。
     * ⇒ 现在：**池规模决定走哪一支；地板只决定"谁进排名"** —— 各管各的，不再耦合。
     */
    const usedQuantile = pool >= SMALL_POOL;
    for (const e of entries) {
        // 护栏 1：hot 层 + `h*` 人格锚点**绝不参与**（本仓硬规矩：hot 只人工维护）
        if (e.layer === 'hot' || /^h/i.test(e.id)) {
            classes['hot-anchor']++;
            continue;
        }
        // 护栏 2：只动 longterm + active
        /**
         * 护栏 1.5（2026-10-14 对抗验证 D 修）：**`decay_type:'core'` 一律硬短路。**
         *
         * `HALF_LIFE_BY_DECAY.core = Infinity` —— 文档语义是"**永不衰减**"。
         * 但判据链有个缝：有效年龄 = 纯年龄 × 频率权重，而**频率权重对 count=0 是 0.15**
         * ⇒ 今天刚写的 core（纯年龄 = 1）算出来 `0.15 < 0.5` ⇒ **首扫即被归档**（真容器端到端复现过）。
         * 地板本该公司拦，但它那时返回 0（见 `floorDaysFor` 的注释）⇒ 两道一起漏。
         *
         * ⛔ 这条**必须在有效年龄判定之前**：core 的"年份"没有意义，
         * 拿"从没被想起"去压它本身就是语义错误（它不是"被忘了"，是"**不该退**"）。
         */
        if (String(e.decayType ?? '') === 'core' || !Number.isFinite(halfLifeFor(e.decayType))) {
            classes['core-anchor']++;
            blocked.push({ id: e.id, why: '`decay_type=core`（半衰期 ∞，永不衰减）⇒ 硬短路，不判', cls: 'core-anchor' });
            continue;
        }
        if (e.layer !== 'longterm') {
            classes['other-layer']++;
            blocked.push({ id: e.id, why: `layer=${e.layer ?? '未知'}（只动 longterm）`, cls: 'other-layer' });
            continue;
        }
        // ⭐【F 投递权威表 · 2026-10-15 · Teddy 拍"A 名单赢"】**在册 > 衰减**。
        //   名单（`hot_order`）是**人工策展的"必须留"** ⇒ 衰减**不动**它；出口是**人工从名单移除**。
        //   为什么要有这条（实证）：`l73` 同时被"opinion 自动常驻"和"按年龄判退"两条机制命中 ⇒
        //   10-14 被搬进 archive，而名单仍说"每轮必投" ⇒ 两个机制打架、谁也不知道对方存在。
        if (e.inRoster) {
            classes['roster-anchor']++;
            blocked.push({
                id: e.id,
                why: '在册条目（`hot_order`）⇒ **衰减不动它**（名单是人工策展的"必须留"；出口 = 人工从名单移除）',
                cls: 'roster-anchor',
            });
            continue;
        }
        if ((e.status ?? 'active') !== 'active') {
            classes.inactive++;
            blocked.push({ id: e.id, why: `status=${e.status}（只动 active）`, cls: 'inactive' });
            continue;
        }
        // 递减龄判定：没有**有效年龄** ⇒ **不判**（⛔ 不猜，宁可不动）
        // ⚠️ 判据是 `effectiveAge`，不是 `fresh`（2026-10-14 改）：纯年龄在真身里 p50=0.98、
        //    陈旧线落在空档 ⇒ 恒不触发。有效年龄把"被想起过多少次"压进去 ⇒ 判据可达（见 fresh.ts）。
        const eff = typeof e.effectiveAge === 'number' && Number.isFinite(e.effectiveAge)
            ? e.effectiveAge
            : (typeof e.fresh === 'number' && Number.isFinite(e.fresh) ? e.fresh : undefined);
        if (eff === undefined) {
            classes['no-age-info']++;
            blocked.push({ id: e.id, why: '没有有效年龄（宿主未下发 fresh）⇒ 不判', cls: 'no-age-info' });
            continue;
        }
        // ⛔ **年龄未知 ⇒ 一律不判**（2026-10-14 回归修复）：
        //    缺/非法 `last_accessed` 的条目，`fresh` 取的是"不猜值"，而频率权重会把它再压低
        //    ⇒ 实测有 2 条"从没被访问过"的条目因此被归档。**"不知道它多老" ≠ "它很老"。**
        //    （这条护栏是 10-11 F3 修的，本次改判据差点把它弄丢 —— 回归测试当场抓到。）
        if (typeof e.ageDays !== 'number') {
            classes['age-unknown']++;
            blocked.push({ id: e.id, why: '没有有效 last_accessed（年龄未知）⇒ 不判', cls: 'age-unknown' });
            continue;
        }
        // ⛔ 地板：距上次访问不足"半衰期 × 地板比例"的**一律不判**
        //    （频率权重对"刚写、count=0"的条目是只降不升的 ⇒ 实测差点归档当天新条目）
        const floorD = floorDaysFor(halfLifeFor(e.decayType), e.accessCount); // ⭐非对称地板：见过的更短
        if (floorD > 0 && e.ageDays < floorD) {
            classes.floor++;
            blocked.push({ id: e.id, why: `未过地板：距上次访问 ${e.ageDays.toFixed(1)} 天 < ${floorD.toFixed(1)} 天（半衰期 × ${FRESH_FLOOR_RATIO}）⇒ 太新，不判`, cls: 'floor' });
            continue;
        }
        // ⭐【Breathe】**入场闸门**（小池回退那一支在此就分流；分位那一支先全进池、由排名窗口筛）。
        //    ⛔ 小池回退必须逐字保留旧边界：`eff >= STALE_BELOW ⇒ 健康`（`eff = 0.5` **算健康**）。
        //    修前这里是 `if (eff >= STALE_BELOW) { classes.healthy++; continue }`。
        if (!usedQuantile && eff >= STALE_BELOW) {
            classes.healthy++;
            continue;
        }
        /**
         * ⭐【2026-10-17 · 首扫事故止血】**从没被投递过 ⇒ 不参与排名**。
         *
         * 为什么：`count=0` 有两种含义被混成一种——「刚写、没人给过机会」与「投递过、没人再用」。
         * 首扫（10-17 00:03）因此退了三条 10-15 刚写的记录（`l83/l84/l85`，已回滚）。
         * ⇒ 信息为零的不能当"最该退"；只有真正**被给过机会**的条目，才轮到判它的命运。
         * ⚠️ `deliveredCount === undefined` = 调用方没提供 ⇒ **退回旧行为**（不许把"没数据"当"没投递"）。
         */
        if (e.deliveredCount === 0 && !(Number(e.accessCount) > 0)) {
            classes['never-delivered']++;
            blocked.push({
                id: e.id,
                why: '从没被投递过（面①面②都没投出去过）⇒ 还没机会被用，不参与排名（⛔ 等它被投递过再判）',
                cls: 'never-delivered',
            });
            continue;
        }
        eligible.push({ e, eff });
    }
    /**
     * ⭐【Breathe】趟②：**排名闸门**（池内分位 ∧ 半衰期下限）。
     * 阈值是**一个值**（第 N 名的有效年龄）⇒ 与遍历顺序无关；
     * 并列由三层键（count → 有效年龄 → id）排定 ⇒ 完全确定性。
     */
    // ⭐ 窗口大小按**池规模**算（不是"过了地板的候选数"）—— 见上面 usedQuantile 的注释
    const { maxRank: maxRankRaw } = rankLimitFor(new Array(pool).fill({ id: 'x', accessCount: 0, effectiveAge: 0 }));
    const quantileMode = usedQuantile;
    const ranked = sortRanked(eligible.map((x) => ({ ...x, id: x.e.id, accessCount: x.e.accessCount, effectiveAge: x.eff })));
    const rankOf = new Map(ranked.map((x, i) => [x.id, i + 1]));
    // ⭐ 箝位：窗口不许超过**真正够格的人数**（见 windowSizeFor 的注释 —— 真身 dry-run 抓到的）
    const maxRank = windowSizeFor(ranked.length, maxRankRaw);
    const windowThreshold = ranked[maxRank - 1]?.effectiveAge;
    for (const { e, eff } of eligible) {
        const rank = rankOf.get(e.id) ?? 0;
        const pureAge = typeof e.fresh === 'number' ? e.fresh.toFixed(3) : '-';
        /**
         * ⛔⛔ **半衰期下限已移除**（Teddy 2026-10-16 拍「甲 · 纯分位」）。
         *
         * ## 为什么拿掉它（真身 dry-run 给出的、当时的读数）
         * 池 87 条 · 计划退场 **0 条**：地板挡 79 条、够老的只有 3 条，而这 3 条**全部卡在下限上**
         * （p17 5.95 天 / p21 4.96 天 / l66 3.97 天，而 `recent` 的半衰期是 **30 天**）。
         * **根因比参数深**：这些条目之所以"很新"，正是因为它们**天天被召回**——
         * 召回本身在刷新它们的年龄 ⇒ 只要 route 面天天拉它们，"超过半衰期"就**永远不可能成立**。
         * ⇒ 下限不是"保守"，是**让判据结构性不可达**（正是 10-14 拍「甲乙一起做」要治的那个病）。
         *
         * ## 代价（口径变更，已写进文档，⛔ 不许代码改了文档不改）
         * 语义从「**陈旧 = 超过半衰期**」改成「**陈旧 = 池内垫底**」——
         * 这是对 Teddy 2026-10-10 那口径的**正式修改**，由他 2026-10-16 亲口拍定。
         *
         * ## 现在谁在兜底（三层，⛔ 一层都不许再拆）
         *   ① **地板**（`FRESH_FLOOR_RATIO`）：刚写、还没被想起的**一律不判** —— 现在它是**唯一**的"太新保护"；
         *   ② **小池回退**：池 < 30 ⇒ 退回绝对阈值 `eff < 0.5`（旧行为逐字保留，也是回滚路径）；
         *   ③ **每批上限**：一次扫描的爆炸半径限制器。
         */
        /**
         * ⚠️ **每一支的判据在这里分开写**（⛔ 不共用一条表达式 —— 它们的语义不同：
         *   分位支判**名次**（窗口定义在排名上，⛔ 不是值），回退支判**值**（`< 0.5`，旧口径）。
         *   · 分位支：名次没进窗口 ⇒ `rank-above`
         *   · 回退支：入场闸门已把 ≥0.5 的分流成 healthy ⇒ 走到这里的都该退
         */
        if (quantileMode && !(rank <= maxRank)) {
            classes['rank-above']++;
            blocked.push({
                id: e.id,
                why: `排名没进窗口：池内排第 ${rank} > 窗口 ${maxRank}（够老，但池里还有更该退的；窗口内末位的有效年龄 ${Number.isFinite(windowThreshold) ? windowThreshold.toFixed(4) : '-'}）⇒ 不判`,
                cls: 'rank-above',
            });
            continue;
        }
        if (moves.length >= cap) {
            classes['over-limit']++;
            blocked.push({ id: e.id, why: `超每批上限 ${cap}（本批已满，下批再说）`, cls: 'over-limit' });
            continue;
        }
        moves.push({
            id: e.id, from: 'longterm', to: 'archive', fresh: eff,
            rank, rankLimit: windowThreshold,
            // ⛔ 「纯年龄 × 频率权重」这段两种口径**都要带上**（可解释性不是分位口径的特权）
            reason: quantileMode
                ? `递减龄（池内分位）：有效=${eff.toFixed(3)}（纯年龄=${pureAge} × 频率权重，被想起 ${e.accessCount ?? 0} 轮）｜ 池内排第 ${rank} ⇒ 进末 ${(QUANTILE * 100).toFixed(0)}% 窗口（${maxRank} 名）`
                : `递减龄（小池回退·绝对阈值）：有效=${eff.toFixed(3)}（纯年龄=${pureAge} × 频率权重，被想起 ${e.accessCount ?? 0} 轮） < ${STALE_BELOW}（池 ${eligible.length} 条 < ${SMALL_POOL}，分位无统计意义）`,
        });
    }
    return { moves, blocked, classes, pool, windowSize: maxRank, usedQuantile: quantileMode };
}
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
export function sweepEntries(entries, nowMs = Date.now(), 
/** ⭐【F】在册名单（`hot_order`）—— 传进来 ⇒ 在册条目标 `inRoster`，衰减不动它 */
roster, 
/**
 * ⭐【2026-10-17】每条被投递过几次（`InjectionLedger.deliveredCounts()`）。
 * ⛔ 不传 = 不知道（退回旧行为）；传了但某条不在 map 里 ⇒ **0**（即"从没投递过"）。
 */
deliveredCounts) {
    return entries.map((e) => {
        const fresh = freshForEntry(e.last_accessed, e.decay_type, nowMs);
        return {
            id: e.id,
            layer: e.layer,
            status: e.status,
            fresh,
            accessCount: e.access_count,
            deliveredCount: deliveredCounts ? (deliveredCounts.get(e.id) ?? 0) : undefined,
            decayType: e.decay_type,
            inRoster: roster ? roster.includes(e.id) : undefined,
            ageDays: Number.isFinite(Date.parse(String(e.last_accessed ?? ''))) ? (nowMs - Date.parse(String(e.last_accessed))) / 86400000 : undefined,
            // ⭐ 退场判据看的是这个（纯年龄 × 频率权重，只降不升）
            effectiveAge: effectiveAge(fresh, e.access_count),
        };
    });
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
export function sweepDecision(snap, nowMs, minIntervalMs = MIN_RUN_INTERVAL_MS) {
    const todayKey = dayKey(new Date(nowMs));
    const lastAt = typeof snap.lastAt === 'number' && Number.isFinite(snap.lastAt) ? snap.lastAt : null;
    const lastAutoAt = typeof snap.lastAutoAt === 'number' && Number.isFinite(snap.lastAutoAt) ? snap.lastAutoAt : null;
    // 日键**一律由时间戳现算**；状态文件里那个字符串只用来对账（投机取巧改它伤不到判据）
    const autoKey = lastAutoAt === null ? null : dayKey(new Date(lastAutoAt));
    const lastKey = autoKey ?? (lastAt === null ? null : dayKey(new Date(lastAt)));
    const providedKey = typeof snap.lastDayKey === 'string' && snap.lastDayKey.trim() ? snap.lastDayKey.trim() : null;
    const dayKeyMismatch = providedKey !== null && autoKey !== null && providedKey !== autoKey;
    const base = { sinceMs: null, lastDayKey: lastKey, todayKey, dayKeyMismatch };
    if (lastAt === null) {
        return { ...base, run: true, reason: '', decidedBy: 'first' };
    }
    const sinceMs = nowMs - lastAt;
    if (lastAt > nowMs) {
        return { ...base, sinceMs, run: false, reason: '时钟回拨（上次扫描时刻在未来）⇒ 保守不跑', decidedBy: 'clock-back' };
    }
    if (autoKey !== null && autoKey === todayKey) {
        return { ...base, sinceMs, run: false, reason: `今天已经扫过（当地 ${todayKey}）⇒ 一天一次`, decidedBy: 'same-day' };
    }
    if (sinceMs < minIntervalMs) {
        return {
            ...base, sinceMs, run: false, decidedBy: 'min-interval',
            reason: `跨天了但距上次仅 ${(sinceMs / 3600000).toFixed(2)}h（不足 ${minIntervalMs / 3600000}h 最小间隔）⇒ 本日下一次启动再跑`,
        };
    }
    return { ...base, sinceMs, run: true, reason: '', decidedBy: lastKey === null ? 'first' : 'day' };
}
/**
 * 【L3-B3 · 2026-10-15 · Teddy 拍**删**】`sweepDue` 已删（原 12 行）。
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
