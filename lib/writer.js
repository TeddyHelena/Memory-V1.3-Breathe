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
import * as fs from 'node:fs';
import * as path from 'node:path';
import { dupTitleKey } from './container.js';
import { ERR, WriteError, assertChannelConsistency, assertSource, assertWritable, confirmFields, computeIdemKey, discardFields, nextVersion, nowIso, relocateFields, tombstoneFields, today, } from './idem.js';
import { IngestError, classifyDecayType, contentFingerprint, findDuplicate, initDecayFields, touchFields, } from './ingest.js';
import { computeChecksum } from './checksum.js';
import { acquireWriteLock } from './lock.js';
import { findQuote } from './session-buffer.js';
import { isCurrentMemory, memoryScope, temporalState } from './policy.js';
/**
 * 墓碑条目写入的正文占位（**不含任何原文**）。
 * 安全专项 §五-4：墓碑=仅元数据。留一句人类可读的说明，便于人工翻到文件时知道发生了什么。
 */
const TOMBSTONE_BODY = '（此条已按隐私删除处理：墓碑仅保留元数据，正文未保留。）';
/** 墓碑摘要占位：摘要默认取自正文，不清掉就等于留着原文 */
const TOMBSTONE_SUMMARY = '（已删除：仅保留元数据）';
/** 墓碑标题前缀 */
export const TOMBSTONE_TITLE_PREFIX = '[已遗忘]';
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
export function tombstoneTitle(id, at) {
    return `${TOMBSTONE_TITLE_PREFIX} ${String(at).slice(0, 10)} ${id}`;
}
/**
 * 标题单行化（2026-10-19 · s7 标题换行注入修复）：
 * 标题是**元数据**，不允许带控制字符。换行/制表/控制字符一律压成空格，再折叠空白。
 * 渲染侧另有一道同样的压平（persona.ts），双保险。
 */
export function normalizeTitle(title) {
    return String(title).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}
