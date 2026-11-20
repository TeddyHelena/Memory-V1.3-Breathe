/**
 * writer.ts —— V1.0 的唯一新增写出口（TechDesign §2 硬约束）
 *
 * 职责：把「写入/纠正/删除/候选/转正」的业务规则封装成事务；底层原子写原语复用 container。
 * 不在 container 内新增 create/delete 事务，也不在 index.ts / api.ts / CLI 里另写旁路写逻辑。
 *
 * 事务纪律（TechDesign §4.1）：
 *   条目文件 + index.json 联合提交；任一步失败则双回滚（新文件按原样删除或按旧内容恢复，
 *   index.json 按原文恢复，内存索引回到调用前快照）。entry_count 写后自检。
 *
 * 口径诚实（PRD §4.2）：
 *   本文件的「通道一致性校验」是**结构性约束**（operation 与目标层是否自洽），属软层的一部分；
 *   「推断/情绪 → 只能进 pending」这一语义判定由工具契约与模型自觉承担。
 *   任何注释、README、对外表述均不得写成「物理防污染」或「硬闸门」。
 */
import { type MemoryContainer } from './container.js';
import { type SessionBuffer } from './session-buffer.js';
import type { ContainerEntry, WriteOutcome, WriteRecord } from './types.js';
/** 墓碑标题前缀 */
export declare const TOMBSTONE_TITLE_PREFIX = "[\u5DF2\u9057\u5FD8]";
/**
 * 墓碑标题：中性身份标识，**不含任何来自原文的内容**（审计 P1-8 · 作者 2026-10-06 拍板）。
 *
 * 为什么必须换掉：标题兜底取自正文前 40 字 —— **它本来就是内容**。
 * 只抹正文和摘要、留着标题，"隐私删除"就名不副实。
 * （与上面 TOMBSTONE_SUMMARY 是同一个理由 —— 2026-10-06 审计指出那次只修了一半。）
 *
 * 口径：墓碑**保留 title 字段**（审计链靠它认出"这是哪个条目"，断成裸 id 就失去意义），
 * 但保留的是**可识别性**，不是"它讲过什么"。值统一换成中性标识。
 *
 * **系统不做"这个标题敏不敏感"的语义判断**（延续 2026-09-15 纪律：让阈值判断敏感与否，
 * 两边都会错）。规则统一，不靠概率。
 */
export declare function tombstoneTitle(id: string, at: string): string;
/** writer 构造参数 */
export interface WriterOptions {
    /** 写入主体标识（落库到条目 frontmatter 的 operator 字段） */
    operator?: string;
    /** 是否允许物理删除；默认 false，仅墓碑 */
    allowPurge?: boolean;
    /**
     * 跨进程写入锁开关（P2）。默认开：多个 DSH 实例同时写同一容器会互相覆盖。
     * 关掉只应出现在「明确知道只有一个写入者」的测试场景。
     */
    useWriteLock?: boolean;
    /** 锁心跳超时（毫秒），默认 60s；超时视为陈旧锁可接管 */
    lockStaleMs?: number;
    /**
     * 锁有界短重试（压测评审 §1.4 四边界）。
     * 默认 3 次 / 200ms：吸收"恰好撞上"的瞬时冲突；真竞争仍会报 LOCK_BUSY。
     * 边界④（重试成功后必须重读索引）由 runTransaction 的 container.load() 保证——
     * **重试与重读必须配对**，否则等于用一个补丁踩另一个补丁的坑。
     */
    lockRetry?: {
        attempts?: number;
        budgetMs?: number;
    };
    /**
     * 会话原话缓冲（P2）：传入即启用「写入必须有用户原话依据」的机械校验。
     * 不传则退化为纯模型判据（软层）——**该开关是「软 vs 硬」的分界线**。
     */
    sessionBuffer?: SessionBuffer;
    /** 最小引用长度（去标点后连续字符数），默认 6；太小会误放行，太大会误拒 */
    minQuote?: number;
    /** 校验模式：'enforce' 拒绝无依据的直写（硬）；'warn' 只记日志（软）。默认 'enforce' */
    quoteMode?: 'enforce' | 'warn';
    /** 写入成功后的回调（插件用它清装配缓存） */
    onWrite?: (info: {
        id: string;
        operation: string;
    }) => void;
    /** 日志注入（插件传 ctx.logger） */
    log?: {
        info: (message: string) => void;
        warn: (message: string) => void;
        error: (message: string) => void;
    };
}
/**
 * 写入回执（P0-3a 观测口）：**随写入事务一起提交**。
 *
 * 修前（2026-10-18 审计 P1）：回执在事务**外** append、失败只 logger.error，工具仍回 ok:true
 * ⇒ "分母丢了但账面全绿"。现在回执是事务体的一部分：append 失败 ⇒ 整个写回滚 ⇒ 工具回 ok:false。
 */
