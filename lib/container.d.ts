/**
 * 容器读写器：负责加载 index.json、按需读取条目文件。
 * 默认只读；写入能力（updateEntry/saveIndex）由调用方显式启用
 * （插件层 allowEdit 开关），所有路径基于容器根目录相对解析且不得越界。
 */
import type { ContainerEntry, ContainerIndex, ContainerEntryFile, EntryFrontmatter, HotOrderSnapshot } from './types.js';
/** 单条条目的可编辑字段（写路径的 patch 契约） */
export interface EntryPatch {
    title?: string;
    content?: string;
    tags?: string[];
    priority?: number;
    summary?: string;
    /**
     * ── 状态机三个字段（【C-0 · H6】2026-10-10 新增）────────────────────────
     * 为什么必须加：此前 `updateEntry` 只认上面五个字段，用 `writer.edit()` 去写
     * `status` / `superseded_by` / `expires` 会**静默什么都不做**（还返回成功）——
     * 这正是本仓反复治的病（"看着有动作、实际没出口"）。抓到它的是 C-0 的端到端判据，
     * 不是代码评审 —— 因为那条判据断言的是**真效果**，不是状态码。
     * ⛔ `status` 只有三个合法值（见 `updateEntry` 里的校验）：不许新增第四个。
     */
    status?: 'active' | 'expired' | 'superseded';
    superseded_by?: string;
    expires?: string;
}
/**
 * 新增条目文件的入参：frontmatter 由 writer 组装，container 只负责路径解析、序列化与原子落盘。
 * 这样「写哪、怎么写」的机械部分留在 container，「写什么、按什么规则写」留在 writer。
 */
export interface NewEntryFile {
    id: string;
    layer: ContainerEntry['layer'];
    frontmatter: EntryFrontmatter;
    content: string;
}
/**
 * 【S2 追刀】判重用索引：**指纹 → id[]** 与 **标题+decay → id[]**。
 *
 * 为什么要有它：判重原先每次都把全部 n 条候选重建成数组、再线性扫一遍（O(n)）——
 * 即使"重读全库"那一刀已经把 I/O 降下来，**扫描面仍是 O(n)**。
 * 本索引在写入时只查"命中桶"（通常 0–2 条），扫描面降到 O(命中数)。
 * 维护方式：**懒建一次 + 随语料增量同步**（见 `corpus()` 的增删分支）——
 * ⛔ 不许每次重建，否则又回到 O(n)。
 */
export interface DupIndex {
    byFp: Map<string, string[]>;
    byTitle: Map<string, string[]>;
}
/**
 * 标题撞车的键：**只看标题**。
 *
 * ⚠️ 2026-10-10 改（作者 拍）：原来键里带 `decay_type` ——
 * 后果是"同一句话因为标了快衰就变成两条"，而且**改默认 decay_type = 偷偷改判重行为**
 * （实测：把默认从 recent 改成 process，判重类测试直接红 ⇒ 这才发现耦合）。
 * 判定理由：`decay_type` 说的是"这条该怎么衰减"，**不是"这条是什么"** ⇒ 不该参与"是不是同一条"。
 * ⛔ 保留第二个参数只为**不改调用方签名**；它**不参与**键值。
 */