/** 按 **码点** 截断（`slice(0,80)` 会把 emoji 切成孤立代理项） */
function truncateCodePoints(text, max) {
    const chars = Array.from(text);
    return chars.length <= max ? text : chars.slice(0, max).join('');
}
export class MemoryWriter {
    container;
    operator;
    allowPurge;
    onWrite;
    log;
    useWriteLock;
    lockStaleMs;
    lockRetry;
    sessionBuffer;
    minQuote;
    quoteMode;
    /** 事务重入标记：update/confirm 内部已开事务时，外层不再重复快照 */
    inTransaction = false;
    /**
     * 事务内**被改写过的已有文件**的原始内容快照（relPath → 原文）。
     *
     * 为什么需要它：原回滚只做两件事——删掉本次新增的文件、还原 index.json 与内存索引。
     * 它**完全不管被改写的已有文件**。后果实测（2026-09-15 收尾轮，p3 探针）：
     * `update` 已把旧版本文件写成 `status: superseded`，随后 index 落盘失败 → 回滚 →
     * 索引说旧版 `active`、文件说 `superseded`；`/list` 显示在、检索里**静默消失**。
     * 这种「索引与文件说两套话」比直接报错危险得多——没人会去看文件头。
     */
    touchedFiles = new Map();
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
    movedFiles = new Map();
    /**
     * 本次事务里**暂存删除**的文件：trash 绝对路径 → 原绝对路径（purge 专用，2026-10-19）。
     *
     * 为什么不能直接 unlink：purge 的文件**不在** `touchedFiles`（不写回原文件）也不在
     * `movedFiles`（不回滚搬回）⇒ 事务后置步骤失败（如回执写不进去）时，索引被还原成
     * "purge 前"，文件却已经没了 ⇒ 下次 load fail-fast，容器直接 brick。
     * 现在先 rename 进 `.purge-trash/`（原子、可回滚），提交成功后才真正删除。
     */
    stagedDeletes = new Map();
    constructor(container, options = {}) {
        this.container = container;
        this.operator = options.operator ?? 'assistant';
        this.allowPurge = options.allowPurge ?? false;
        this.onWrite = options.onWrite;
        this.log =
            options.log ??
                { info: () => { }, warn: () => { }, error: () => { } };
        this.useWriteLock = options.useWriteLock ?? true;
        this.lockStaleMs = options.lockStaleMs ?? 60_000;
        this.lockRetry = {
            attempts: options.lockRetry?.attempts ?? 3,
            budgetMs: options.lockRetry?.budgetMs ?? 200,
        };
        this.sessionBuffer = options.sessionBuffer;
        this.minQuote = options.minQuote ?? 6;
        this.quoteMode = options.quoteMode ?? 'enforce';
    }
    // ────────────────────────────────────────────────────────────
    // 公开操作
    // ────────────────────────────────────────────────────────────
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
    snapshotIfExists(relPath) {
        if (this.touchedFiles.has(relPath))
            return;
        try {
            const filePath = this.container.resolvePath(relPath);
            if (fs.existsSync(filePath))
                this.touchedFiles.set(relPath, fs.readFileSync(filePath, 'utf-8'));
        }
        catch {
            // 读不到就不记：回滚时跳过，不因快照失败拖垮事务
        }
    }
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
    withWriteTransaction(work) {
        return this.transaction(work);
    }
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
    activate(id) {
        return this.transaction(() => {
            const meta = this.container.entryMeta(id);
            if (!meta)
                throw new WriteError(ERR.ENTRY_NOT_FOUND, `条目不存在: ${id}`);
            const before = Number(meta.access_count) || 0;
            const next = touchFields({ access_count: before }, nowIso());
            this.container.stampV12Fields(id, next, { saveIndex: false });
            this.finishIndex();
            return { ok: true, id };
        });
    }
    edit(id, patch) {
        // 【标题单行化】设置页 PUT 也是标题入口，不能只堵工具路径
        if (typeof patch.title === 'string')
            patch = { ...patch, title: normalizeTitle(patch.title) };
        return this.transaction(() => {
            const updated = this.container.updateEntryAndSaveIndex(id, patch);
            if (!updated)
                throw new WriteError(ERR.ENTRY_NOT_FOUND, `条目不存在: ${id}`);
            return { ok: true, id };
        });
    }
    remember(input, receipt) {
        const record = this.buildRecord('remember', 'longterm', input);
        // P2 原文比对：直写必须能指到用户真正说过的片段。
        // 这是把「用户明说」从模型自觉（软）拧成机械可验证（硬）的那一刀。
        this.assertUserQuote(record.content, input.source_session);
        return this.transaction(() => {
            // 判重必须在事务内（持锁 + 索引已重读）—— 锁外查重 = 两个写入者同时通过检查
            // P0-4：source_message=0（无真人消息锚点）⇒ 不参与幂等（0 是哨兵值，可机械判定）
            const dup = record.source_message === '0' ? null : this.findDuplicateFor(record);
            if (dup?.via === 'content')
                return this.absorbDuplicate(dup.hit.id);
            const outcome = this.createEntry(record);
            if (dup?.via === 'title')
                outcome.title_collision = { id: dup.hit.id, title: dup.hit.title };
            if (dup?.via === 'content_other_scope') {
                // 【S2 · P1-5】跨 scope 撞同文：**不合并**（作者 2026-10-08 拍板），
                // 只回提示；⛔ 不去碰对方条目的任何字段（访问计数也不动）。
                outcome.scope_collision = {
                    id: dup.hit.id,
                    scope: dup.hit.scope ?? 'global',
                    ...(dup.hit.scope_id ? { scope_id: dup.hit.scope_id } : {}),
                };
            }
            // 硬约束（TD §5.1）：opinion 自动进 hot_order；experience/world 不进
            if (record.memory_type === 'opinion' && outcome.id) {
                const snapshot = this.container.appendHotOrder(outcome.id);
                this.finishIndex();
                outcome.hot_order = snapshot;
                this.log.info(`opinion 记忆自动常驻: ${outcome.id}（hot_order ${snapshot.before.length} → ${snapshot.after.length}）`);
            }
            return outcome;
        }, receipt ? (out) => this.appendReceipt(receipt, out.id) : undefined);
    }
    /** memory_update：纠正既有记忆（写新版本，旧版保留并标 superseded） */
    update(id, patch, receipt) {
        assertSource(patch);
        const meta = this.container.entryMeta(id);
        if (!meta)
            throw new WriteError(ERR.ENTRY_NOT_FOUND, `条目不存在: ${id}`);
        if (meta.layer === 'pending') {
            throw new WriteError(ERR.INVALID_INPUT, 'pending 候选不可直接 update，请先转正或丢弃');
        }
        // 【写入路径 A 修复 · 2026-10-19】墓碑禁止 update。
        // 修前实测：对已 forget 的 id 调 memory_update ⇒ ok:true，生成一条 `status: active` 的新版
        //（正文=墓碑体、继承 tags/about）⇒ “删掉的记忆”以新 id 复活。
        // 判据用 `deleted_at` + temporalState('expired')：⛔ 不引入第二套“墓碑怎么判”的口径。
        if (meta.deleted_at || temporalState(meta) === 'expired') {
            throw new WriteError(ERR.ENTRY_NOT_FOUND, `条目已被遗忘（墓碑），不允许 update: ${id}`);
        }
        // 事务：新条目 + 旧条目改写 + hot_order 迁移 + index 落盘
        return this.transaction(() => {
            // ── 【Ledger · L-3 修复】旧条目必须在**事务内**重读 ─────────────────
            // 修复前：`readEntry(id)` 在 `transaction()` **之前**执行，是锁外快照。
            // 另一通道在"我们读完 → 我们提交"之间改了正文，我们照样把旧正文写进新版本
            // ⇒ **静默抹掉别人的改动**，而且 mtime 变了、缓存会刷新，看起来就像"本次写入"。
            // 判据（`test/ledger.test.mjs` L-3①，先红后绿）：另一通道先改正文、本次只改标题 → 正文不回退。
            // ⚠️ 同族方法 `confirm` / `discard` 同步处理——"改一半"是本仓反复踩的形态。
            const old = this.container.readEntry(id);
            if (!old)
                throw new WriteError(ERR.ENTRY_NOT_FOUND, `条目不存在: ${id}`);
            // 【并发修复 · 2026-10-19】事务内重读后必须再判“它还是不是当前头”：
            //   修前 4 进程同改一条 ⇒ 3 个 ok、3 个 active 头、0 冲突拒写（s4 实测）。
            //   现在旧版已被别人 supersede ⇒ 明确拒写，不再从旧底座再开一支。
            if (old.frontmatter.status === 'superseded' || old.frontmatter.superseded_by) {
                throw new WriteError(ERR.VERSION_CONFLICT, `条目已被替代（不是当前版本），请基于新版本纠正: ${id}`);
            }
            const title = normalizeTitle(patch.title ?? '') || old.frontmatter.title;
            const content = patch.content?.trim() || old.content;
            const record = {
                title,
                content,
                memory_type: old.frontmatter.memory_type ?? 'world',
                tags: patch.tags ?? old.frontmatter.tags,
                about: patch.about ?? old.frontmatter.about,
                priority: old.frontmatter.priority,
                scope: old.frontmatter.scope ?? 'global',
                scope_id: old.frontmatter.scope_id,
                valid_from: patch.valid_from ?? old.frontmatter.valid_from,
                valid_to: patch.valid_to ?? old.frontmatter.valid_to,
                source_session: patch.source_session,
                source_message: patch.source_message,
                operation: 'update',
                operator: this.operator,
                idem_key: computeIdemKey(patch.source_session, patch.source_message, content),
                // 摘要跟随内容：纠正后摘要若留着旧话，检索结果与设置页会显示与正文不符的旧摘要
                summary: patch.content?.trim() ? truncateCodePoints(content, 80) : old.frontmatter.summary,
                // 新版本固定落 longterm（与 remember 一致）；能否常驻只由 hot_order 决定，与 layer 无关。
                layer: 'longterm',
            };
            assertWritable(record);
            assertChannelConsistency(record.operation, record.layer);
            // 纠正同样要有原话依据（用户说"改成…"才会有这次调用）
            this.assertUserQuote(patch.content ?? old.content, patch.source_session, /* allowOldContent */ patch.content === undefined);
            const version = nextVersion(old.frontmatter.version);
            const supersedes = [...(old.frontmatter.supersedes ?? []), id];
            // 衰减性质继承：纠正一条记忆不该改变它"多快被忘掉"（ingest.classifyDecayType 的规则）
            const created = this.createEntry({ ...record, supersedes, version }, {
                deferIndex: true,
                inheritedDecay: old.frontmatter.decay_type,
            });
            const newId = created.id;
            // 旧条：标 superseded，不物理删除
            this.writeEntryFile(id, {
                ...old.frontmatter,
                status: 'superseded',
                superseded_by: newId,
                updated: today(),
            }, old.content, { contentChanged: false });
            // hot_order 槽位迁移（三条判定）
            // 常驻资格看「是否被 hot_order 收录」，与 layer 无关（layer 表达的是文件归档位置，
            // 注入真相只有 hot_order 一处）。因此这里只判时间状态：生效中且非 stale。
            const newEntry = this.container.readEntry(newId);
            const newState = newEntry ? temporalState(newEntry.frontmatter) : 'expired';
            const newQualifies = isCurrentMemory(newState) && newState !== 'stale';
            const snapshot = this.container.migrateHotSlot(id, newId, newQualifies);
            this.finishIndex();
            this.log.info(`update: ${id} → ${newId} (version ${version}, hot_order ${snapshot.before.length} → ${snapshot.after.length}` +
                (snapshot.removed.length ? `, 剔除 ${snapshot.removed.join(',')}` : '') +
                (snapshot.added.length ? `, 新增 ${snapshot.added.join(',')}` : '') + ')');
            return { ok: true, old_id: id, new_id: newId, version, superseded: true, hot_order: snapshot };
        }, receipt ? (out) => this.appendReceipt(receipt, out.new_id ?? out.old_id) : undefined);
    }
    /** memory_forget：撤销当前有效记忆（默认墓碑；purge 需显式开启） */
    forget(id, options, receipt) {
        assertSource(options);
        const mode = options.mode ?? 'tombstone';
        if (mode === 'purge' && !this.allowPurge) {
            throw new WriteError(ERR.PURGE_DISABLED, '物理删除未授权（allowPurge=false），请使用墓碑模式');
        }
        const entry = this.container.readEntry(id);
        const meta = this.container.entryMeta(id);
        if (!entry || !meta)
            throw new WriteError(ERR.ENTRY_NOT_FOUND, `条目不存在: ${id}`);
        this.assertNotProtected(meta);
        // 【L-5】隐私删除必须让**整个索引快照**重写：墓碑的脱敏投影若只进增量日志，
        // index.json 里就还留着原文（等于"隐私删除"名不副实）。判据见 test #138/#139/#140。
        this.container.forceIndexSnapshot();
        if (mode === 'purge') {
            return this.transaction(() => {
                const before = [...this.container.getIndex().hot_order];
                const lineage = this.collectVersionLineage(id);
                for (const vid of lineage) {
                    const member = this.container.entryMeta(vid);
                    if (!member)
                        continue;
                    this.assertNotProtected(member);
                    this.stageUnlink(this.entryPath(vid));
                    this.container.removeEntryMeta(vid);
                }
                this.finishIndex();
                const after = [...this.container.getIndex().hot_order];
                const snapshot = { before, after, removed: before.filter((x) => !after.includes(x)), added: [] };
                this.log.warn(`forget(purge): 物理删除 ${id}（reason=${options.reason}）` +
                    (lineage.length > 1 ? `，连同 ${lineage.length - 1} 个历史版本` : '') +
                    `，hot_order ${before.length} → ${after.length}`);
                return { ok: true, id, mode, hot_order: snapshot, wiped_versions: lineage.length };
            }, receipt ? (out) => this.appendReceipt(receipt, out.id) : undefined);
        }
        return this.transaction(() => {
            const fields = tombstoneFields(this.operator, options.reason);
            const before = [...this.container.getIndex().hot_order];
            const lineage = this.collectVersionLineage(id);
            // 【隐私删除设计】墓碑仅保留元数据（id / 时间 / 状态 / 原因 / 版本链），**不保留正文**。
            // 原实现写入 entry.content —— 那等于「隐私删除」名不副实：墓碑还在，正文可完整恢复。
            // 现在墓碑是空正文；需要可审计时看的是「谁在何时因何删了哪个 id」，不是原文。
            //
            // 整条血脉一起抹（作者 2026-10-06 拍板 (a)）：见 collectVersionLineage 的注释。
            for (const vid of lineage) {
                const member = this.container.readEntry(vid);
                const memberMeta = this.container.entryMeta(vid);
                if (!member || !memberMeta) {
                    this.log.warn(`forget(tombstone): 血脉成员 ${vid} 读不到，跳过（文件可能已被外部删除）`);
                    continue;
                }
                this.assertNotProtected(memberMeta);
                this.writeEntryFile(vid, {
                    ...member.frontmatter,
                    ...fields,
                    // 【修复】删除者的来源必须落进墓碑（否则回执与 md 对不上）
                    deleted_source_session: options.source_session,
                    deleted_source_message: options.source_message,
                    // summary 默认是正文前 80 字 —— 不换掉等于把原文留在了 frontmatter 里，
                    // 「隐私删除」就成了只删正文不删摘要。**墓碑必须连摘要一起抹。**
                    summary: TOMBSTONE_SUMMARY,
                    // title 同理（审计 P1-8）：换成中性身份标识，见 tombstoneTitle 注释。
                    title: tombstoneTitle(vid, fields.deleted_at),
                    operator: this.operator,
                    operation: 'forget',
                    // supersedes / superseded_by / version **原样保留**：审计链要的是
                    // "谁在何时改了谁"，不是原文（这正是"留结构、抹内容"的分界）。
                }, TOMBSTONE_BODY, { contentChanged: true });
                // writeEntryFile 内部已 syncEntryMeta（title / summary / status / deleted_* 都在同步清单里），
                // 这里只补它不覆盖的两项：文件位置与版本链指针。
                this.container.syncEntryMeta(vid, {
                    file: memberMeta.file,
                    superseded_by: member.frontmatter.superseded_by,
                });
                // 必须物理剔除：一致性校验只查 superseded，不查 expired，光靠 temporal 过滤会漏检
                this.container.removeFromHotOrder(vid);
            }
            this.finishIndex();
            const after = [...this.container.getIndex().hot_order];
            const snapshot = { before, after, removed: before.filter((x) => !after.includes(x)), added: [] };
            this.log.info(`forget(tombstone): ${id}（reason=${options.reason}）` +
                (lineage.length > 1 ? `，连同 ${lineage.length - 1} 个历史版本一并抹除` : '') +
                (snapshot.removed.length ? `，已从 hot_order 物理剔除 ${snapshot.removed.join(',')}` : ''));
            return { ok: true, id, mode, hot_order: snapshot, temporal_state: 'expired', wiped_versions: lineage.length };
        }, receipt ? (out) => this.appendReceipt(receipt, out.id) : undefined);
    }
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
    collectVersionLineage(id) {
        const seen = new Set([id]);
        const queue = [id];
        while (queue.length > 0) {
            const current = queue.shift();
            const entry = this.container.readEntry(current);
            if (!entry)
                continue;
            const fm = entry.frontmatter;
            for (const prev of fm.supersedes ?? []) {
                if (prev && !seen.has(prev)) {
                    seen.add(prev);
                    queue.push(prev);
                }
            }
            const next = fm.superseded_by;
            if (next && !seen.has(next)) {
                seen.add(next);
                queue.push(next);
            }
        }
        return [...seen];
    }
    /** memory_propose：模型推断/总结/情绪 → 候选区（物理上无转正通道） */
    propose(input, receipt) {
        const record = this.buildRecord('propose', 'pending', input);
        return this.transaction(() => {
            // 候选区同样不许堆重复：同一条推断被反复 propose 会稀释检索（p02 纪律的机械版）
            // P0-4：source_message=0 ⇒ 不参与幂等
            const dup = record.source_message === '0' ? null : this.findDuplicateFor(record);
            if (dup?.via === 'content')
                return this.absorbDuplicate(dup.hit.id);
            const outcome = this.createEntry(record);
            if (dup?.via === 'title')
                outcome.title_collision = { id: dup.hit.id, title: dup.hit.title };
            if (dup?.via === 'content_other_scope') {
                // 【S2 · P1-5】跨 scope 撞同文：**不合并**（作者 2026-10-08 拍板），
                // 只回提示；⛔ 不去碰对方条目的任何字段（访问计数也不动）。
                outcome.scope_collision = {
                    id: dup.hit.id,
                    scope: dup.hit.scope ?? 'global',
                    ...(dup.hit.scope_id ? { scope_id: dup.hit.scope_id } : {}),
                };
            }
            this.log.info(`propose: ${outcome.id} 进入候选区（待人工确认）`);
            return outcome;
        }, receipt ? (out) => this.appendReceipt(receipt, out.id) : undefined);
    }
    /** 候选转正：pending → 目标层（默认 longterm），写 confirmed_at/by 留痕 */
    confirm(id, options = {}) {
        const meta = this.container.entryMeta(id);
        if (!meta)
            throw new WriteError(ERR.ENTRY_NOT_FOUND, `候选不存在: ${id}`);
        if (meta.layer !== 'pending')
            throw new WriteError(ERR.INVALID_INPUT, `条目不是候选: ${id} (layer=${meta.layer})`);
        const target = options.targetLayer ?? 'longterm';
        if (target === 'pending')
            throw new WriteError(ERR.INVALID_INPUT, '转正目标层不得为 pending');
        const operator = options.operator ?? this.operator;
        const fields = confirmFields(operator);
        // ── 转正即重打标（2026-10-03，标定带出来的修复）─────────────────────
        // 候选区的条目一律 `process`（"可能是噪声，快衰"）；**人工转正恰恰是"它不是噪声"的裁断**。
        // 不重打标的后果实测（p05 缓存塌陷根因，BM25 52.2 是第二名的 10 倍）：
        //   带着 process 标记 → 打分里 process 豁免新鲜度（w3_process = 0，0.4 的权重直接归零）
        //   → score_in 0.535 < 门禁 0.678 → 被挤进候选区，而弱 10 倍的条目进了 main。
        // 口径：只把 process（或缺失）抬成 recent；`core` 是人工显式给的，必须原样保留。
        return this.transaction(() => {
            // ── 【Ledger · L-3 修复】候选也要在**事务内**重读（同 update 的理由）─────
            // 修复前 `readEntry(id)` 在事务外：另一通道改了候选正文的话，转正会把旧正文写回去。
            const entry = this.container.readEntry(id);
            if (!entry)
                throw new WriteError(ERR.ENTRY_NOT_FOUND, `候选不存在: ${id}`);
            const decayType = entry.frontmatter.decay_type === undefined || entry.frontmatter.decay_type === 'process'
                ? 'recent'
                : entry.frontmatter.decay_type;
            this.writeEntryFile(id, {
                ...entry.frontmatter,
                layer: target,
                status: 'active',
                decay_type: decayType,
                ...fields,
                operator,
                operation: 'propose',
            }, entry.content, { contentChanged: false });
            // pending → 目标层要换目录，同步迁移文件位置
            const movedTo = this.moveEntryFile(id, target);
            this.container.syncEntryMeta(id, { layer: target, file: movedTo, status: 'active', decay_type: decayType, ...fields, operator, operation: 'propose' });
            // opinion 转正同样常驻（与 remember 的分流规则一致）
            let snapshot;
            if (entry.frontmatter.memory_type === 'opinion') {
                snapshot = this.container.appendHotOrder(id);
            }
            this.finishIndex();
            this.log.info(`confirm: ${id} pending → ${target}${snapshot ? '（opinion，已进 hot_order）' : ''}`);
            return { ok: true, id, layer: target, hot_order: snapshot };
        });
    }
    /** 自动转正回滚：longterm → pending，清 confirmed 留痕；只允许 auto 批次调用。 */
    unconfirm(id, options = {}) {
        const meta = this.container.entryMeta(id);
        if (!meta)
            throw new WriteError(ERR.ENTRY_NOT_FOUND, `条目不存在: ${id}`);
        if (meta.layer !== 'longterm')
            throw new WriteError(ERR.INVALID_INPUT, `只能回滚 longterm 条目: ${id} (layer=${meta.layer})`);
        const operator = options.operator ?? this.operator;
        return this.transaction(() => {
            const entry = this.container.readEntry(id);
            if (!entry)
                throw new WriteError(ERR.ENTRY_NOT_FOUND, `条目不存在: ${id}`);
            const fm = { ...entry.frontmatter, layer: 'pending', status: 'active' };
            delete fm.confirmed_at;
            delete fm.confirmed_by;
            this.writeEntryFile(id, fm, entry.content, { contentChanged: false });
            const movedTo = this.moveEntryFile(id, 'pending');
            this.container.syncEntryMeta(id, { layer: 'pending', file: movedTo, status: 'active', confirmed_at: undefined, confirmed_by: undefined });
            this.finishIndex();
            this.log.info(`unconfirm: ${id} longterm → pending（${options.reason ?? 'rollback'}）`);
            return { ok: true, id, layer: 'pending' };
        });
    }
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
    relocate(id, targetLayer, options = {}) {
        if (targetLayer === 'pending') {
            throw new WriteError(ERR.INVALID_INPUT, '不能迁移到 pending（候选层只由 propose 写入）');
        }
        const fields = relocateFields(options.operator ?? this.operator);
        return this.transaction(() => {
            const meta = this.container.entryMeta(id);
            if (!meta)
                throw new WriteError(ERR.ENTRY_NOT_FOUND, `条目不存在: ${id}`);
            if (meta.layer === targetLayer) {
                throw new WriteError(ERR.INVALID_INPUT, `条目已在 ${targetLayer} 层: ${id}`);
            }
            // 【监控修复 · 2026-10-19】`meta` 是**活引用**：`syncEntryMeta` 之后它的 layer 已是目标层
            // ⇒ 日志里再读 `meta.layer` 会永远打成 “archive → archive”（源层丢失）。必须先留底。
            const fromLayer = meta.layer;
            // ⭐【欠账 #3 落地 · 口径 B · 2026-10-15】「凡改变**可投递性**的迁徙（进出 `hot`）⇒ 必须人工」
            //
            // ## 口径（`MemoryV1.3-Lite-欠账3-4方案` 第六节 · 追认人 作者）
            // · 改变可投递性的（进出 `hot`）⇒ **必须人工** ⇒ **要求显式 `operator`**（⛔ 不许用 writer 的默认值顶替）
            // · 不改变的（`longterm` → `archive`）⇒ 允许自动（衰减扫描照旧）
            //
            // ## 为什么"要求显式 operator"就等于"必须人工"
            // 自动路径（衰减扫描）**只做 `longterm` → `archive`** ⇒ 碰不到这里；
            // 而人工路径（面板/CLI）**本来就会带上是谁点的** ⇒ 这一步**把"谁点的"从习惯变成必要条件** ✓
            const relOp = options.operator ?? this.operator;
            if ((targetLayer === 'hot' || meta.layer === 'hot') && !options.operator) {
                throw new WriteError(ERR.INVALID_INPUT, `进出 hot 层是**改变可投递性**的迁徙 ⇒ 必须显式给出 operator（口径 B：人工）。id=${id} ${meta.layer}→${targetLayer}，operator 实为 ${relOp}`);
            }
            // ⛔【L2-T2 · 2026-10-15 · 作者 拍 A2】"能不能用"是**决策** ⇒ 必须经 `temporalState`（唯一判定出口），
            //   ⛔ 决策点不得自己问 `status`（否则"到期"会有两个判断者）。
            const state = temporalState(meta);
            if (state === 'expired' || state === 'superseded') {
                throw new WriteError(ERR.INVALID_INPUT, `墓碑/废弃条目不做层迁移: ${id}（temporal_state=${state}）`);
            }
            const entry = this.container.readEntry(id);
            if (!entry)
                throw new WriteError(ERR.ENTRY_NOT_FOUND, `条目读不到: ${id}`);
            const operator = options.operator ?? this.operator;
            this.writeEntryFile(id, { ...entry.frontmatter, layer: targetLayer, ...fields, operator, operation: 'relocate' }, entry.content, { contentChanged: false });
            const movedTo = this.moveEntryFile(id, targetLayer);
            this.container.syncEntryMeta(id, { layer: targetLayer, file: movedTo, ...fields, operator, operation: 'relocate' });
            // hot_order 与层联动：迁出 hot 层必须剔名单；迁进 hot 层**不自动常驻**
            // （常驻是人工策展，见 hot_order 的语义：它是"谁进系统提示词"的唯一真源）
            let snapshot;
            const inRoster = (this.container.getIndex().hot_order ?? []).includes(id);
            if (targetLayer !== 'hot' && inRoster) {
                snapshot = this.container.removeFromHotOrder(id);
            }
            this.finishIndex();
            this.log.info(`relocate: ${id} ${fromLayer} → ${targetLayer}（${movedTo}）${snapshot ? `｜已从 hot_order 剔除（${snapshot.before.length} → ${snapshot.after.length}）` : ''}` +
                (options.reason ? `｜原因：${options.reason}` : ''));
            return { ok: true, id, layer: targetLayer, hot_order: snapshot };
        });
    }
    /** 候选丢弃：写墓碑 + 物理剔出 hot_order（若有） */
    discard(id, options = {}) {
        const meta = this.container.entryMeta(id);
        if (!meta)
            throw new WriteError(ERR.ENTRY_NOT_FOUND, `候选不存在: ${id}`);
        if (meta.layer !== 'pending')
            throw new WriteError(ERR.INVALID_INPUT, `条目不是候选: ${id} (layer=${meta.layer})`);
        const operator = options.operator ?? this.operator;
        const fields = discardFields(operator);
        return this.transaction(() => {
            // ── 【Ledger · L-3 修复】候选也要在**事务内**重读（同 update / confirm）──
            // 墓碑虽然会抹掉正文，但 frontmatter（title / tags / 版本链）同样取自这份快照——
            // 锁外快照会把别人的改动写进墓碑，审计链就指错了。
            const entry = this.container.readEntry(id);
            if (!entry)
                throw new WriteError(ERR.ENTRY_NOT_FOUND, `候选不存在: ${id}`);
            // 丢弃后必须迁出 pending/：目录语义是「待审」，裁定完的墓碑留在里面会让两件事都失真——
            //   ① 目录名撒谎（里面躺着已裁定项）② 膨胀告警的条数统计被永久占用。
            // 墓碑归 longterm：文件与索引同源，仍然可审计、可追溯，但不再占候选位。
            const target = options.tombstoneLayer ?? 'longterm';
            // ⚠️ frontmatter 的 layer 必须与 index 一起改：只迁文件不改文件头，
            //    下次加载会撞「索引与条目文件 layer 不一致」——容器自己的 fail-fast 会拦下来（实测踩过）。
            this.writeEntryFile(id, {
                ...entry.frontmatter,
                layer: target,
                ...fields,
                summary: TOMBSTONE_SUMMARY,
                // 丢弃也是墓碑（同一条隐私口径，见 tombstoneTitle 注释）：标题不许留着原文
                title: tombstoneTitle(id, fields.deleted_at),
                operator,
                operation: 'propose',
            }, TOMBSTONE_BODY, { contentChanged: true });
            const movedTo = this.moveEntryFile(id, target);
            this.container.syncEntryMeta(id, {
                layer: target,
                file: movedTo,
                status: fields.status,
                // 同 forget：索引投影一起脱敏（见上面那段注释）
                title: tombstoneTitle(id, fields.deleted_at),
                summary: TOMBSTONE_SUMMARY,
                deleted_at: fields.deleted_at,
                deleted_by: fields.deleted_by,
                delete_reason: fields.delete_reason,
                updated: fields.updated,
                operator,
                operation: 'propose',
            });
            const snapshot = this.container.removeFromHotOrder(id);
            this.finishIndex();
            this.log.info(`discard: ${id} 候选已丢弃（墓碑迁至 ${target}）`);
            return { ok: true, id, mode: 'tombstone', layer: target, hot_order: snapshot };
        });
    }
    /** 列出候选（CLI / 设置页共用） */
    listPending() {
        // 只列「仍在等待人工处理」的候选：已 confirm 的已换层离开，已 discard 的状态为 expired。
        // 不排除的话，丢弃过的候选会永远挂在列表里，膨胀控制的计数也会失真。
        return this.container
            .listByLayer('pending')
            .filter((meta) => meta.status !== 'expired' && meta.status !== 'superseded')
            .map((meta) => ({
            id: meta.id,
            title: meta.title,
            memory_type: meta.memory_type,
            created: meta.updated,
            file: meta.file,
        }));
    }
    // ────────────────────────────────────────────────────────────
    // 内部实现
    // ────────────────────────────────────────────────────────────
    /**
     * 原文比对（P2）：确认这次直写能指到用户原话。
     *
     * 三种情形：
     *   ① 未注入 sessionBuffer → 不做校验（保持旧行为，纯软层）
     *   ② 会话缓冲为空（例如 CLI/无会话上下文）→ 不做校验（否则会把 CLI 写入全拒掉）
     *   ③ 有缓冲但找不到引用 → enforce 拒绝（改走 propose）/ warn 仅记日志
     */
    assertUserQuote(content, sessionId, allowOldContent = false) {
        if (allowOldContent)
            return;
        if (!this.sessionBuffer || !sessionId)
            return;
        const messages = this.sessionBuffer.recent(sessionId);
        if (messages.length === 0)
            return;
        const hit = findQuote(content, messages, this.minQuote);
        if (hit) {
            this.log.info(`原文比对通过：引用会话 ${sessionId} 第 ${hit.seq} 条用户消息`);
            return;
        }
        const detail = `写入内容找不到用户原话依据（会话 ${sessionId} 缓冲 ${messages.length} 条，` +
            `最小引用 ${this.minQuote} 字）。若是你自己的推断/总结，请改用 memory_propose 进候选区。`;
        if (this.quoteMode === 'enforce') {
            this.log.warn(`原文比对拒绝：${detail}`);
            throw new WriteError(ERR.NO_USER_QUOTE, detail);
        }
        this.log.warn(`原文比对未通过（warn 模式，放行）：${detail}`);
    }
    buildRecord(operation, layer, input) {
        assertSource(input);
        const content = input.content.trim();
        const record = {
            title: normalizeTitle(input.title),
            content,
            memory_type: input.memory_type,
            tags: input.tags ?? [],
            priority: input.priority ?? 60,
            scope: input.scope ?? 'global',
            scope_id: input.scope_id,
            valid_from: input.valid_from,
            valid_to: input.valid_to,
            source_session: input.source_session,
            source_message: input.source_message,
            about: input.about,
            operation,
            operator: this.operator,
            idem_key: computeIdemKey(input.source_session, input.source_message, content),
            summary: input.summary?.trim() || truncateCodePoints(content, 80),
            layer,
            decay_type: input.decay_type,
        };
        assertWritable(record);
        if (record.scope !== 'global' && !record.scope_id) {
            throw new WriteError(ERR.INVALID_INPUT, `scope=${record.scope} 时必须提供 scope_id（由插件从宿主上下文推导，不得留空）`);
        }
        assertChannelConsistency(operation, layer);
        return record;
    }
    /** 新建条目（可延迟落盘索引，供 update 事务内合并提交） */
    createEntry(record, options = {}) {
        const id = this.container.nextEntryId(record.layer);
        const iso = nowIso();
        // ── V1.2 接线（2026-10-03）：写入那一刻就打标、就落衰减种子 ──────────
        // 为什么必须在写入时刻：衰减引擎（V1.3）读 decay_type / last_accessed。
        // 不在这里落，每条新记忆都是"没有 last_accessed 的野生条目"，
        // 存量回填的问题会在每条新数据上重演一遍（ingest.ts 文件头的原话）。
        const decayType = this.resolveDecayType(record, options.inheritedDecay);
        const seed = initDecayFields(decayType, iso);
        const fm = {
            id,
            layer: record.layer,
            title: record.title,
            source: `记忆写入（${record.operation}）`,
            source_session: record.source_session,
            source_message: record.source_message,
            about: record.about,
            created_at: iso,
            scope: record.scope,
            scope_id: record.scope_id,
            tags: record.tags,
            priority: record.priority,
            updated: today(),
            checksum: '',
            summary: record.summary,
            valid_from: record.valid_from,
            valid_to: record.valid_to,
            supersedes: record.supersedes,
            status: 'active',
            memory_type: record.memory_type,
            version: record.version ?? 1,
            idem_key: record.idem_key,
            operator: record.operator,
            operation: record.operation,
            decay_type: seed.decay_type,
            last_accessed: seed.last_accessed,
            access_count: seed.access_count,
            lifecycle: seed.lifecycle,
        };
        this.container.addEntryFile({ id, layer: record.layer, frontmatter: fm, content: record.content });
        if (!options.deferIndex)
            this.finishIndex();
        // 写入成功后回调（插件清装配缓存）；在事务提交后调用更准确，这里由 transaction 包装
        return {
            ok: true,
            id,
            layer: record.layer,
            version: fm.version,
            temporal_state: temporalState(fm),
        };
    }
    /**
     * 写回既有条目文件，**并把 frontmatter 的变更同步进内存索引**。
     * 不同步的后果是真实踩过的坑：文件里 status=superseded，index.json 里却还是 active——
     * 导致 hot_order 一致性校验看不见废弃条目、UI 与检索各读一半。
     */
    writeEntryFile(id, fm, content, opts) {
        // ⚠️ **回滚第①步的供料点（2026-09-28 补）**：
        // 事务回滚靠 `touchedFiles` 还原「被改写的已有文件」，而在此之前**没有任何调用点**往里放东西
        // ⇒ 一旦 `finishIndex()` 抛错，第①步永远遍历空 Map，**文件留在新状态、索引回滚成旧状态**。
        // 实测形态（合成容器 + 模拟 index 落盘失败）：索引 `active` / 文件 `superseded`，
        // 重启后 `load({verify:true})` **不报错**，该条记忆从检索里**静默消失**（命中 0 条）。
        // 快照必须紧贴写原语，而不是靠"记得调用"。
        const rel = this.container.entryMeta(id)?.file;
        if (rel)
            this.snapshotIfExists(rel);
        const filePath = this.entryPath(id);
        // ⛔ 正文变了就必须重算校验和（字段注册表对 `checksum` 的规则原文：
        //    「写侧每次内容变更都要重算」）。**参数是必填的**，将来新增第 5 个调用点
        //    漏写会直接编译不过 —— 2026-10-09 安全审稿抓到的正是这里：
        //    `forget` 把正文换成墓碑体却带着**原文的校验和** ⇒ 删了正文、留下指纹，
        //    拿一段文字算 hash 一比对就能验证「它当初在不在这条记忆里」。
        const fmToWrite = opts.contentChanged ? { ...fm, checksum: computeChecksum(content) } : fm;
        this.container.atomicWrite(filePath, this.container.serializeEntryFile(fmToWrite, content));
        // 写后失效缓存（与 container.updateEntry 同一职责，双入口都要覆盖）
        this.container.invalidateCache(id);
        this.container.syncEntryMeta(id, {
            layer: fm.layer,
            title: fm.title,
            tags: [...fm.tags],
            priority: fm.priority,
            updated: fm.updated,
            summary: fm.summary,
            status: fm.status,
            memory_type: fm.memory_type,
            version: fm.version,
            idem_key: fm.idem_key,
            // scope 族 + 有效期 + 替代链必须跟着走：update/forget/转正 都不能让索引里这些字段变陈旧，
            // 否则 /list 的可见性与时间状态会与实际文件不一致（索引是 /list 的唯一数据源）。
            // 尤其 superseded_by —— update 时旧条要靠它标 superseded，漏同步会让旧版在列表里显示为 active。
            scope: fm.scope,
            scope_id: fm.scope_id,
            valid_from: fm.valid_from,
            valid_to: fm.valid_to,
            expires: fm.expires,
            superseded_by: fm.superseded_by,
            deleted_at: fm.deleted_at,
            deleted_by: fm.deleted_by,
            delete_reason: fm.delete_reason,
            operator: fm.operator,
            operation: fm.operation,
            confirmed_at: fm.confirmed_at,
            confirmed_by: fm.confirmed_by,
        });
    }
    /** pending → 目标层：把文件从 pending/ 移到目标层目录 */
    moveEntryFile(id, targetLayer) {
        const meta = this.container.entryMeta(id);
        if (!meta)
            throw new WriteError(ERR.ENTRY_NOT_FOUND, `条目不存在: ${id}`);
        const from = this.entryPath(id);
        const relFrom = meta.file;
        // 【S1 · P1-8】目标文件名**沿用原文件名**，不再由 title 现算。
        //
        // 原来这里写 `${id}_${safeTitle(meta.title)}.md`：① 文件名里带着标题，
        // 而标题兜底取自正文 —— 敏感事实会留在**文件名**里（审计 P1-8 的样本
        // 连文件名都是由原敏感标题生成的）；② 转正/丢弃会顺手改名，多一处无谓的状态变更。
        // 现在移动只换目录、不换名字（对既有文件是行为保持：pending 里的文件名本就是
        // `${id}_${title}.md`）。新建条目的命名见 container.addEntryFile。
        const fileName = path.basename(relFrom);
        const relTo = `${targetLayer}/${fileName}`;
        const to = this.container.resolvePath(relTo);
        if (from !== to) {
            // 【S1 · P1-1】目标层目录可能还不存在，先补建再 rename。
            //
            // 为什么：`addEntryFile` 会自建 pending/，但这条路径只 `renameSync`。
            // 于是一个**全新容器**（用户刚装好插件、还没建过 longterm/）在第一次
            // 候选转正时直接 ENOENT —— 转正失败。审计 E02 复现，且实测"实际库
            // pending 已存在、longterm 仍不存在"，说明这不是理论风险。
            // 空库路径就是**新用户的第一次使用**，不能断在这里。
            this.container.ensureLayerDir(targetLayer);
            if (fs.existsSync(to))
                throw new Error(`[memory-container] 转正目标文件已存在: ${relTo}`);
            fs.renameSync(from, to);
            // B2 修复：记下这次移动，回滚时搬回去（不是删掉）
            this.movedFiles.set(relTo, relFrom);
        }
        return relTo;
    }
    entryPath(id) {
        const meta = this.container.entryMeta(id);
        if (!meta)
            throw new WriteError(ERR.ENTRY_NOT_FOUND, `条目不存在: ${id}`);
        return this.container.resolvePath(meta.file);
    }
    /** 受保护条目：系统机制文件不可删 */
    assertNotProtected(meta) {
        if (meta.file === 'voice.md' || meta.file === 'index.json') {
            throw new WriteError(ERR.PROTECTED_ENTRY, `受保护文件不可删除: ${meta.file}`);
        }
    }
    /**
     * 衰减类型解析（ingest.classifyDecayType 的**唯一调用点**，V1.2 接线 2026-10-03）。
     *
     * 为什么在这里翻译错误类型：ingest 是纯函数模块，抛 `IngestError`；
     * writer 的契约是抛 `WriteError`（工具层据此返回结构化失败，而不是把栈甩给模型）。
     * 没这一步，非法值会以"系统错误"的形态冒出去，看起来像 bug 而不是参数问题。
     */
    resolveDecayType(record, inherited) {
        try {
            return classifyDecayType({
                operation: record.operation,
                explicit: record.decay_type,
                inherited,
                title: record.title,
                content: record.content,
                tags: record.tags,
            });
        }
        catch (error) {
            if (error instanceof IngestError)
                throw new WriteError(ERR.INVALID_INPUT, error.message);
            throw error;
        }
    }
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
    collectDupCandidates(operation, incoming) {
        const corpus = this.container.corpus();
        const { byFp, byTitle } = this.container.dupIndex();
        const fp = contentFingerprint(incoming.content);
        const ids = new Set([
            ...(byFp.get(fp) ?? []),
            ...(byTitle.get(dupTitleKey(incoming.title, incoming.decayType)) ?? []),
        ]);
        const out = [];
        for (const id of ids) {
            const meta = this.container.entryMeta(id);
            if (!meta)
                continue;
            if (meta.status && meta.status !== 'active')
                continue;
            if (operation === 'remember' && meta.layer === 'pending')
                continue;
            const doc = corpus.get(id);
            if (!doc)
                continue;
            // 作用域取自**条目文件**（唯一真源），不取索引投影——投影可能滞后。
            out.push({
                id, title: meta.title, decay_type: meta.decay_type, content: doc.content,
                scope: memoryScope(doc.frontmatter), scope_id: doc.frontmatter.scope_id,
                // 指纹由容器按**文档对象**记忆化：内容没重读就不重算
                fp: this.container.contentFpOf(doc),
            });
        }
        return out;
    }
    /** 判重（只读，不改状态）。确定性重复才命中，模糊相似留待标定（见 ingest.findDuplicate 注释） */
    findDuplicateFor(record) {
        const decayType = this.resolveDecayType(record);
        return findDuplicate({ title: record.title, content: record.content, decayType }, this.collectDupCandidates(record.operation, { title: record.title, content: record.content, decayType }), 
        // 【S2 · P1-5】**同一性**判据用写入方自己的 scope（⛔ 不是可见性 isInScope）
        { scope: record.scope, scope_id: record.scope_id });
    }
    /**
     * 判重吸收：**不新建条目**，改写既有条目的 `last_accessed` / `access_count`。
     *
     * 口径（刻意保守，2026-10-03）：
     *   · 只有**内容指纹精确命中**才走这里（归一化后逐字相同 = 同一句话，零语义风险）。
     *   · 标题撞车**不在这里合并** —— 标题是人为短标签，误撞概率高，
     *     而"把两件事合成一件"是不可逆的语义损失（ingest.ts 的原话）。
     *     标题撞车只回一条 `title_collision` 提示，让调用方自己决定（见 types.ts）。
     */
    absorbDuplicate(id) {
        const meta = this.container.entryMeta(id);
        if (!meta)
            throw new WriteError(ERR.ENTRY_NOT_FOUND, `判重命中但条目已不存在: ${id}`);
        const before = Number(meta.access_count) || 0;
        // 回滚第①步的供料点：这一步改写**既有文件**，没有快照 = 失败时文件新、索引旧
        this.snapshotIfExists(meta.file);
        const next = touchFields({ access_count: before }, nowIso());
        this.container.stampV12Fields(id, next, { saveIndex: false });
        this.finishIndex();
        this.log.info(`判重(content)：内容已存在 ${id}，不新建；access_count ${before} → ${next.access_count}`);
        return { ok: true, id, layer: meta.layer, duplicate: { via: 'content', id } };
    }
    /** 写后自检 + 落盘索引 */
    finishIndex() {
        const count = this.container.recountEntries();
        const actual = this.container.totalEntries();
        if (count !== actual) {
            throw new Error(`[memory-container] entry_count(${count}) 与 entries(${actual}) 不一致，拒绝落盘`);
        }
        this.container.saveIndex();
    }
    /** 把文件**原子地**暂存进 trash（purge 用；提交成功后由 commitStagedDeletes 真删） */
    stageUnlink(absPath) {
        if (!fs.existsSync(absPath))
            return;
        const root = this.container.root;
        const trashDir = path.join(root, '.purge-trash', `${process.pid}-${Date.now()}-${this.stagedDeletes.size}`);
        fs.mkdirSync(trashDir, { recursive: true });
        const dest = path.join(trashDir, path.basename(absPath));
        // 【purge 恢复 · 2026-10-19】落一份 sidecar：崩溃后启动 reconcile 才知道它该回哪一层。
        // 没有这份元数据，trash 只是一堆无主正文；有它才能“索引还列着就搬回、索引已删就真删”。
        const rel = path.relative(root, absPath);
        try {
            fs.writeFileSync(path.join(trashDir, 'meta.json'), JSON.stringify({ originalRel: rel, at: new Date().toISOString() }), 'utf-8');
        }
        catch (e) {
            try {
                fs.rmSync(trashDir, { recursive: true, force: true });
            }
            catch { /* best effort */ }
            throw new Error(`[purge] 暂存元数据写入失败（拒绝不可恢复的删除）：${String(e)}`);
        }
        fs.renameSync(absPath, dest);
        this.stagedDeletes.set(dest, absPath);
    }
    /**
     * 提交成功后真正删除暂存文件。返回**删不掉的目录**（空 = 全清）。
     * ⛔ 不回滚：此时索引已提交；但调用方必须拿到 leftover（否则“物理删除”假成功）。
     */
    commitStagedDeletes() {
        const dirs = new Set();
        for (const dest of this.stagedDeletes.keys())
            dirs.add(path.dirname(dest));
        const leftover = [];
        for (const dir of dirs) {
            try {
                fs.rmSync(dir, { recursive: true, force: true });
            }
            catch (e) {
                leftover.push(dir);
                this.log.error(`[purge] 暂存文件清理失败（正文仍留在 ${dir}，需人工删除）：${String(e)}`);
            }
        }
        this.stagedDeletes.clear();
        return leftover;
    }
    /** 事务回滚：把暂存删除的文件搬回原处。返回**搬不回去**的路径（空 = 全恢复） */
    restoreStagedDeletes() {
        const failed = [];
        for (const [dest, original] of this.stagedDeletes) {
            try {
                if (fs.existsSync(dest)) {
                    fs.mkdirSync(path.dirname(original), { recursive: true });
                    fs.renameSync(dest, original);
                }
                // 搬回成功后把空暂存目录也清掉（修前会留空目录，P4 的 dirs/md 计数对不上）
                try {
                    fs.rmSync(path.dirname(dest), { recursive: true, force: true });
                }
                catch { /* best effort */ }
            }
            catch (e) {
                failed.push(original);
                this.log.error(`回滚：搬回暂存文件失败 ${dest} → ${original}: ${String(e)}`);
            }
        }
        this.stagedDeletes.clear();
        return failed;
    }
    /** 事务内的回执行（失败即抛，由 transaction 负责回滚） */
    appendReceipt(stamp, id) {
        if (!id)
            throw new Error('[P0-3a] 回执缺少条目 id：按红处理（不能记一张没有主键的回执）');
        try {
            const rec = { sessionId: stamp.sessionId, id, at: Date.now(), idSource: stamp.idSource };
            if (stamp.op)
                rec.op = stamp.op;
            if (stamp.operator)
                rec.operator = stamp.operator;
            if (stamp.reason)
                rec.reason = stamp.reason;
            const line = JSON.stringify(rec) + '\n';
            fs.appendFileSync(path.join(this.container.root, 'write-receipts.jsonl'), line, 'utf-8');
        }
        catch (e) {
            throw new Error(`[P0-3a] 回执写入失败（写入已回滚，按红处理）：${e instanceof Error ? e.message : String(e)}`);
        }
    }
    /**
     * 事务包装：失败时恢复 index.json 原文与内存索引快照，并把已写的新文件归还磁盘状态。
     * 注意：调用方需保证本次事务内「新增的文件路径」可从索引差集推导——因此快照同时记录 entries。
     */
    transaction(work, receipt) {
        // 可重入：update/confirm 等内部已开事务，再包一层只会做无用的重复快照
        if (this.inTransaction) {
            const out = work();
            receipt?.(out);
            return out;
        }
        // 锁 > 事务：先拿到跨进程互斥，再谈单次事务的原子性。
        // 拿不到锁直接抛 LOCK_BUSY，不排队（本期不做队列）——排队会掩盖「两个实例在抢」的事实。
        const lock = this.useWriteLock
            ? acquireWriteLock(this.container.root, {
                staleMs: this.lockStaleMs,
                holder: this.operator,
                // 边界①②③在 lock.ts 内守；边界④靠下面 runTransaction 的重读索引
                retry: this.lockRetry,
            })
            : null;
        try {
            return this.runTransaction(work, receipt);
        }
        finally {
            lock?.release();
        }
    }
    /** 真正的事务体（已持锁） */
    runTransaction(work, receipt) {
        const indexPath = this.container.resolvePath('index.json');
        // 【P2 修复 · 外部改动可见性】写前必须重读磁盘索引。
        //
        // 为什么：插件启动时加载一次索引，之后一直用内存那份。若期间有**另一个写入通道**
        // 改了容器（CLI / 设置页 / 手工编辑），内存索引就已经过时——此时再写，会把那份旧索引
        // 整份落盘，**静默覆盖别人的改动**，并造成「索引指向已被移走的文件」这种加载期硬失败。
        // 2026-09-14 真实事故：CLI 丢弃 p01 + 转正 p02 后，插件写一条新记忆把索引回滚，
        // 索引说 p01 在 pending/，文件已在 longterm/ → 下次重启容器直接 fail-fast。
        //
        // 为什么安全：重读在**持有写入锁之后**执行，期间没有第二个写入者能改索引；
        // 且索引是磁盘状态的纯函数（条目内容一律从文件读），重读不会丢任何内存态。
        let indexBackup;
        let indexBefore;
        // 【L-5】增量日志与脏集合也属"本次事务的中间状态"：失败时不还原就会留下半截日志
        const persistBefore = this.container.captureIndexPersistence();
        try {
            // 重读：让内存索引对齐当前磁盘真相（索引不存在或损坏时此步会抛，交由上层暴露）。
            // verify:false —— 这里要的是「索引对齐」，不是「容器体检」：索引自身的完整性仍全量校验，
            // 但跳过逐条读文件做交叉校验（微基准实测那一步占写入延迟 94.2%，见 container.load 注释）。
            // 文件级脱节由启动期全量校验（verify 默认 true）兜底。
            this.container.load({ verify: false });
            indexBackup = fs.readFileSync(indexPath, 'utf-8');
            // 内存快照深拷：entries 的每一条也要拷，否则 syncEntryMeta 会就地改到快照
            indexBefore = structuredClone(this.container.getIndex());
        }
        catch (snapshotError) {
            this.log.error(`写入事务无法建立快照（index.json 不可读）: ${String(snapshotError)}`);
            throw snapshotError;
        }
        const filesBefore = new Set(indexBefore.entries.map((e) => e.file));
        // ⚠️ 这里**不能**预先快照全部文件：实测 2000 条时写入 p50 从 9.17ms 涨到 86.29ms
        // （每个事务多读 2000 个文件），把 load 两档省下的收益整份吃掉。
        // 改为**按需快照**：只在某个已有文件即将被改写时，才记下它那一份原文
        // （见 snapshotIfExists / 各写原语的调用点）。
        this.touchedFiles.clear();
        this.movedFiles.clear();
        this.stagedDeletes.clear();
        this.inTransaction = true;
        try {
            const result = work();
            // 提交成功：通知外部（清装配缓存）。⚠️ 必须在 receipt/不可逆删除**之前**：
            //   修前它排在最后 ⇒ 该回调一抛，回执已落、purge 已真删，却走回滚 ⇒ 幽灵回执/brick（对抗审核 P2-1）。
            if (result.id)
                this.onWrite?.({ id: result.id, operation: 'write' });
            else if (result.new_id)
                this.onWrite?.({ id: result.new_id, operation: 'write' });
            // 【P0-3a 修复 · 2026-10-19】回执在**提交之前**写：写不进去就抛 ⇒ 整个事务回滚
            //（⛔ 修前在事务外 append、失败仍回 ok:true ⇒ 分母丢了账面全绿）
            receipt?.(result);
            const purgeLeftover = this.commitStagedDeletes(); // 提交成功：purge 的暂存文件此刻才真删
            if (purgeLeftover.length)
                result.purge_leftover = purgeLeftover;
            this.touchedFiles.clear(); // 提交成功：快照不再需要
            this.movedFiles.clear(); // 提交成功：移动已落定，不需要搬回
            return result;
        }
        catch (error) {
            // ⓪ 【L-5】先还原索引持久化状态（日志 + 脏集合 + 基线哈希）——
            //    不还原的话：失败的事务会留下一行"指向旧快照"的增量记录，下次 load 重放它
            //    ⇒ 把已经回滚掉的改动又"复活"回来。
            try {
                this.container.restoreIndexPersistence(persistBefore);
            }
            catch { /* 交由下面的错误路径暴露 */ }
            // ⓪' purge 暂存删除：必须在索引还原**之前/之后都行**，但必须先于任何“按索引找文件”的检查
            const unrestored = this.restoreStagedDeletes();
            // ① 先把移动过的文件搬回原处（必须先于还原内容：还原要写到原路径）
            // ③ 把移动过的文件搬回原处（回滚的「搬回去」这一步，原实现缺失）
            for (const [relTo, relFrom] of this.movedFiles) {
                try {
                    const to = this.container.resolvePath(relTo);
                    const from = this.container.resolvePath(relFrom);
                    if (fs.existsSync(to)) {
                        if (fs.existsSync(from))
                            fs.unlinkSync(from); // 极端情形：原处已有同名文件
                        fs.renameSync(to, from);
                    }
                }
                catch (moveBackError) {
                    this.log.error(`回滚：搬回文件失败 ${relTo} → ${relFrom}: ${String(moveBackError)}`);
                }
            }
            // ② 还原被改写的**已有**文件（update 把旧版写成 superseded、confirm 改层等都会走这里）。
            //    必须在删新增文件之前做——否则新建的文件可能与被还原的文件重名。
            try {
                for (const [relPath, original] of this.touchedFiles) {
                    try {
                        const filePath = this.container.resolvePath(relPath);
                        const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : null;
                        if (current !== original)
                            this.container.atomicWrite(filePath, original);
                    }
                    catch (restoreError) {
                        this.log.error(`回滚：还原文件失败 ${relPath}: ${String(restoreError)}`);
                    }
                }
            }
            finally {
                this.touchedFiles.clear();
                // ⛔ movedFiles 必须留到搬回之后（清早了 ②③ 永远空转）
            }
            // ② 删除本次事务新增的文件
            //    ⚠️ B2 修复（2026-09-30）：必须**先排除移动过的文件**。
            //    `moveEntryFile` 走 renameSync——移动也满足「不在事务前集合里」，
            //    原实现会把它 unlink 掉，而索引已还原成指向原始路径 ⇒ 索引指向不存在的文件。
            //    现在：移动过的**搬回去**（在下面的 ③），只有真正新增的才删。
            try {
                const indexNow = this.container.getIndex();
                for (const entry of indexNow.entries) {
                    if (this.movedFiles.has(entry.file))
                        continue;
                    if (!filesBefore.has(entry.file)) {
                        const filePath = this.container.resolvePath(entry.file);
                        if (fs.existsSync(filePath))
                            fs.unlinkSync(filePath);
                    }
                }
                // ③ 搬回完成 + 新增已删 ⇒ 现在才清 movedFiles
                this.movedFiles.clear();
                // ④ 恢复内存索引到调用前快照 + index.json 原文
                //    （不能复用 JSON.parse(indexBackup)：generated_at / entry_count 会被 saveIndex 就地改过）
                this.container.restoreIndex(indexBefore);
                this.container.atomicWrite(indexPath, indexBackup);
            }
            catch (rollbackError) {
                this.log.error(`写入事务回滚未完整完成: ${String(rollbackError)}`);
                throw new AggregateError([error, rollbackError], '[memory-container] 写入失败，且回滚未完整完成，请从备份检查容器');
            }
            if (unrestored.length) {
                // ⛔ 回滚本身没完成：只抛原错误会让调用方以为“都撤回去了”
                throw new AggregateError([error, new Error(`回滚未完全恢复（文件缺在原路径）：${unrestored.join(', ')}`)], '[memory-container] 写入失败，且 purge 暂存文件未能全部搬回，请从 .purge-trash 人工恢复');
            }
            throw error;
        }
        finally {
            this.inTransaction = false;
        }
    }
}
export function reconcilePurgeTrash(root, log) {
    const out = { restored: [], deleted: [], skipped: [] };
    const trashRoot = path.join(root, '.purge-trash');
    if (!fs.existsSync(trashRoot))
        return out;
    let entries = [];
    try {
        const idx = JSON.parse(fs.readFileSync(path.join(root, 'index.json'), 'utf-8'));
        if (idx && Array.isArray(idx.entries))
            entries = idx.entries;
        else
            throw new Error('index.entries 不是数组');
    }
    catch (e) {
        out.skipped.push(`index.json 不可读，拒绝清理 trash：${e instanceof Error ? e.message : String(e)}`);
        log?.error?.(out.skipped[0]);
        return out;
    }
    const byId = new Map(entries.filter((e) => typeof e.id === 'string').map((e) => [e.id, e]));
    const rootAbs = path.resolve(root);
    for (const de of fs.readdirSync(trashRoot, { withFileTypes: true })) {
        if (!de.isDirectory())
            continue;
        const dir = path.join(trashRoot, de.name);
        try {
            const age = Date.now() - fs.statSync(dir).mtimeMs;
            if (age < 30_000) {
                out.skipped.push(`${de.name}：暂存目录太新（可能仍在执行），跳过`);
                continue;
            }
        }
        catch {
            continue;
        }
        let meta = null;
        try {
            meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf-8'));
        }
        catch { /* no meta */ }
        for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md'))) {
            const trashFile = path.join(dir, f);
            const id = f.slice(0, -3);
            const rel = typeof meta?.originalRel === 'string' && meta.originalRel
                ? meta.originalRel
                : (typeof byId.get(id)?.file === 'string' ? byId.get(id).file : null);
            if (!rel) {
                fs.rmSync(trashFile, { force: true });
                out.deleted.push(f);
                continue;
            }
            const orig = path.resolve(root, rel);
            if (!(orig === rootAbs || orig.startsWith(rootAbs + path.sep))) {
                out.skipped.push(`${f}：originalRel 越界（${rel}）`);
                continue;
            }
            if (fs.existsSync(orig)) {
                // 原文件已在（回滚已完成/重复副本）⇒ trash 这份是多余的
                fs.rmSync(trashFile, { force: true });
                out.deleted.push(`${f}（原路径已存在）`);
                continue;
            }
            fs.mkdirSync(path.dirname(orig), { recursive: true });
            fs.renameSync(trashFile, orig);
            out.restored.push(rel);
        }
        try {
            const remain = fs.readdirSync(dir).filter((f) => f !== 'meta.json');
            if (remain.length === 0)
                fs.rmSync(dir, { recursive: true, force: true });
        }
        catch { /* best effort */ }
    }
    const fmt = `恢复 ${out.restored.length} / 清理 ${out.deleted.length} / 跳过 ${out.skipped.length}`;
    if (out.restored.length || out.deleted.length)
        log?.warn?.(`[purge] 启动对账 .purge-trash：${fmt}`);
    if (out.skipped.length)
        log?.warn?.(`[purge] 启动对账有跳过项：${out.skipped.join('；')}`);
    return out;
}