export interface ReceiptStamp {
    sessionId: string;
    /** 会话 id 的来源：agent=宿主给的 / fallback=进程级回落 / none=取不到 */
    idSource: string;
    /** 操作类型（memory_forget 等）；purge 回执必须能归因 */
    op?: string;
    /** 操作者（assistant / 人工 CLI / 测试） */
    operator?: string;
    /** 删除/修改原因（purge 必须带） */
    reason?: string;
}
/** 工具层入参（模型可见的部分；来源字段留空即拒绝） */
export interface RememberInput {
    content: string;
    title: string;
    memory_type: WriteRecord['memory_type'];
    tags?: string[];
    priority?: number;
    scope?: WriteRecord['scope'];
    scope_id?: string;
    valid_from?: string;
    valid_to?: string;
    source_session: string;
    source_message: string;
    /** 【P2】次事 subject（只记录） */
    about?: string[];
    summary?: string;
    /**
     * 衰减类型（可选）。V1.2 接线（2026-10-03）：缺省按 operation 推定，
     * `core` 只能显式指定；非法值 fail-closed 拒写（不猜、不修正）。
     */
    decay_type?: string;
}
/**
 * 标题单行化（2026-10-19 · s7 标题换行注入修复）：
 * 标题是**元数据**，不允许带控制字符。换行/制表/控制字符一律压成空格，再折叠空白。
 * 渲染侧另有一道同样的压平（persona.ts），双保险。
 */
