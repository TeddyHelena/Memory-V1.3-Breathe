/**
 * ingest.ts —— V1.2 写入管道（契约清单 §五 / TechDesign §6.1）
 *
 * ── 这一层存在的唯一理由 ──────────────────────────────────────────
 * 衰减引擎（V1.3）读取 `last_accessed` 与 `decay_type`。若写入路径不落这两个字段，
 * **每一条新记忆都是「没有 last_accessed 的野生条目」**——存量回填的问题会在每条新
 * 数据上重演一遍。所以打标与初始化必须在**写入那一刻**发生，而不是等 V1.3 补。
 *
 * ── 模块边界（刻意的） ────────────────────────────────────────────
 * 本模块**只做纯函数**：不读盘、不写盘、不碰容器。调用方（writer.ts）拿到结果后
 * 自己组装 frontmatter 并落盘。这样做的收益：① 单测不需要容器 fixture；
 * ② 不引入 writer → ingest → container → writer 的循环依赖；
 * ③ 「打标规则」成为可独立审计的一段逻辑，而不是散在写事务里。
 *
 * ── 与既有字段的关系 ──────────────────────────────────────────────
 * `decay_type`（core/recent/process）与 `memory_type`（experience/world/opinion）
 * **正交**，两者并存、互不覆盖。见 types.ts 的命名说明。
 */
import type { DecayType, EntryFrontmatter, LifecycleStatus, MemoryScope } from './types.js';
/** ingest 抛出的错误：写入方据此区分「参数问题」与「系统问题」 */
export declare class IngestError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
/** 写入操作类型（与 types.ts 的 Operation 同形；此处独立声明避免循环依赖） */
/**
 * 会**改动正文**的操作类型 —— 只有它们需要（也才允许）重新分类衰减类型。
 *
 * ⚠️ 类型收不住的地方由运行期兜住：`classifyDecayType` 对**非内容类**操作
 * （`relocate`/`confirm`/`discard`）**直接报错**，⛔ 不许静默落到 `'recent'` ——
 * 那会让"换个存放层"顺手改掉这条记忆的衰减性质，而且没人会发现。
 */
export type IngestOperation = 'remember' | 'update' | 'forget' | 'propose';
export interface ClassifyInput {
    /** 参与分类的操作；⛔ 非内容类操作会在运行期被拒绝（见 classifyDecayType 顶部） */
    operation: IngestOperation | 'relocate' | 'confirm' | 'discard';
    /** 调用方显式指定的衰减类型（模型/工具入参）；缺省则按 operation 规则推定 */
    explicit?: string;
    /** 该条被 update 纠正时，旧版本的 decay_type（应当继承，不重新推定） */
    inherited?: DecayType;
    title?: string;
    content?: string;
    tags?: string[];
}
/**
 * 衰减类型打标。
 *
 * **规则（V1.2 契约 §五）**：
 * - `propose`（候选区，未经人工确认）→ `process`：幂律快衰，符合「可能是噪声」的定位
 * - `update` 且旧版本有 decay_type → **继承**（纠正不该改变一条记忆的衰减性质）
 * - 其余（remember）→ `recent`；`core` **只能显式指定**，不自动晋升
 *
 * **为什么不自动判 core**：core 语义是「几乎不衰」，自动判定等于让引擎自己决定
 * 什么记忆永不遗忘——那需要真实使用数据支撑，V1.2 没有。宁可保守：默认 recent，
 * 由调用方显式抬升（或 V1.3 的 lifecycle 依据 access_count 晋升）。
 *
 * 显式值非法 → 抛错拒绝写入（对齐 frontmatter 门禁：不猜、不修正）。
 */
export declare function classifyDecayType(input: ClassifyInput): DecayType;
export interface DecaySeed {
    decay_type: DecayType;
    last_accessed: string;
    access_count: number;
    lifecycle: LifecycleStatus;
}
/**
 * 新条目的衰减字段初值。
 *
 * `last_accessed` 取**写入时刻**（不是零值）：新鲜度的语义是「最近一次被唤起」，
 * 而写下这条记忆本身就是一次唤起。置零会让新条目一出生就被判为陈旧。
 */
export declare function initDecayFields(decayType: DecayType, nowIso: string): DecaySeed;
/**
 * 唤起重置（decay.touch 的纯函数内核）。
 *
 * V1.2 只承诺两件事：`last_accessed` 有地方落、`access_count` 能涨。
 * **不承诺曲线**——t 的计算、λ 的取值、ε 地板全部是 V1.3 的事（契约 §二）。
 */
export declare function touchFields(fm: Pick<EntryFrontmatter, 'access_count'>, nowIso: string): {
    last_accessed: string;
    access_count: number;
};
/**
 * 内容指纹：用于"撞内容"判重。
 *
 * 归一化：**先把数值整段护住** → 去所有空白 + 去常见中英标点 + 大小写折叠 → 还原数值。
 * 归一化后的哈希，只支持**精确**判重。
 *
 * 【S2 · P1-6 修复】为什么必须护住数值：
 *   原实现的删除集里含 `-` 与 `.`，于是 `余额为 -5000 元` 与 `余额为 5000 元`
 *   归一化后**逐字相同** → 判重误命中 → 后一条被"吸收"（不新建、只加 `access_count`）
 *   —— **一条相反的事实被吞掉**，且不可逆。同理 `利率 1.5` 与 `利率 15` 撞车。
 *   修法取**最小改动**：删除集一个字符都不动，只把"数值"先抽成占位符、归一化末尾再还原
 *   ⇒ 除数值相关的撞车外，**判重行为与修复前逐字一致**（钉子：仅标点差异那条必须仍然命中）。
 *
 * 数值口径：允许正负号 / 千分位 / 小数点；**千分位归一**（`1,000` ＝ `1000` 属同一数值）。
 * 已知取舍：日期式 `2026-10-08` 会被切成三个数值（`2026` / `-10` / `-08`）⇒
 *   `2026-10-08` 与 `20261008` 不再撞车。方向是**少合并**（保守侧），刻意认下。
 */