export declare function dupTitleKey(title: string | undefined, _decayType?: string | undefined): string;
export declare function stripFileOnlyFromIndex(index: {
    entries?: ContainerEntry[];
} | null | undefined): number;
/** 【P0-6】会话 id 分类：host=真 uuid；legacy_literal=历史标签；placeholder=占位；absent=无 */
export declare function classifySessionKind(v: unknown): 'host' | 'legacy_literal' | 'placeholder' | 'absent';
export declare class MemoryContainer {
    /**
     * 投影字段表 —— **已改为从字段注册表派生**（V1.3-A · G1）。
     *
     * 历史上这里是**手写的第二份**，注释还写着「与 scripts/drift-audit.mjs /
     * repair-index-projection.mjs 保持同一张表」—— 三处手写 = 必然静默对不上
     * （实测：`decay_type` 这类 V1.2 字段三处都没有，索引缺了没人报）。
     *
     * 现在唯一真源是 `src/contract/fields.ts` 的 `FIELD_REGISTRY`；
     * 这个静态字段**只作兼容出口**保留（脚本与测试按名字取用）。
     * ⛔ 不许再在这里手写第二个数组。
     */
    static readonly PROJECTION_FIELDS: readonly string[];
    readonly root: string;
    private readonly realRoot;
    private index;
    /** id → 条目元信息的映射（避免每次 O(n) 线性查找；索引变更时重建） */
    private byId;
    /** 语料级缓存：索引指纹 → 已解析文档（检索一次取齐后复用，避免逐条 stat） */
    private corpusCache;
    /** 【S2 · S2-C】本进程自己写过的条目（增量刷新语料用；⛔ 不再整片作废语料缓存） */
    private corpusDirtyIds;
    /** 【S2 · S2-C】是否相信自己能增量维护语料：检测到**外部改动**即置 false ⇒ 退回整片重建 */
    private corpusTrusted;
    /** 【S2 · S2-C】内容指纹备忘录，键是条目文件对象（见 `contentFpOf`） */
    private readonly fpMemo;
    /**
     * 【Ledger · L-1】崩溃自愈留痕：每次"索引指向的文件不在、已在别处找回并回正"记一条。
     * ⛔ **不许静默修**——修了不报，等于把"出过事"这件事藏起来（我们反复栽在这类"看起来没事"）。
     * 出口：`/selftest` 的 `repair_events`（与 `index_merge_events` 并列）。
     */
    readonly repairEvents: string[];
    /**
     * 【D3 · 常驻名单审计】非抛出的**不一致清单**（2026-10-09）。
     *
     * 为什么单列（真事）：`h10` 的 `layer=hot` 却**不在 `hot_order`** —— 文件在、但**永不注入**，
     * 而且**掉了 6 周没人知道**（直到审计时人工比对才发现）。既有校验只查了单向
     * （"hot_order 引用的条目存在吗/合法吗"），**没有查反方向**。
     *
     * 口径：
     *   · `hot 层但不在名单` ⇒ **警示**（这条记忆靠层投递是投不出去的，只有名单算数）
     *   · `名单里层不是 hot` / `名单里带到期边界` ⇒ **如实记下**，不是错误（longterm 进名单是合法的）
     */
    readonly hotAudit: string[];
    /** 本轮 load 是否修过投影（修了就**立刻落盘**，否则下次 load 又读到盘上那份错的——永远不收敛） */
    private repairedThisLoad;
    /** 增量日志文件名 */
    private static readonly DELTA_LOG;
    /** 最近一次落盘快照的哈希（日志记录里的 `base` 与它比对） */
    private snapshotHash;
    /** 日志文件的时间戳/大小（字节等价快路径要连它一起比，否则漏掉别的通道追加的记录） */
    private logStamp;
    /** 自上次快照以来被动过的条目 id */
    private dirtyIds;
    /** 自上次快照以来被删掉的条目 id */
    private removedIds;
    /**
     * **结构变了** ⇒ 只能整份写快照（L-1 自愈回正投影 / 外部改动的三路合并）。
     * ⚠️ 第一版把"新增条目（entry_count 变了）"也算成结构变化 ⇒ **每条 remember 都走整份快照**，
     *    实测写入一点没降（@2000 13.31ms，与改前持平）——这条教训留在注释里。
     *    entry_count 本来就随增量记录一起带（`count` 字段），不需要整份写。
     */
    private structuralDirty;
    /** hot_order 变了 ⇒ 不必整份写：它很小，塞进增量记录即可 */
    private hotOrderDirty;
    /** 【L-5】日志作废 / 压缩留痕（与 repairEvents、indexMergeEvents 并列，⛔ 不许静默） */
    readonly indexLogEvents: string[];
    /** 【L-5】日志里**最早**一条记录的时间（时间护栏用：给"直接读 index.json 的人"一个有界的陈旧窗口） */
    private logFirstAt;
    /** 【L-5】日志最多允许陈旧多久（毫秒）——超过就折平。默认 5 分钟 */
    private readonly logMaxAgeMs;
    private get deltaLogPath();
    private statLog;
    /** 【L-5】标记某条目在索引投影里动过（下次落盘只需把这一条写进日志） */
    private markIndexDirty;
    /** 【L-5】hot_order 变了（小字段，增量带得动） */
    private markHotOrderDirty;
    /**
     * 【L-5】强制下一次落盘写**整份快照**。三类必须走它：
     *   ① **隐私删除**（墓碑 / purge）—— 脱敏结果必须落进快照，否则 index.json 里还留着原文（安全）；
     *   ② **结构修复**（L-1 自愈回正投影）；
     *   ③ **外部改动的三路合并** —— 合并后磁盘上的快照已经不是我们的基线，
     *      此时追加的记录 `base` 对不上 ⇒ 重载时整份日志作废、本次改动会丢（实测：test #79 抓到）。
     */
    forceIndexSnapshot(): void;
    /** 【L-5】索引持久化状态（事务回滚要把日志与脏集合一起还原，否则留下半截状态） */
    captureIndexPersistence(): {
        logRaw: string | null;
        dirty: string[];
        removed: string[];
        structuralDirty: boolean;
        hotOrderDirty: boolean;
        snapshotHash: string;
        lastIndexRaw: string | null;
    };
    restoreIndexPersistence(state: ReturnType<MemoryContainer['captureIndexPersistence']>): void;
    private static hashText;
    /** 【S2 · S2-D】语料代数：语料内容**真变过**就 +1（检索侧缓存拿它当失效判据） */
    private corpusGeneration;
    /** 【S2 追刀】判重索引（懒建）；`null` = 还没建，下次 `dupIndex()` 从语料建一次 */
    private dupIdx;
    /**
     * 【S2 追刀·二】"我刚写下去的那份 index.json 原文"。
     *
     * 用途：写事务开头的 `load()` 要重读索引（l57 的并发防线，⛔ 不可拆），
     * 但**重读的代价里 90% 是 `JSON.parse`**（@2000 实测 5.2ms / 680KB）。
     * 判据取**字节完全相同就跳过解析**——不是比 mtime、不是比指针大小，
     * 是比内容本身：字节相同 ⇒ 解析结果必然相同，**零正确性风险**。
     */
    private lastIndexRaw;
    /** 文档缓存：id → { 文件 mtimeMs, 解析结果 }。失效由 mtime 比对 + 写路径显式调用双保险。 */
    private readonly entryCache;
    /**
     * 分词缓存：id → { 文件 mtimeMs, 词频表, 加权长度 }。
     *
     * **为什么必须缓存它**：检索的真实成本不在打分，在 `buildDocument()` 的**重复分词**
     * ——实测 2000 条时单次检索 86ms，其中绝大部分是把每个条目的标题/标签/摘要/正文
     * 重新切 2-gram。而这些 token **与时间状态无关**（状态只影响一个乘数权重），
     * 所以可以按 id+mtime 缓存词频表，跨查询复用。
     *
     * 内存代价（算术背书）：词频表约 500 词/条 × 2000 条 ≈ 20MB；
     * 宿主上下文窗口是 1M token 量级，这点内存不构成压力，换来检索从 86ms 降到个位数。
     */
    private readonly tokenCache;
    /**
     * realpath 校验结果缓存：绝对路径 → 已校验通过（或抛过错的标记）。
     *
     * 为什么需要：`resolveInside` 对**每个存在的目标**做一次 `fs.realpathSync` 来挡符号链接越界。
     * 实测单次 0.0188ms × 500 条 = **9.01ms**——`/list` 在 500 条时的 12.46ms 里四分之三是它。
     * 而 realpath 对同一个文件不会变（除非文件被替换），缓存安全。
     *
     * 失效：写路径（atomicWrite / 删除 / 换层）后 `clearCache()` 会清空它。
     */
    private readonly realPathCache;
    /**
     * 投影对账结果（2026-10-07 加；**2026-10-09 V1.3-A · G1 改由字段注册表判定**）：
     * 本次 `load({verify:true})` 里发现的「索引（派生）≠ 条目文件（唯一真源）」清单，
     * 形如 `l-e01.source（index-stale 索引=undefined 文件="卷一…"）`。
     *
     * 只记录、**不阻断加载** —— 理由见 validate() 里那段注释（容器不能被自己的校验写死）。
     * 出口：`/selftest → data.projection_drift`，以及 scripts/drift-audit.mjs。
     */
    private projectionDrift;
    /**
     * **数据缺口**（V1.3-A · G1 新增）：两侧都缺、且该字段**按契约该有值**的清单。
     *
     * 与 `projectionDrift` 严格分开的理由：漂移是"两个真源对不上"（要回正索引），
     * 缺口是"这条记忆压根没这个字段"（要回填数据）——**两件事的处置方式完全不同**，
     * 混在一起报就没人看得懂了（而"看不懂"的下一步就是"不看了"）。
     */
    private dataMissing;
    /**
     * **历史遗留**（V1.3-A · G1）：两侧都缺、且**不可重建**的清单（如 14 条旧条目的 `source`）。
     *
     * 为什么单列一档：这类字段**不许编个值糊上**（不撒谎），但也不能藏起来（看不见=当没有）。
     * 三档各有各的动作：漂移→回正索引，缺口→回填数据，遗留→**只记录**。
     */
    private legacyMissing;
    /**
     * **正文完整性**（V1.3-A · G3）：本次 `load({verify:true})` 的校验结果。
     * `checksumMismatch` 非空 = 正文被改动过而校验和没跟上 —— **这是真信号，不许粉饰**。
     * `checksumUnverifiable` = 旧格式（v3:）或空值：**不算通过也不算失败**，单独报。
     */
    private checksumMismatch;
    private checksumVerified;
    private checksumUnverifiable;
    /** 读投影对账结果（load 之后有效；空数组 = 索引与文件一致） */
    getProjectionDrift(): readonly string[];
    /**
     * 【孤儿发现 · 2026-10-19】启动扫描到的“盘上有 md、索引里没有”的条目（hot/longterm/archive）。
     * ⛔ 只发现、不自动收养：收养要先确认 id 冲突/来源，属于人工决策。pending/ 的孤儿仍由
     * `assertPendingConsistency` fail-fast 处理（写入方必须文件+索引联合提交）。
     */
    private orphanFiles;
    getOrphanFiles(): readonly string[];
    /** 扫描三层（hot/longterm/archive）的未登记 md；返回相对路径。只在 verify 档调用。 */
    private scanOrphanFiles;
    /**
     * 读**数据缺口**（load 之后有效；空数组 = 该有值的字段都有值）。
     * ⛔ 不许和 `getProjectionDrift()` 混着报：漂移要回正索引，缺口要回填数据。
     */
    getDataMissing(): readonly string[];
    /**
     * 读**历史遗留**（load 之后有效；空数组 = 没有不可重建的缺字段）。
     * 出口 `/selftest → data.legacy_missing`。⛔ 这一档**不做任何写动作** —— 不可重建就是不可重建。
     */
    getLegacyMissing(): readonly string[];
    /**
     * 读正文完整性读数（load 之后有效）。出口 `/selftest → data.checksum`。
     * ⛔ 三个数必须**一起报**（verified / mismatch / unverifiable）—— 只报 mismatch 会让人
     * 以为"没报就是全对"，而实际可能一条都验不了。
     */
    checksumStatus(): {
        verified: number;
        mismatch: readonly string[];
        unverifiable: number;
    };
    constructor(root: string);
    /**
     * 加载并校验 index.json（幂等，可重复调用）。
     *
     * **两档校验（2026-09-15 微基准后拆分，见 stress4-report.json）**：
     * 微基准实测「写入 p50 116ms，其中 load 109ms，占 94.2%」——而 load 里
     * 读盘 0.8ms + 解析 1.1ms，**剩下的 103ms 全是逐条读条目文件做交叉校验**。
     * 这条路径每次写事务都要走一遍，等于写一条记录要把 2000 个文件全读一遍。
     *
     * - `verify: true`（**默认**）：结构校验 + 逐条读文件交叉校验。启动期走这档，
     *   保持原有 fail-fast 强度——文件缺失 / id 错位 / layer 错位 / 符号链接越界都在这里抓。
     * - `verify: false`：**只做无文件 I/O 的索引校验**（schema、id 唯一、layer 合法、
     *   tags 形状、file 字段、hot_order 引用存在且无重复无残留已废弃）。
     *
     * 为什么写事务用快档是安全的：事务在**持锁之后**调用本方法，目的是「对齐磁盘最新索引」
     * 而不是「体检容器」。索引自身的完整性仍被完整校验（快档不是不校验）；
     * 文件级脱节由启动期全量校验兜底（那时必 fail-fast，不会带着坏容器跑）。
     */
    load(options?: {
        verify?: boolean;
        repairProjection?: boolean;
        persistRepairs?: boolean;
    }): ContainerIndex;
    /**
     * 索引写盘的乐观锁（2026-10-07 加）——**防"外部修正被静默抹掉"**。
     *
     * 【为什么必须有】
     * 实测事故：2026-10-07 23:43 外部脚本把 index.json 修到"投影与真源一致"（18 处），
     * 审计当场确认 0 处；**23:53 就回到 18 处，一字不差**。根因：
     *   · DSH 进程 11:32 启动，把当时的索引载入内存（那时 `h01.updated=08-17`、`l-e01.tags` 少 `h01`）
     *   · 路由每 touch 一次 → `stampV12Fields` 重写条目文件 → `saveIndex()`
     *   · `saveIndex()` 把**内存索引整片 dump** 到磁盘，**写前不看磁盘被别人改过没有**
     *   · 于是外部修正被自己的旧内存副本覆盖：**无报错、无日志、10 分钟内完成**
     * 这不是"慢慢漂移"，是**一次正常写入把修正整片回滚**。
     * 它也解释了另一个老现象：文件里有 `access_count: 619`、索引里是空。
     *
     * 【为什么是三路合并，不是"重载再写"】
     * 重载会丢掉**本次会话自己的改动**（比如刚 `remember` 的新条目：文件已落盘、索引一重载就没了）
     * ⇒ 那是在制造我们治了一整天的"文件与索引分叉"。所以必须合并：
     *   对每个条目：**本次动过的用内存版，没动过的用磁盘版**（磁盘版含外部修正）。
     *
     * 【代价】平时只有一次 `statSync`（~0.005ms）；**只有冲突时**才读 100KB 磁盘索引 + 合并。
     * 不每次读全文件，是因为写路径已经有 8.4× 回归，不能再往上加。
     *
     * 【已知边界】判据是 `mtimeMs + size`。同一毫秒内、同字节数的外部写入会漏检
     * （概率极低；漏检的后果就是回到"被覆盖"，与加锁前等价，不会更坏）。
     */
    private indexStamp;
    /** load 时的内存索引快照，用于三路合并判"哪些是本次动过的" */
    private indexBaseline;
    /** 合并事件（供 /selftest 暴露）：外部修正被保住时要被看见，不许静默 */
    private indexMergeEvents;
    /** 读索引合并事件（≤10 条，最近在后） */
    getIndexMergeEvents(): readonly string[];
    /** 【L-5】增量日志现状（进 /selftest 出口：待折平记录数与最老一条的年龄） */
    indexLogStatus(): {
        pendingRecords: number;
        oldestAgeMs: number | null;
        snapshotHash: string;
    };
    private statIndex;
    /**
     * 校验索引契约，不完整直接抛错（fail-fast）。
     * @param verify true=附带逐条文件交叉校验（默认，见 load() 的两档说明）；false=只校验索引自身
     */
    private validate;
    /**
     * pending 目录一致性（2026-09-14 事故防复发 · 兜底层）：
     * index.json 登记为 pending 的条目，其文件必须落在 pending/ 目录内；反之 pending/ 目录下的
     * .md 文件必须全部被索引登记——否则说明有写入方「只写了文件没登记」或「只登记了没写文件」。
     */
    private assertPendingConsistency;
    /**
     * 公开版本：writer / CLI 需要把相对路径解析成容器内的绝对路径（并做越界与符号链接校验）。
     */
    resolvePath(relPath: string): string;
    /**
     * 确保层目录存在（v0.5 容器没有 pending/，首次写候选时必须自建）。
     * 只创建容器根目录下的直接子目录，且必须留在根目录内。
     */
    ensureLayerDir(layer: ContainerEntry['layer']): void;
    /**
     * 恢复内存索引到给定快照（写入事务回滚第一步）。
     * 只动内存，不碰磁盘——磁盘恢复由调用方自己决定怎么写（写失败时若在这里再写一次，
     * 会把回滚本身也炸掉：回滚路径必须尽可能少做会失败的事）。
     */
    /**
     * 只写 V1.2 五字段（decay_type / last_accessed / access_count / lifecycle /
     * cold_start_until），**不动 updated 与 checksum**。
     *
     * 来源：随路由引擎一同从 V1.2 移植（2026-09-30）。路由的"唤起即重置"靠它把
     * `last_accessed` / `access_count` 落到文件——但**不是每次路由都写**：
     * 路由只累积到 `pendingTouch`，由 `flushTouch()` 批量提交。
     *
     * ★ 保留 V1.2 那个"安全默认"的设计，因为它命中过三次同一个坑：
     *   本方法只写条目文件、**不落 index.json**，于是每个调用方都得**记得**补 `saveIndex()`。
     *   实际 touch / 摘要引擎 / 回填脚本三条路径全踩过（文件有、索引无 → 分叉）。
     *   **"要记得"就是会忘。** 所以默认 saveIndex=true（单条写入代价很小），
     *   批处理调用方显式传 false 并自己收尾。
     *
     * @returns 条目不存在时 false；文件缺失时抛（那是容器脱节，不能静默）
     */
    stampV12Fields(id: string, fields: Partial<Pick<EntryFrontmatter, 'decay_type' | 'last_accessed' | 'access_count' | 'lifecycle' | 'cold_start_until' | 'checksum' | 'summary'>>, options?: {
        saveIndex?: boolean;
    }): boolean;
    restoreIndex(snapshot: ContainerIndex): void;
    /**
     * 把容器内相对路径解析到根目录内；拒绝逃逸出根目录的路径（含 ../）。
     * 绝对路径不重锚定——读 voice.md 这类调用方传入的路径时按原样使用。
     */
    private resolveInside;
    getIndex(): ContainerIndex;
    /** 按 hot_order 返回有序的 hot 条目元信息 */
    hotEntries(): ContainerEntry[];
    /**
     * 读取单条条目完整内容（含 frontmatter）。
     *
     * **带文档缓存**（2026-09-15 · 压测评审清单 #1）：
     * 检索与图谱每次都全量读盘——2000 条时单次检索 576ms。这条路径是那笔债的源头。
     *
     * 缓存键 = id，值 = 解析结果 + 文件 mtimeMs：
     *   - 命中且 mtime 未变 → 直接返回（零 IO）
     *   - mtime 变了（外部改过文件）→ 重读并刷新（**不靠"只有我会写"的假设**）
     *   - 写入路径显式失效（invalidateCache），双保险
     *
     * 内存代价（算术背书，非 RSS 类比）：约 1KB/条 → 2000 条 ≈ 2MB，
     * 在 1M 上下文窗口的宿主里是噪声级。
     */
    readEntry(id: string): ContainerEntryFile | null;
    /** 失效单条缓存（写路径调用；外部改动由 mtime 比对兜底） */
    invalidateCache(id: string): void;
    /** 清空全部缓存（索引重建、批量操作后调用） */
    clearCache(): void;
    /**
     * 取条目的词频表与加权长度（带缓存）。
     *
     * `count` 由调用方注入（检索侧持有分词实现），container 不依赖检索模块。
     * mtime 变化即重算；写路径（invalidateCache）也会清它。
     */
    entryTokenStats(id: string, count: (content: string, meta: {
        title: string;
        tags: string[];
        summary: string;
    }) => {
        freq: Map<string, number>;
        length: number;
    }): {
        freq: Map<string, number>;
        length: number;
    } | null;
    /** 缓存诊断（日志/测试用） */
    cacheStats(): {
        size: number;
    };
    /**
     * 读取容器内的可选文件（如 voice.md）。
     * 相对路径基于容器根目录解析且不得越界；文件不存在返回 null，调用方自定兜底。
     */
    readOptionalFile(relPath: string): string | null;
    /** 按层位列出条目 */
    listByLayer(layer: ContainerEntry['layer']): ContainerEntry[];
    /** 解析条目文件：frontmatter + 正文 */
    private parseEntryFile;
    /** 按 id 查索引条目（走映射，O(1)） */
    entryMeta(id: string): ContainerEntry | null;
    /** 重建 id → meta 映射（索引变更后调用） */
    private rebuildById;
    /**
     * 【Ledger · L-1】按 id 在四层目录里找回条目文件（崩溃自愈用）。
     * 认两种命名：新版 `<id>.md`，存量 `<id>_<title>.md`。
     * 找不到返回 null（⇒ 调用方照旧 fail-fast）。
     */
    private findEntryFileById;
    /**
     * 索引指纹：由全部条目的 `id|file|updated` 拼成。
     *
     * 用途：**语料级缓存的失效判据**。逐条比 mtime 的代价是 O(n) 次 statSync
     * （实测 2000 条 = 119ms，把缓存本身的价值吃光了）；指纹是纯内存计算，
     * 只要索引没变就不必再验每条文件——因为文件的变更必然先反映到索引上
     * （写入走容器、外部改动由 load() 重新对齐）。
     */
    indexFingerprint(): string;
    /**
     * 取整份语料（带语料级缓存）。
     *
     * 指纹未变 → 直接返回上次的解析结果（零 IO）；变了 → **增量**刷新，不再整片重建。
     * 这是把「每查询 O(n) 次 stat」变成「每查询 O(1) 次指纹比较」的关键一步。
     *
     * ── 【S2 · S2-C】为什么从"整片重建"改成"增量刷新" ────────────────────
     * 判定实验（`docs/写入路径判定实验_20261008.md`）实测：写入 p50 的斜率里
     * **90.6% 是判重读全语料**——写一条 ⇒ 下一条写入的判重把 n 个文件全读回来重解析。
     * **一次写入的代价 = 整库字节量。**
     * ⚠️ **触发点有两个，主因不是 `invalidateCache`**（施工时探针复核纠正过一次归因）：
     *   · **主因 `load()`** —— 每次写事务开头都会重读索引（l57 定的并发防线，⛔ 不可拆），
     *     却顺手把文档/语料缓存整片清掉 ⇒ 等于每写一条整库重读（见 `load()` 里的判据修正）；
     *   · 次要触发点才是 `invalidateCache` 的整片作废。
     * 修法四件（缺一不可）：
     *   ① `invalidateCache` 只记脏（`corpusDirtyIds`），不整片作废；
     *   ② 本函数走**增量路径**：只重读脏的那几条 + 补新增 + 删已移除；
     *   ③ 底料改走 `readEntry`（**mtime 校验的文档缓存**）而不是裸读——增删之外零解析；
     *   ④ `load()` 在"索引等价"时保留缓存（见那里的判据）。
     * 安全兜底：**一旦发现外部改动**（`corpusTrusted=false`，见 `saveIndex` 的三路合并分支
     * 与 `readEntry` 的 mtime 失配）就退回整片重建——**正确性优先于性能**。
     * ⚠️ 快速路径判据有两条，**缺一条就会返回陈旧语料**（都是自测抓出来的）：
     *   `corpusTrusted` ＋ `corpusDirtyIds.size === 0` ＋ 指纹相同。
     */
    corpus(): Map<string, ContainerEntryFile>;
    /** 【S2 追刀】判重索引的懒建（第一次用到时建一次，此后随语料增量维护） */
    dupIndex(): DupIndex;
    /** 加一条到判重索引（`doc` 的指纹走 `contentFpOf` 的对象级记忆化，不重算） */
    private dupIndexAdd;
    /** 从判重索引里摘掉一条（增删/改文都要摘，否则会留幽灵命中） */
    private dupIndexRemove;
    /**
     * 语料版本串：**索引指纹 + 代数**。给检索侧当缓存失效判据（见 `search.ts` 的 CORPUS_CACHE）。
     * 为什么不能只给索引指纹：外部改文件不改索引时指纹不变，而语料已经换过一代。
     */
    corpusVersion(): string;
    /**
     * 内容指纹备忘录：键是**条目文件对象本身**（WeakMap）。
     *
     * 为什么用对象当键：`parseEntryFile` 每次都返回**新对象**，所以"对象没换"就等价于
     * "内容没变"——旧指纹随对象一起被 GC，**不需要任何失效逻辑**，也就没有"漏失效"这个坑。
     * 这是把判定实验里那 42% 的"逐条重算指纹"（0.0249 ms/条）干掉的那一刀。
     */
    contentFpOf(doc: ContainerEntryFile): string;
    /** 内部：不走语料缓存地读一条（供 corpus() 构建时使用，避免递归） */
    private readEntryUncached;
    /**
     * 从既有 id 生成下一个可用 id（同层前缀序号 +1），不修改任何状态。
     *
     * 【P0 修复 · 2026-10-19】序号必须同时避开**盘上的孤儿文件**：
     * 修前只按索引算 ⇒ `addEntryFile` 先写文件、后登记索引，崩在中间就留下
     * `longterm/l02.md`（不在索引里）；下次 nextSeq 仍给 l02 ⇒ addEntryFile 撞
     * 「条目文件已存在，拒绝覆盖」⇒ **此后再也写不进 longterm**（旧审核 24-4 升级）。
     * 现在把该层目录里已存在的 `<前缀><数字>.md` 也计入上限 —— 孤儿仍在，但不再阻断写入。
     */
    nextEntryId(layer: ContainerEntry['layer']): string;
    /**
     * 构造并原子写入一个新条目文件，同时登记内存索引。
     * 只做「路径解析 + 序列化 + 落盘 + 登记」，不做任何业务判断；业务规则在 writer。
     */
    /** 【P0-6】回填/刷新派生字段（只改索引，不碰文件） */
    stampSessionDerived(id: string, has: boolean, kind: 'host' | 'legacy_literal' | 'placeholder' | 'absent'): boolean;
    addEntryFile(input: NewEntryFile): ContainerEntry;
    /** 用最新 frontmatter 同步内存索引条目元信息（供 update/forget 之后调用） */
    syncEntryMeta(id: string, patch: Partial<ContainerEntry>): void;
    /** 从内存索引移除条目（purge 用；默认墓碑路径不调用它） */
    removeEntryMeta(id: string): boolean;
    /** 重算 entry_count（写后自检用） */
    recountEntries(): number;
    /** index.json 中登记的总条目数（含 pending） */
    totalEntries(): number;
    /**
     * hot_order 槽位迁移（memory_update 专用，三条判定见 TechDoc §7）：
     *   a. old ∈ hot 且 new 满足常驻 → new 原位继承旧槽位，删除 old
     *   b. old ∈ hot 但 new 不满足常驻 → 两版一并剔除
     *   c. old ∉ hot → 不触碰
     * 返回迁移快照，供调用方写日志。
     */
    migrateHotSlot(oldId: string, newId: string, newQualifies: boolean): HotOrderSnapshot;
    /** 把 id 追加进 hot_order（opinion 直写路径与候选转正路径共用；已存在则原位保留） */
    appendHotOrder(id: string): HotOrderSnapshot;
    /** 从 hot_order 物理剔除（forget 与 discard 必须调用，不能只靠 temporal 过滤） */
    removeFromHotOrder(id: string): HotOrderSnapshot;
    /** hot_order 指针一致性快照（P1 出口条件：必须为空） */
    hotOrderConsistency(): {
        ok: boolean;
        problems: string[];
    };
    /** 解析 YAML frontmatter（最小实现：只处理标量/数组/注释，不引第三方 YAML 依赖） */
    /**
     * 解析 frontmatter。
     *
     * 【V1.3-A · G1】**返回两份视图，别混用**：
     *   · `frontmatter`：**消费方视图**，已按契约补默认值（`scope` 缺省→`global`、
     *     `hot_mode` 缺省→`full`、`priority` 缺省→`50`…）。读侧用它。
     *   · `raw`：**原始键值**，文件里写了什么就是什么。**双真源对账只能用它** ——
     *     拿补过默认的视图去比索引，等于让解析器给自己的默认值背锅（实测：测试桩里
     *     文件没写 `scope`，却被判成"文件有、索引没有"的假漂移）。
     */
    private parseFrontmatter;
    /** `out`（原始键值）→ 契约类型。**默认值只在这里补**，⛔ 不往 `raw` 里写。 */
    private narrowFrontmatter;
    /**
     * 更新单条条目：合并 patch 到 frontmatter + 正文，原子写回条目文件，
     * 并同步更新内存中的 index（不落盘 index.json——saveIndex 负责落盘）。
     * 只改 patch 中出现的字段；不存在的 id 返回 false。
     */
    updateEntry(id: string, patch: EntryPatch): boolean;
    /**
     * 更新条目并同步索引；任一步失败都尽力恢复条目、索引文件和内存索引。
     * API 使用此入口，避免“条目已改但 index.json 未更新”的半完成状态。
     */
    /**
     * 字段级编辑 + 落盘。
     *
     * 🔴 **不要从 HTTP / 工具入口直接调它**（2026-09-15 收尾轮血的教训）：
     * 本方法**不取跨进程写锁、也不重读索引**。若调用方手里是启动时加载的旧索引，
     * 它会把这整份旧索引落盘，**静默抹掉别的通道（CLI / 另一个实例）刚写的条目**，
     * 并让索引指向已被移走的文件 → 下次启动 fail-fast。
     * 实测复现见 `test/write.test.mjs` 的「edit 必须持锁并重读索引」回归项。
     *
     * **外部调用一律走 `MemoryWriter.edit()`**——它包了事务（写锁 + 持锁后重读索引）。
     * 本方法保留为 writer 的**事务内实现细节**，也是无 writer 的只读装配下的兜底。
     */
    updateEntryAndSaveIndex(id: string, patch: EntryPatch): boolean;
    /**
     * 把当前内存 index 落盘为 index.json（原子写）。
     * 调用方（插件 API）在完成一组写入后调用；不自动触发。
     *
     * 2026-10-07 起：写前做一次乐观锁检查（见 `indexStamp` 那段注释）——
     * 磁盘索引若被外部改过，**先三路合并再写**，否则外部修正会被这次写整片抹掉。
     */
    saveIndex(): void;
    /** 【L-5】整份快照落盘（把日志折平、清零脏集合） */
    private writeSnapshot;
    /** 【L-5】把"这次动过的条目"追加成一行日志（写一次 ≈ 常数，与库大小无关） */
    private appendDelta;
    /**
     * 【L-5】重放增量日志：快照 + 日志 = 当前索引。
     * 基线哈希对不上（快照被别的通道改写过）⇒ **整份作废**，只信快照，并留痕。
     * 返回重放的记录数（-1 表示作废过）。
     */
    private replayDeltaLog;
    private readIndexFileQuiet;
    /** 序列化条目文件：frontmatter + 正文（字段顺序固定，缺失字段不输出） */
    serializeEntryFile(fm: EntryFrontmatter, content: string): string;
    /**
     * 【S1 · P0-2 第二道闸】序列化 → 往返自检 → 落盘 → 回读核对。
     *
     * 为什么不能只靠"引号规则写对了"：那是推理，不是证据。
     * 序列化器与解析器是一对白名单，两边只要有一处不同步，表现就是
     * **写的时候不报错、重启才炸**——P0-2 就是这么漏了整整一个版本。
     *
     * 三道检查，缺一不可：
     *   ① **落盘前**在内存里做一次 serialize → parse 往返，核对 `id` / `layer`。
     *      不一致就抛错，此时**盘上还没有任何改动**，事务回滚成本为零。
     *   ② 落盘（atomicWrite：临时文件 + rename，单文件原子）。
     *   ③ **落盘后**把文件读回来再解析一次，核对 `id` / `layer`。
     *      这一步抓的是磁盘层（截断 / 编码 / 写了一半）——① 抓不到它。
     *
     * 代价：一次字符串 parse（内存）＋ 一次小文件读盘，都发生在写事务内，
     * 不在热检索路径上；2026-10-03 微基准里"非 load 部分"本就只占 6.98ms。
     */
    private writeEntryFileVerified;
    /**
     * 只替换允许编辑的 frontmatter 字段，保留未知字段、注释及原有字段顺序。
     * 新值用 JSON 表示（JSON 标量/数组是 YAML 的合法子集），避免特殊字符破坏结构。
     */
    private patchEntryFile;
    /** 原子写：先写临时文件再 rename，避免半写状态 */
    atomicWrite(filePath: string, content: string): void;
}