export declare function normalizeTitle(title: string): string;
export declare class MemoryWriter {
    private readonly container;
    private readonly operator;
    private readonly allowPurge;
    private readonly onWrite?;
    private readonly log;
    private readonly useWriteLock;
    private readonly lockStaleMs;
    private readonly lockRetry;
    private readonly sessionBuffer?;
    private readonly minQuote;
    private readonly quoteMode;
    /** 事务重入标记：update/confirm 内部已开事务时，外层不再重复快照 */
    private inTransaction;
    /**
     * 事务内**被改写过的已有文件**的原始内容快照（relPath → 原文）。
     *
     * 为什么需要它：原回滚只做两件事——删掉本次新增的文件、还原 index.json 与内存索引。
     * 它**完全不管被改写的已有文件**。后果实测（2026-09-15 收尾轮，p3 探针）：
     * `update` 已把旧版本文件写成 `status: superseded`，随后 index 落盘失败 → 回滚 →
     * 索引说旧版 `active`、文件说 `superseded`；`/list` 显示在、检索里**静默消失**。
     * 这种「索引与文件说两套话」比直接报错危险得多——没人会去看文件头。
     */
    private touchedFiles;
    /**
     * 本次事务里**移动过**的文件：目标相对路径 → 原始相对路径（B2 修复，2026-09-30）。
     *
     * 为什么必须有它：回滚第②步原按「文件不在事务前集合里」判新增——
     * 而 `moveEntryFile` 走的是 `renameSync`，**移动也满足该判据**。
     * 于是回滚会把刚转正的文件 `unlink` 掉，索引（已还原成事务前快照）却指向
     * 那个原始路径（pending/xxx.md）⇒ 文件没了、索引还在 ⇒ 下次启动撞 fail-fast。
     *
     * 修法：把「移动」与「新增」分开记账。
     * 回滚时前者**搬回去**，后者才 `unlink`。
     */
    private movedFiles;
    /**
     * 本次事务里**暂存删除**的文件：trash 绝对路径 → 原绝对路径（purge 专用，2026-10-19）。
     *
     * 为什么不能直接 unlink：purge 的文件**不在** `touchedFiles`（不写回原文件）也不在
     * `movedFiles`（不回滚搬回）⇒ 事务后置步骤失败（如回执写不进去）时，索引被还原成
     * "purge 前"，文件却已经没了 ⇒ 下次 load fail-fast，容器直接 brick。
     * 现在先 rename 进 `.purge-trash/`（原子、可回滚），提交成功后才真正删除。
     */
    private stagedDeletes;
    constructor(container: MemoryContainer, options?: WriterOptions);
    /**
     * memory_remember：用户明说的偏好/事实 → 正式记忆（longterm）
     *
     * 必须在事务里：条目文件先写、index.json 后写，落盘失败要双回滚。
     * （曾经漏了这一层：文件写了而索引没落盘，留下「索引看不见的孤儿文件」，
     *   下一次启动就会撞上 pending/index 一致性硬检查。）
     */
    /**
     * 按需快照：某个已有文件**即将被改写前**记下它的原文，供回滚还原。
     * 只记这一次、只记这一个文件——不预读全容器（那是 86ms 的代价）。
     * 幂等：同一文件在一次事务内被改多次，只保留**最早那份**原文。
     */
    private snapshotIfExists;
    /**
     * 【Ledger · L-2/L-3 家族】在**写事务里**跑一段容器级改动（拿写锁 + 持锁后重读索引）。
     *
     * 为什么要开这个口子：插件里有一条**从不拿锁**的落盘路径——注入装配时每 ≥30s
     * `router.flushTouch()`（把路由 touch 的 last_accessed/access_count 批量落盘，末尾 `saveIndex()`）。
     * 它没出过事，是因为 10-07 的三路合并兜底（磁盘变了就合并、不整片覆盖）；
     * 但"读磁盘 → 合并 → 写"这三步之间**没有互斥**，是典型的 check-then-act 竞态：
     * 另一实例恰在这中间落盘，就会被这次写入抹掉。
     * 这是 09-14 / 09-15 两次事故的同一根因，在**第三个入口**上的残留（前两个入口当时都补过）。
     *
     * 语义：拿锁 → 重读索引 → 跑 work（work 内部自己 saveIndex）→ 释放锁；失败按 transaction 既有语义回滚。
     * ⛔ 只给"改容器但不产生 WriteOutcome"的内部路径用；业务写入请用 remember/update/... 。
     */
    withWriteTransaction<T>(work: () => T): T;
    /**
     * 字段级编辑（设置页 PUT 走这条）。
     *
     * **为什么必须经过这里**：设置页的 PUT 原本直接调 `container.updateEntryAndSaveIndex()`，
     * 那是一条**绕过写入锁、也不重读索引**的旁路。实测后果（2026-09-15 收尾轮复现）：
     *   CLI 在磁盘上加了 l02 → 设置页 PUT 一条标题 → 内存里的旧索引整份落盘，
     *   **l02 被静默抹掉、p01 复活，索引指向已移走的文件 → 重启即 fail-fast。**
     * 这正是 09-14 事故的同一根因——当时修复只覆盖了 writer 工具路径，**漏了设置页 PUT**，
     * 于是同一个坑以另一个入口又踩了一次。
     *
     * 走 `transaction()` 就同时拿到两样东西：跨进程写锁 + 持锁后重读索引（边界④）。
     */
    /** 人工提及：把 last_accessed/access_count 当作一次真实读取落盘（不是只改本地 UI）。 */
    activate(id: string): WriteOutcome;
    edit(id: string, patch: Record<string, unknown>): WriteOutcome;
    remember(input: RememberInput, receipt?: ReceiptStamp): WriteOutcome;
    /** memory_update：纠正既有记忆（写新版本，旧版保留并标 superseded） */
    update(id: string, patch: {
        content?: string;
        title?: string;
        tags?: string[];
        reason: string;
        valid_from?: string;
        valid_to?: string;
        source_session: string;
        source_message: string;
        about?: string[];
    }, receipt?: ReceiptStamp): WriteOutcome;
    /** memory_forget：撤销当前有效记忆（默认墓碑；purge 需显式开启） */
    forget(id: string, options: {
        reason: string;
        mode?: 'tombstone' | 'purge';
        source_session: string;
        source_message: string;
    }, receipt?: ReceiptStamp): WriteOutcome;
    /**
     * 收集一条记忆的**版本血脉**（含自身）。
     *
     * ── 为什么必须有它 ────────────────────────────────────────────────
     * `update` 不物理删除旧版：只把它标 `superseded` 并写 `superseded_by`；
     * 新版把整条历史记在 `supersedes` 数组里（线性链）。
     * 于是 `forget` 若只处理传入的那个 id，**被纠正过的记忆的历史版本会原样留下**
     * —— 标题、摘要、正文都在（索引与条目文件里都能读到）。
     * 实测：remember → update → forget 新版 ⇒ 旧版 l67 全文可读，"忘掉"是假的。
     *
     * 审计报告自己写着「本项实际验证的是标题残留，**没有验证所有历史版本的擦除行为**」；
     * 2026-10-06 把这个验证补上 —— 结论是它确实是漏的。
     *
     * ── 口径（作者 2026-10-06 拍板 (a)）────────────────────────────────
     * **忘掉就整条血脉一起抹**：结构保留（id / 时间 / operator / reason / 链关系 / version），
     * 内容与标题抹掉。代价是**回退能力消失**，这是刻意认下的：
     * 隐私删除的语义是"这条内容不许再存在"；而"历史可回退"服务的是审计，
     * 审计要的是"谁在何时改了什么"，不是"原文还在"——两边不冲突。
     *
     * 双向都走：向后取 `supersedes`（祖先），向前取 `superseded_by`（后继）。
     * 之所以双向都要，是因为调用方可能传进来的不是最新版。
     */
    private collectVersionLineage;
    /** memory_propose：模型推断/总结/情绪 → 候选区（物理上无转正通道） */
    propose(input: RememberInput, receipt?: ReceiptStamp): WriteOutcome;
    /** 候选转正：pending → 目标层（默认 longterm），写 confirmed_at/by 留痕 */
    confirm(id: string, options?: {
        targetLayer?: ContainerEntry['layer'];
        operator?: string;
    }): WriteOutcome;
    /** 自动转正回滚：longterm → pending，清 confirmed 留痕；只允许 auto 批次调用。 */
    unconfirm(id: string, options?: {
        operator?: string;
        reason?: string;
    }): WriteOutcome;
    /**
     * **层迁移**（hot ⇄ longterm ⇄ archive）—— 生命周期审稿点名的缺口：
     * 「hot↔longterm↔archive **三向没有任何迁移函数**，可执行的只有 pending→longterm」。
     *
     * 与 `confirm` 的区别：那是"候选转正"（pending → 目标层 + 置 active）；
     * 这是**平级换层**（已经在用的条目换个存放层），⛔ 不改 status、⛔ 不改内容。
     *
     * 纪律（与既有写路径一致）：
     *   · 走 `runTransaction` + `finishIndex()`，不手改容器；
     *   · 文件**只换目录不换名**（复用 `moveEntryFile`，与 P1-8 的结论一致）；
     *   · `layer` 必须**同时**写进文件头与索引（只改一边，下次加载会撞一致性校验）；
     *   · 迁进/迁出 hot 层时**同步 `hot_order`**：迁出即从名单剔除（否则名单里留着一个不在 hot 层的常驻条目）。
     */
    relocate(id: string, targetLayer: ContainerEntry['layer'], options?: {
        operator?: string;
        reason?: string;
    }): WriteOutcome;
    /** 候选丢弃：写墓碑 + 物理剔出 hot_order（若有） */
    discard(id: string, options?: {
        operator?: string;
        tombstoneLayer?: ContainerEntry['layer'];
    }): WriteOutcome;
    /** 列出候选（CLI / 设置页共用） */
    listPending(): Array<{
        id: string;
        title: string;
        memory_type?: string;
        created?: string;
        file: string;
    }>;
    /**
     * 原文比对（P2）：确认这次直写能指到用户原话。
     *
     * 三种情形：
     *   ① 未注入 sessionBuffer → 不做校验（保持旧行为，纯软层）
     *   ② 会话缓冲为空（例如 CLI/无会话上下文）→ 不做校验（否则会把 CLI 写入全拒掉）
     *   ③ 有缓冲但找不到引用 → enforce 拒绝（改走 propose）/ warn 仅记日志
     */
    private assertUserQuote;
    private buildRecord;
    /** 新建条目（可延迟落盘索引，供 update 事务内合并提交） */
    private createEntry;
    /**
     * 写回既有条目文件，**并把 frontmatter 的变更同步进内存索引**。
     * 不同步的后果是真实踩过的坑：文件里 status=superseded，index.json 里却还是 active——
     * 导致 hot_order 一致性校验看不见废弃条目、UI 与检索各读一半。
     */
    private writeEntryFile;
    /** pending → 目标层：把文件从 pending/ 移到目标层目录 */
    private moveEntryFile;
    private entryPath;
    /** 受保护条目：系统机制文件不可删 */
    private assertNotProtected;
    /**
     * 衰减类型解析（ingest.classifyDecayType 的**唯一调用点**，V1.2 接线 2026-10-03）。
     *
     * 为什么在这里翻译错误类型：ingest 是纯函数模块，抛 `IngestError`；
     * writer 的契约是抛 `WriteError`（工具层据此返回结构化失败，而不是把栈甩给模型）。
     * 没这一步，非法值会以"系统错误"的形态冒出去，看起来像 bug 而不是参数问题。
     */
    private resolveDecayType;
    /**
     * 判重候选集（ingest.findDuplicate 的**唯一调用点**的数据源）。
     *
     * 两条过滤规则，都是为了不制造新的坑：
     *   ① **非 active 不参与**：superseded / expired / 墓碑条目已经被否定了，
     *      拿它们挡新写入 = 用一条被撤销的旧事实否决新事实。
     *   ② **通道隔离**：remember 不看 pending。否则"内容撞上候选区里的推断"
     *      会把正式记忆**吸进候选区**（它本该直接落库），等于用判重制造了通道错位。
     *      propose 反向不受限：候选撞上已确认的长期记忆，本来就该记 access 而不是再提一条。
     */
    /**
     * 判重候选集 —— 【S2 追刀】改成**只取命中桶**，不再全量扫 n 条。
     *
     * 原来：把全部 n 条候选重建成数组，`findDuplicate` 再线性扫一遍 ⇒ 每次写入 O(n) 分配 + O(n) 扫描。
     * 现在：先问容器要两张索引（`dupIndex()`：指纹 → id[]、标题+decay → id[]），
     *       **只把两道判据可能命中的那几条**取出来送进 `findDuplicate`（通常 0–2 条）。
     *
     * 两道过滤规则原样保留（都是为了不制造新的坑）：
     *   ① **非 active 不参与**：superseded / expired / 墓碑条目已经被否定了，
     *      拿它们挡新写入 = 用一条被撤销的旧事实否决新事实。
     *   ② **通道隔离**：remember 不看 pending。否则"内容撞上候选区里的推断"
     *      会把正式记忆**吸进候选区**，等于用判重制造了通道错位。
     *      propose 反向不受限：候选撞上已确认的长期记忆，本来就该记 access 而不是再提一条。
     *
     * ⚠️ **作用域不在这里过滤**（S2 · P1-5）：跨 scope 撞同文要回一条提示，
     *    那需要"看得见但不算命中"，所以过滤挪进 `findDuplicate`（同一性判据 `sameScope`）。
     */
    private collectDupCandidates;
    /** 判重（只读，不改状态）。确定性重复才命中，模糊相似留待标定（见 ingest.findDuplicate 注释） */
    private findDuplicateFor;
    /**
     * 判重吸收：**不新建条目**，改写既有条目的 `last_accessed` / `access_count`。
     *
     * 口径（刻意保守，2026-10-03）：
     *   · 只有**内容指纹精确命中**才走这里（归一化后逐字相同 = 同一句话，零语义风险）。
     *   · 标题撞车**不在这里合并** —— 标题是人为短标签，误撞概率高，
     *     而"把两件事合成一件"是不可逆的语义损失（ingest.ts 的原话）。
     *     标题撞车只回一条 `title_collision` 提示，让调用方自己决定（见 types.ts）。
     */
    private absorbDuplicate;
    /** 写后自检 + 落盘索引 */
    private finishIndex;
    /** 把文件**原子地**暂存进 trash（purge 用；提交成功后由 commitStagedDeletes 真删） */
    private stageUnlink;
    /**
     * 提交成功后真正删除暂存文件。返回**删不掉的目录**（空 = 全清）。
     * ⛔ 不回滚：此时索引已提交；但调用方必须拿到 leftover（否则“物理删除”假成功）。
     */
    private commitStagedDeletes;
    /** 事务回滚：把暂存删除的文件搬回原处。返回**搬不回去**的路径（空 = 全恢复） */
    private restoreStagedDeletes;
    /** 事务内的回执行（失败即抛，由 transaction 负责回滚） */
    private appendReceipt;
    /**
     * 事务包装：失败时恢复 index.json 原文与内存索引快照，并把已写的新文件归还磁盘状态。
     * 注意：调用方需保证本次事务内「新增的文件路径」可从索引差集推导——因此快照同时记录 entries。
     */
    private transaction;
    /** 真正的事务体（已持锁） */
    private runTransaction;
}
/**
 * 【purge 崩溃恢复 · 2026-10-19】启动时对账 `.purge-trash`：
 *  · 索引还列着该条目、原路径缺文件 ⇒ 从 trash 搬回（崩在提交前 / 回滚没做完）
 *  · 索引已不列该条目 ⇒ 这是已提交的 purge，删掉 trash（完成真正删除）
 *  · 索引读不出来 ⇒ 什么都不删（fail-safe，不拿未知正文冒险）
 *
 * ⛔ 只处理“≥30s 没动过”的暂存目录：避免把另一个还活着的进程正在执行的 purge 当残留。
 * ⛔ 只认 `<id>.md` + sidecar `meta.json`；认不出的文件只跳过并报出来，不猜。
 */
export interface PurgeReconcileResult {
    restored: string[];
    deleted: string[];
    skipped: string[];
}
export declare function reconcilePurgeTrash(root: string, log?: {
    info?: (m: string) => void;
    warn?: (m: string) => void;
    error?: (m: string) => void;
}): PurgeReconcileResult;
