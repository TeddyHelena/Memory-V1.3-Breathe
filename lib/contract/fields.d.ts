/**
 * contract/fields.ts —— 双真源「必须同步字段」契约（V1.3-A · G1）
 *
 * ── 治的是什么病 ────────────────────────────────────────────────
 * 容器有两个真源：**条目文件的 frontmatter**（唯一持久化真源）与 **index.json**（派生索引）。
 * 「哪些字段必须镜像进索引」这件事，原先**没有任何地方写过**，靠开发者记性维持：
 * 新增一个字段，要在七处分别记得改；漏一处，两端**都不报错**，只是静默地少一个字段。
 *
 * V1.2 实录（真踩过）：第 5 处漏了 `decay_type` / `last_accessed` / `access_count` /
 * `lifecycle` / `cold_start_until` ⇒ **文件里有、索引里没有**，**223 项测试一条都没报**。
 * 当时的修法是给这五个字段补断言 —— 那是给**字段**上的锁，不是给**机制**上的。
 *
 * V1.3-A 开工前实测（先红证据，2026-10-09）：把索引里 `h01` / `l70` 的 `decay_type`
 * 删掉，**四个出口全哑** —— `/list` 的 drift 判据报 0 条、`drift-audit` C 段报「不符 0 处」、
 * `container.load({verify:true})` 通过且无告警、路由侧读到 `undefined` 后静默按未分类处理。
 * 根因就是 `container.validate()` 里那句「单侧缺值 = 隐含默认，不是漂」——
 * 它本意是放过旧条目，实际把**索引陈旧**也一起放过了。
 *
 * ── 本模块给三个东西 ────────────────────────────────────────────
 *   ① **判定准则**（三条，不是一张会过期的表）：见下 `RULE_*`
 *   ② **字段注册表**：每个字段的镜像去向 + 缺省语义 + 归属准则
 *   ③ **单一漂移判据**：`diffEntryFields()` —— `/list`、容器自校验、`/selftest`
 *      以及未来的消费方**共用同一处实现**（⛔ 不许各自另写一份）
 *
 * ── 为什么判定用"准则 + 注册表"而不是只给一张表 ──────────────────
 * 表会过期：加字段的人不知道有这张表存在。准则不会——它回答的是
 * "这个字段该不该进索引"，而这个问题在任何时候都有同一个答案。
 * 防漂移靠 `test/contract-fields.test.mjs`：**新增字段没登记 ⇒ 测试红**。
 */
/**
 * R1 —— **被索引驱动的读路径消费** ⇒ 必须镜像。
 *
 * 判据不是"谁需要"，而是"**这条路线上有没有文件**"：
 * `/list`、检索、路由、图谱、设置页列表这些路径**不读文件**（读文件就是 O(n) 读盘，
 * @2000 实测 1645ms，V1.1 专门治过），它们只吃索引。字段在这条线上被用 ⇒ 必须进索引。
 */
declare const RULE_MIRROR_READ_PATH = "R1";
/**
 * R2 —— **只在单条详情 / 写路径内部使用** ⇒ 不镜像。
 *
 * 反例（刻意不镜像）：`supersedes`（替代链，写事务内部用）、`hot_mode`（装配期逐条读文件）、
 * `checksum`（发布/修复脚本用）。把它们塞进索引**不解决问题，只增加要同步的地方**。
 */
declare const RULE_FILE_ONLY_DETAIL = "R2";
/**
 * R3 —— **用于校验 / 审计而非读侧决策** ⇒ 不镜像。
 *
 * `checksum` 是这一类：它的消费者是启动抽样校验与修复脚本，不是路由。
 * ⚠️ 与 R2 的区别是"这个字段该不该有校验"，不是"谁读它"——两条都通往 file-only，
 * 但理由不同，写下来是为了**下一个人改分类时知道当初为什么**。
 */