export declare function contentFingerprint(text: string): string;
/**
 * 判重（PRD §②「撞标签/撞内容 → 合并或新增 access，不堆重复条目」）。
 *
 * ── 口径：只拦**确定性重复**，不做模糊合并 ──────────────────────
 * 拦两级：
 *   ① **精确**：归一化后的内容指纹相同（同一件事说了两遍）
 *   ② **精确**：标题完全相同 **且** decay_type 相同（同一主题的重复登记）
 *
 * **刻意不做的事**：不做相似度阈值合并。
 * 理由：模糊阈值的正确取值需要**离线标定集**（PRD 自己也写了"gate 阈值…必须离线标定"）。
 * 在标定前拍一个阈值，等于用一个未验证的数去决定"两条记忆是不是同一件事"——
 * 判错的方向是**把不同的事合成一件**，那是不可逆的语义损失。
 * 所以：**确定性重复现在拦，模糊重复等标定**（V1.3 的活）。
 *
 * 另外注意：`writer` 侧已有 `idem_key`（同 session+message+content 幂等），
 * 与本函数是**两层**：idem_key 管"同一次调用不重复落库"，本函数管"不同调用说了同一件事"。
 *
 * ── 【S2 · P1-5】判重必须带作用域 ────────────────────────────────
 * 修复前：候选集**不看 scope** ⇒ A 项目的条目参与 B 项目的判重，命中后还会去改
 * 别人项目那条的 `last_accessed` / `access_count`（跨项目写入痕迹）。
 * 修复后：**同一性**用 `policy.sameScope`（⛔ 不是 `isInScope`，那是可见性）——
 *   同一 scope ⇒ 吸收；跨 scope 撞同文 ⇒ **不合并**，只回一条 `content_other_scope` 提示，
 *   已拍口径见 `policy.sameScope` 注释（作者 2026-10-08：跨 scope 不合并）。
 */
export interface DupCandidate {
    id: string;
    title: string;
    decay_type?: DecayType;
    /** 候选条目的作用域（缺省即 global，与 `policy.memoryScope` 同口径） */
    scope?: MemoryScope;
    scope_id?: string;
    /**
     * 【S2 · S2-C】预置的内容指纹（容器侧按文档对象记忆化）。
     * 缺省时本函数自己算——保底正确，但每次写入会重算全库（判定实验里那 42% 的成本）。
     */
    fp?: string;
}
export interface DupHit {
    hit: DupCandidate;
    /**
     * 命中方式，供审计与日志：
     *   · `content` —— 同 scope 内容逐字相同 ⇒ 吸收
     *   · `title` —— 同 scope 标题相同且 decay_type 相同 ⇒ 只提示，不合并
     *   · `content_other_scope` —— 内容相同但**在别的 scope** ⇒ 只提示，不合并（S2-B）
     */
    via: 'content' | 'title' | 'content_other_scope';
}
export declare function findDuplicate(incoming: {
    title: string;
    content: string;
    decayType: DecayType;
}, existing: Array<DupCandidate & {
    content?: string;
}>, 
/** 本次写入自己的作用域；缺省 global（与 `writer.buildRecord` 的缺省一致） */
selfScope?: {
    scope?: MemoryScope;
    scope_id?: string;
}): DupHit | null;
/**
 * 【L3-A1 · 2026-10-15 · 作者 拍**删**】`pickPool` 已删（原 14 行，见下）。
 *
 * 删的三条依据（齐了才敢删）：
 *   ① **零引用** —— 全仓只有它自己 + 死导出白名单（连测试都没用）
 *   ② **白名单自述的承诺到期** —— 原文：*"落池判定需要 `hotCap`，而该参数**没有任何标定来源**；
 *      V1.2 不引入拍脑袋的容量阈值去决定「文件落在哪一层」。**留待 V1.3 标定后接入，或届时删除**"*
 *      ⇒ **V1.3 已发布且过门禁** ⇒ 承诺到期
 *   ③ **活的落层不需要它** —— 新条目一律 `layer: 'longterm'`（`writer.ts` 硬编码），
 *      hot 层由**人工策展**维护（`hot_order`），层间移动走**显式** `writer.relocate(id, targetLayer)`
 *
 * ⇒ ⭐ **落层没有"判定"，是「硬编码 longterm + 人工策展 hot + 显式 relocate」** ——
 *   这就是 L0 全程图上**红项 ②**（"`pickPool` 零引用 ⇒ 层的归属不明"）的答案。
 * ⇒ ⛔ 若将来要做"自动落池"，**先标定 `hotCap` 的来源**（容量上限从哪来），⛔ 不许拍脑袋。
 */