declare const RULE_FILE_ONLY_AUDIT = "R3";
export type FieldRule = typeof RULE_MIRROR_READ_PATH | typeof RULE_FILE_ONLY_DETAIL | typeof RULE_FILE_ONLY_AUDIT;
export type MirrorClass = 'mirror' | 'file-only';
export interface FieldSpec {
    /** frontmatter 字段名（与 `EntryFrontmatter` 一致） */
    readonly name: string;
    /** 镜像去向 */
    readonly mirror: MirrorClass;
    /** 归属准则 */
    readonly rule: FieldRule;
    /**
     * **登记好的缺省值**：文件侧没有这个字段时，索引侧该是什么。
     *
     * 派生视图允许补默认值（`status` 缺省就是 `active`），但**默认值必须登记在这里**，
     * 且判定时按"索引值 == 登记默认"来认——否则索引凭空多出一个别人不知道的值，就是漂移。
     *
     * `undefined` = **没有默认**：这时文件缺、索引有 = 索引凭空多出东西（漂移）；
     * 两侧都缺 = 数据缺口（如实计数，⛔ 不许拿默认值静默顶替）。
     */
    readonly defaultWhenAbsent?: string | number;
    /**
     * **两侧都缺**时的性质（只对 `mirror` 字段有意义）。三档，对应三种**不同的动作**——
     * 混成一档就会出现"看得懂但没法下手"或"看不见"：
     * - `'normal'`（缺省）：这个字段本来就是可选的 —— 大多数记忆没有 `valid_to`、
     *   没有墓碑字段、没有 `scope_id`。两侧都缺 = **常态**，⛔ 不计数
     *   （实测第一版把 112 条的 `valid_to` 全算成缺口，1367 处噪声盖住 51 处真信号）。
     * - `'gap'`：**该有值却没有，且能真回填** ⇒ 数据缺口，归回填（G2）。
     * - `'legacy'`：**该有值却没有，但不可重建** ⇒ 历史遗留，⛔ 不许编一个值糊上，
     *   单独计数、如实列出。只登记**V1.3 读得到的那些**，其余留给各自专项。
     */
    readonly absence?: 'normal' | 'gap' | 'legacy';
    /** 为什么这样归类（一句话，给下一个改分类的人看） */
    readonly why: string;
}
/**
 * 注册表。**加字段先来这里登记，再去改落点**（否则 `test/contract-fields.test.mjs` 会红）。
 *
 * 排序：先镜像字段（按消费路径分组），后 file-only 字段。
 */
export declare const FIELD_REGISTRY: readonly FieldSpec[];
/** 镜像字段名（派生，⛔ 不许再手写第二份 —— 历史上那三份已经静默对不上过一次） */
export declare const MIRROR_FIELD_NAMES: readonly string[];
/** 索引**独有**（frontmatter 里没有）的结构字段——`file` 是索引自己算出来的相对路径 */
export declare const INDEX_ONLY_FIELDS: readonly string[];
/**
 * 漂移分类。**必须分得开"旧条目"与"真漂移"** —— 混在一起就没人看得懂读数，
 * 而"看不懂"的下一步就是"不看了"（本项目反复栽在这条链上）。
 */
export type DriftKind = 
/** 文件有、索引没有 ⇒ 索引陈旧（真漂移） */
'index-stale'
/** 索引有、文件没有 ⇒ 索引多出东西（真漂移，通常是回滚或手改留下） */
 | 'index-extra'
/** 两侧都有但值不同 ⇒ 索引陈旧（真漂移） */
 | 'value-mismatch'
/** 两侧都没有、且**能真回填** ⇒ 数据缺口（回填的活，不是漂移） */
 | 'both-missing'
/** 两侧都没有、且**不可重建** ⇒ 历史遗留（⛔ 不许编个值糊上，只如实记录） */
 | 'legacy-missing';
export interface FieldDrift {
    id: string;
    field: string;
    kind: DriftKind;
    fromIndex: unknown;
    fromFile: unknown;
}
/** 真漂移：需要人处理的三类 */
export declare const REAL_DRIFT_KINDS: readonly DriftKind[];
/**
 * 单条条目的字段漂移。**这是全仓唯一一处漂移判定实现。**
 *
 * 判据（三个分支，与 `container.validate()` 的调用点共同构成契约）：
 *   · 只比 `mirror: 'mirror'` 的字段（file-only 字段本来就不进索引）
 *   · **文件有、索引没有** ⇒ `index-stale`（派生视图陈旧，真漂移）
 *   · **文件没有、索引有** ⇒ 只有等于**登记默认值**才合法；否则 `index-extra`（索引凭空多出东西）
 *   · **两侧都缺** ⇒ `both-missing`：这**不是漂移**，是数据缺口（未回填的旧条目），
 *     单独计数、单独汇报 —— ⛔ 不许拿登记默认值静默顶替（那正是 G2 回填要治的病）
 *
 * V1.2 那句「单侧缺值 = 隐含默认，不是漂」为什么是错的：它把"旧条目"（**两侧都缺**）
 * 与"索引陈旧"（**文件有、索引没有**）当成了同一件事，于是一整类真漂移被静默放过。
 */
export declare function diffEntryFields(id: string, fromIndex: Record<string, unknown>, fromFile: Record<string, unknown>): FieldDrift[];
/**
 * 索引侧缺了哪些"必须回退"的字段（纯索引计算，**不读文件** —— 这正是它能用在 `/list` 快路径上的原因）。
 *
 * `scope_id` 单独处理：它**只在 `scope` 是 workspace/project 时才有意义**，
 * `global` 条目常年没有它 —— 无脑把它算进回退，等于又给全体条目加一次读盘，
 * 而且那是**语义错误**（`global` 本来就不该有 scope_id）。判定与 `policy.isInScope` 对齐。
 */
export declare function listFallbackFields(fromIndex: Record<string, unknown>): string[];
export {};
/** 读数汇总（报告用；**照实报绝对数，⛔ 不许用比率掩盖数量**） */
