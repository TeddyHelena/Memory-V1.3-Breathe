/**
 * 容器读写器：负责加载 index.json、按需读取条目文件。
 * 默认只读；写入能力（updateEntry/saveIndex）由调用方显式启用
 * （插件层 allowEdit 开关），所有路径基于容器根目录相对解析且不得越界。
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildEntryId, nextSeq } from './idem.js';
import { localDay } from './day-boundary.js';
import { contentFingerprint } from './ingest.js';
import { diffEntryFields, MIRROR_FIELD_NAMES, REAL_DRIFT_KINDS } from './contract/fields.js';
import { computeChecksum, verifyChecksum } from './checksum.js';
/**
 * 索引三路合并（2026-10-07）——`saveIndex()` 乐观锁的配套件。
 *
 * 场景：内存里的索引是从"载入时的磁盘版"演化来的；若磁盘被**别人**改过，
 * 直接全量 dump 就会抹掉对方的改动（实测：18 处投影修正 10 分钟内被回滚）。
 * 但也不能简单"重载"——那会丢掉本次会话自己的改动（文件已落盘、索引没了 = 分叉）。
 *
 * 判据：**逐条比对 current 与 baseline，动过的用 current，没动过的用 disk。**
 *   · current 有 / disk 无 / baseline 无  → 本次新增 → 用 current
 *   · disk 有 / current 无             → 外部新增 → 用 disk
 *   · 两边都有 → 字段级：`current[k] !== baseline[k]` ⇒ 本次改过 ⇒ 用 current[k]；
 *              否则用 disk[k]（含"磁盘把该字段删了"）
 * 聚合块（hot_order / archive_index / longterm_tags）：整块判——本次动过用 current，否则用 disk。
 */
function mergeIndexThreeWay(current, disk, baseline) {
    const keyOf = (e) => (e && typeof e.id === 'string' ? e.id : JSON.stringify(e));
    const baseById = new Map((baseline?.entries ?? []).map((e) => [keyOf(e), e]));
    const diskById = new Map((disk.entries ?? []).map((e) => [keyOf(e), e]));
    const out = [];
    const seen = new Set();
    for (const e of current.entries) {
        const id = keyOf(e);
        seen.add(id);
        const cur = e;
        const base = baseById.get(id);
        const dsk = diskById.get(id);
        if (!base) {
            out.push(e);
            continue;
        } // 本次新增（或 baseline 缺失）→ 以内存为准
        if (!dsk) {
            out.push(e);
            continue;
        } // 磁盘没有（外部删了）→ 保守以内存为准，不静默丢条目
        // 字段级三路
        const merged = { ...dsk };
        for (const k of new Set([...Object.keys(cur), ...Object.keys(dsk)])) {
            const changedByUs = JSON.stringify(cur[k]) !== JSON.stringify(base[k]);
            if (changedByUs)
                merged[k] = cur[k];
            else if (!(k in dsk))
                delete merged[k];
            else
                merged[k] = dsk[k];
        }
        out.push(merged);
    }
    // 磁盘有、内存没有 → 外部新增，补进来（内存的 baseline 里也没有它）
    for (const e of disk.entries) {
        const id = keyOf(e);
        if (seen.has(id))
            continue;
        if (baseById.has(id))
            continue; // baseline 有而 current 没有 = 本次删了 → 尊重删除
        out.push(e);
    }
    const block = (cur, dsk, base) => (base !== undefined && JSON.stringify(cur) !== JSON.stringify(base)) ? cur : (dsk ?? cur);
    return {
        ...current,
        entries: out,
        entry_count: out.length,
        hot_order: block(current.hot_order, disk.hot_order, baseline?.hot_order),
        archive_index: block(current.archive_index, disk.archive_index, baseline?.archive_index),
        longterm_tags: block(current.longterm_tags, disk.longterm_tags, baseline?.longterm_tags),
    };
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
export function dupTitleKey(title, _decayType) {
    return `${String(title ?? '').trim()}`;
}
/**
 * 索引指纹：由全部条目的 `id|file|updated` 拼成。
 *
 * 用途有两个（都是"判等价"，不是身份）：
 *   · **语料级缓存的失效判据**——逐条比 mtime 的代价是 O(n) 次 statSync
 *     （实测 2000 条 = 119ms，把缓存本身的价值吃光了）；指纹是纯内存计算。
 *   · 【S2 · S2-C】**`load()` 要不要作废缓存**的判据——索引等价 ⇒ 文档/语料缓存继续有效。
 *
 * 为什么提到模块级：`load()` 需要在**替换 `this.index` 之前**先算旧索引的指纹，
 * 而那会儿 `this.getIndex()` 指的还是旧索引；写成模块函数最不容易搞错。
 */
function indexFingerprintOf(index) {
    let h = index.entries.length;
    for (const e of index.entries) {
        const str = `${e.id}|${e.file}|${e.updated}`;
        for (let i = 0; i < str.length; i++)
            h = (h * 31 + str.charCodeAt(i)) | 0;
    }
    return `${index.entries.length}:${h}`;
}
/**
 * 把**文件独有字段**从索引投影里抹掉（契约：`FIELD_REGISTRY` 里 `mirror === 'file-only'`）。
 *
 * 为什么必须有这一步（2026-10-09 安全审稿）：
 *   `checksum` 是**正文的哈希**，契约登记为 file-only（消费者是启动抽样校验与修复脚本）。
 *   实测真身：**70 条索引条目带着历史 `v2:`/`v3:` 校验和，其中 8 条已是墓碑** ——
 *   而 `index.json` 正是设置页/API 读的那份文件 ⇒ **删了正文，却在索引里留下指纹**：
 *   拿一段文字算 hash 一比对，就能验证「这段文字当初是否存在于这条记忆里」。
 *   更糟的是：file-only 意味着**漂移判据不看它** ⇒ 这份副本永远不会被审计，只会自我复制。
 *
 * ⛔ 调用点必须覆盖**每一个"索引进入内存"的边界**（load 与 saveIndex 的三路合并），
 *    否则残留会从另一条路回来。判据见 `test/index-fileonly.test.mjs`。
 * 清哪四个（都是 `mirror: 'file-only'`）：`checksum`（**正文指纹**，安全项）+
 *   `created_at` / `source_session` / `source_message`（**契约漂移**：契约说它们不进索引）。
 *   2026-10-10 把后三个也清了 —— 它们的读者只有**写路径**（幂等锚点、更新时间），
 *   而写路径读的是**文件**、不是索引投影 ⇒ 清掉不影响任何功能，只减少"要同步的地方"。
 */
const FILE_ONLY_IN_INDEX = ['checksum', 'created_at', 'source_session', 'source_message'];
export function stripFileOnlyFromIndex(index) {
    if (!index || !Array.isArray(index.entries))
        return 0;
    let stripped = 0;
    for (const e of index.entries) {
        for (const field of FILE_ONLY_IN_INDEX) {
            if (field in e) {
                delete e[field];
                stripped += 1;
            }
        }
    }
    return stripped;
}
/** 【P0-6】会话 id 分类：host=真 uuid；legacy_literal=历史标签；placeholder=占位；absent=无 */
export function classifySessionKind(v) {
    const s = typeof v === 'string' ? v.trim() : '';
    if (!s)
        return 'absent';
    // 【B4 修复 · 2026-10-19】host 判据必须认宿主的两种形态：裸 uuid 与 session-<uuid|12hex>
    if (/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|session-(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{12}))$/i.test(s))
        return 'host';
    if (s === 'current' || s === 'unknown' || s === 'n/a')
        return 'placeholder';
    return 'legacy_literal';
}
export class MemoryContainer {
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
    static PROJECTION_FIELDS = MIRROR_FIELD_NAMES;
    root;
    realRoot;
    index = null;
    /** id → 条目元信息的映射（避免每次 O(n) 线性查找；索引变更时重建） */
    byId = new Map();
    /** 语料级缓存：索引指纹 → 已解析文档（检索一次取齐后复用，避免逐条 stat） */
    corpusCache = null;
    /** 【S2 · S2-C】本进程自己写过的条目（增量刷新语料用；⛔ 不再整片作废语料缓存） */
    corpusDirtyIds = new Set();
    /** 【S2 · S2-C】是否相信自己能增量维护语料：检测到**外部改动**即置 false ⇒ 退回整片重建 */
    corpusTrusted = true;
    /** 【S2 · S2-C】内容指纹备忘录，键是条目文件对象（见 `contentFpOf`） */
    fpMemo = new WeakMap();
    /**
     * 【Ledger · L-1】崩溃自愈留痕：每次"索引指向的文件不在、已在别处找回并回正"记一条。
     * ⛔ **不许静默修**——修了不报，等于把"出过事"这件事藏起来（我们反复栽在这类"看起来没事"）。
     * 出口：`/selftest` 的 `repair_events`（与 `index_merge_events` 并列）。
     */
    repairEvents = [];
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
    hotAudit = [];
    /** 本轮 load 是否修过投影（修了就**立刻落盘**，否则下次 load 又读到盘上那份错的——永远不收敛） */
    repairedThisLoad = false;
    // ══════════════════════════════════════════════════════════════════
    // 【L-5 · 增量写索引】追加式日志（作者 2026-10-09 拍板"干吧"）
    // ══════════════════════════════════════════════════════════════════
    // 病：`saveIndex()` 每次把**整份**索引序列化落盘。S2 之后它是写入成本最大的一项
    //     （@2000 ≈5.0ms、@5000 ≈11.7ms，占写入 36–38%，斜率 0.001648 ms/条）。
    // 判定实验（scripts/index-format-bench.mjs）：追加式把"写一次"变成**常数**（0.03ms，写出 0.5KB），
    //     分片只把斜率除 4、仍随 n 涨 ⇒ 选追加式。
    // 形态：`index.json` 仍是**完整快照**（唯一真源之一），另有 `index.delta.jsonl` 逐行追加变更。
    //     读 = 快照 + 重放日志；日志带**基线哈希**，与快照对不上就整份作废（只信快照 + 留痕）。
    // 收敛：`load({verify:true})`（启动期）会把日志折平回快照 ⇒ 盘上任何时刻都不是"难懂的状态"。
    //     写事务里那档 `load({verify:false})` **只重放不折平** —— 否则每写一条都要付一份快照的钱，白干。
    /** 增量日志文件名 */
    static DELTA_LOG = 'index.delta.jsonl';
    /** 最近一次落盘快照的哈希（日志记录里的 `base` 与它比对） */
    snapshotHash = '';
    /** 日志文件的时间戳/大小（字节等价快路径要连它一起比，否则漏掉别的通道追加的记录） */
    logStamp = null;
    /** 自上次快照以来被动过的条目 id */
    dirtyIds = new Set();
    /** 自上次快照以来被删掉的条目 id */
    removedIds = new Set();
    /**
     * **结构变了** ⇒ 只能整份写快照（L-1 自愈回正投影 / 外部改动的三路合并）。
     * ⚠️ 第一版把"新增条目（entry_count 变了）"也算成结构变化 ⇒ **每条 remember 都走整份快照**，
     *    实测写入一点没降（@2000 13.31ms，与改前持平）——这条教训留在注释里。
     *    entry_count 本来就随增量记录一起带（`count` 字段），不需要整份写。
     */
    structuralDirty = false;
    /** hot_order 变了 ⇒ 不必整份写：它很小，塞进增量记录即可 */
    hotOrderDirty = false;
    /** 【L-5】日志作废 / 压缩留痕（与 repairEvents、indexMergeEvents 并列，⛔ 不许静默） */
    indexLogEvents = [];
    /** 【L-5】日志里**最早**一条记录的时间（时间护栏用：给"直接读 index.json 的人"一个有界的陈旧窗口） */
    logFirstAt = null;
    /** 【L-5】日志最多允许陈旧多久（毫秒）——超过就折平。默认 5 分钟 */
    logMaxAgeMs = 5 * 60_000;
    get deltaLogPath() { return path.join(this.root, MemoryContainer.DELTA_LOG); }
    statLog() {
        try {
            const st = fs.statSync(this.deltaLogPath);
            return { mtimeMs: st.mtimeMs, size: st.size };
        }
        catch {
            return null;
        }
    }
    /** 【L-5】标记某条目在索引投影里动过（下次落盘只需把这一条写进日志） */
    markIndexDirty(id) {
        if (this.dirtyIds.size >= 5000) {
            this.structuralDirty = true;
            return;
        } // 兜底：脏集合不该无限涨 ⇒ 退回整份写
        this.dirtyIds.add(id);
    }
    /** 【L-5】hot_order 变了（小字段，增量带得动） */
    markHotOrderDirty() { this.hotOrderDirty = true; }
    /**
     * 【L-5】强制下一次落盘写**整份快照**。三类必须走它：
     *   ① **隐私删除**（墓碑 / purge）—— 脱敏结果必须落进快照，否则 index.json 里还留着原文（安全）；
     *   ② **结构修复**（L-1 自愈回正投影）；
     *   ③ **外部改动的三路合并** —— 合并后磁盘上的快照已经不是我们的基线，
     *      此时追加的记录 `base` 对不上 ⇒ 重载时整份日志作废、本次改动会丢（实测：test #79 抓到）。
     */
    forceIndexSnapshot() { this.structuralDirty = true; }
    /** 【L-5】索引持久化状态（事务回滚要把日志与脏集合一起还原，否则留下半截状态） */
    captureIndexPersistence() {
        let logRaw = null;
        try {
            logRaw = fs.readFileSync(this.deltaLogPath, 'utf-8');
        }
        catch {
            logRaw = null;
        }
        return {
            logRaw, dirty: [...this.dirtyIds], removed: [...this.removedIds],
            structuralDirty: this.structuralDirty, hotOrderDirty: this.hotOrderDirty,
            snapshotHash: this.snapshotHash, lastIndexRaw: this.lastIndexRaw,
        };
    }
    restoreIndexPersistence(state) {
        try {
            if (state.logRaw === null) {
                if (fs.existsSync(this.deltaLogPath))
                    fs.unlinkSync(this.deltaLogPath);
            }
            else
                fs.writeFileSync(this.deltaLogPath, state.logRaw, 'utf-8');
        }
        catch { /* 还原失败：不掩盖原始错误，交由上层日志 */ }
        this.dirtyIds = new Set(state.dirty);
        this.removedIds = new Set(state.removed);
        this.structuralDirty = state.structuralDirty;
        this.hotOrderDirty = state.hotOrderDirty;
        this.snapshotHash = state.snapshotHash;
        this.lastIndexRaw = state.lastIndexRaw;
        this.logStamp = this.statLog();
    }
    static hashText(text) {
        return createHash('sha256').update(text, 'utf-8').digest('hex').slice(0, 16);
    }
    /** 【S2 · S2-D】语料代数：语料内容**真变过**就 +1（检索侧缓存拿它当失效判据） */
    corpusGeneration = 0;
    /** 【S2 追刀】判重索引（懒建）；`null` = 还没建，下次 `dupIndex()` 从语料建一次 */
    dupIdx = null;
    /**
     * 【S2 追刀·二】"我刚写下去的那份 index.json 原文"。
     *
     * 用途：写事务开头的 `load()` 要重读索引（l57 的并发防线，⛔ 不可拆），
     * 但**重读的代价里 90% 是 `JSON.parse`**（@2000 实测 5.2ms / 680KB）。
     * 判据取**字节完全相同就跳过解析**——不是比 mtime、不是比指针大小，
     * 是比内容本身：字节相同 ⇒ 解析结果必然相同，**零正确性风险**。
     */
    lastIndexRaw = null;
    /** 文档缓存：id → { 文件 mtimeMs, 解析结果 }。失效由 mtime 比对 + 写路径显式调用双保险。 */
    entryCache = new Map();
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
    tokenCache = new Map();
    /**
     * realpath 校验结果缓存：绝对路径 → 已校验通过（或抛过错的标记）。
     *
     * 为什么需要：`resolveInside` 对**每个存在的目标**做一次 `fs.realpathSync` 来挡符号链接越界。
     * 实测单次 0.0188ms × 500 条 = **9.01ms**——`/list` 在 500 条时的 12.46ms 里四分之三是它。
     * 而 realpath 对同一个文件不会变（除非文件被替换），缓存安全。
     *
     * 失效：写路径（atomicWrite / 删除 / 换层）后 `clearCache()` 会清空它。
     */
    realPathCache = new Map();
    /**
     * 投影对账结果（2026-10-07 加；**2026-10-09 V1.3-A · G1 改由字段注册表判定**）：
     * 本次 `load({verify:true})` 里发现的「索引（派生）≠ 条目文件（唯一真源）」清单，
     * 形如 `l-e01.source（index-stale 索引=undefined 文件="卷一…"）`。
     *
     * 只记录、**不阻断加载** —— 理由见 validate() 里那段注释（容器不能被自己的校验写死）。
     * 出口：`/selftest → data.projection_drift`，以及 scripts/drift-audit.mjs。
     */
    projectionDrift = [];
    /**
     * **数据缺口**（V1.3-A · G1 新增）：两侧都缺、且该字段**按契约该有值**的清单。
     *
     * 与 `projectionDrift` 严格分开的理由：漂移是"两个真源对不上"（要回正索引），
     * 缺口是"这条记忆压根没这个字段"（要回填数据）——**两件事的处置方式完全不同**，
     * 混在一起报就没人看得懂了（而"看不懂"的下一步就是"不看了"）。
     */
    dataMissing = [];
    /**
     * **历史遗留**（V1.3-A · G1）：两侧都缺、且**不可重建**的清单（如 14 条旧条目的 `source`）。
     *
     * 为什么单列一档：这类字段**不许编个值糊上**（不撒谎），但也不能藏起来（看不见=当没有）。
     * 三档各有各的动作：漂移→回正索引，缺口→回填数据，遗留→**只记录**。
     */
    legacyMissing = [];
    /**
     * **正文完整性**（V1.3-A · G3）：本次 `load({verify:true})` 的校验结果。
     * `checksumMismatch` 非空 = 正文被改动过而校验和没跟上 —— **这是真信号，不许粉饰**。
     * `checksumUnverifiable` = 旧格式（v3:）或空值：**不算通过也不算失败**，单独报。
     */
    checksumMismatch = [];
    checksumVerified = 0;
    checksumUnverifiable = 0;
    /** 读投影对账结果（load 之后有效；空数组 = 索引与文件一致） */
    getProjectionDrift() { return this.projectionDrift; }
    /**
     * 【孤儿发现 · 2026-10-19】启动扫描到的“盘上有 md、索引里没有”的条目（hot/longterm/archive）。
     * ⛔ 只发现、不自动收养：收养要先确认 id 冲突/来源，属于人工决策。pending/ 的孤儿仍由
     * `assertPendingConsistency` fail-fast 处理（写入方必须文件+索引联合提交）。
     */
    orphanFiles = [];
    getOrphanFiles() { return this.orphanFiles; }
    /** 扫描三层（hot/longterm/archive）的未登记 md；返回相对路径。只在 verify 档调用。 */
    scanOrphanFiles(index) {
        const indexed = new Set(index.entries.map((e) => String(e.file).replace(/\\/g, '/')));
        const out = [];
        for (const layer of ['hot', 'longterm', 'archive']) {
            let names = [];
            try {
                names = fs.readdirSync(path.join(this.root, layer));
            }
            catch {
                continue;
            }
            for (const name of names) {
                if (!name.endsWith('.md'))
                    continue;
                const rel = `${layer}/${name}`;
                if (!indexed.has(rel))
                    out.push(rel);
            }
        }
        return out.sort();
    }
    /**
     * 读**数据缺口**（load 之后有效；空数组 = 该有值的字段都有值）。
     * ⛔ 不许和 `getProjectionDrift()` 混着报：漂移要回正索引，缺口要回填数据。
     */
    getDataMissing() { return this.dataMissing; }
    /**
     * 读**历史遗留**（load 之后有效；空数组 = 没有不可重建的缺字段）。
     * 出口 `/selftest → data.legacy_missing`。⛔ 这一档**不做任何写动作** —— 不可重建就是不可重建。
     */
    getLegacyMissing() { return this.legacyMissing; }
    /**
     * 读正文完整性读数（load 之后有效）。出口 `/selftest → data.checksum`。
     * ⛔ 三个数必须**一起报**（verified / mismatch / unverifiable）—— 只报 mismatch 会让人
     * 以为"没报就是全对"，而实际可能一条都验不了。
     */
    checksumStatus() {
        return { verified: this.checksumVerified, mismatch: this.checksumMismatch, unverifiable: this.checksumUnverifiable };
    }
    constructor(root) {
        this.root = path.resolve(root);
        this.realRoot = fs.realpathSync(this.root);
    }
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
    load(options = {}) {
        const verify = options.verify ?? true;
        const repairProjection = options.repairProjection ?? false;
        const indexPath = path.join(this.root, 'index.json');
        if (!fs.existsSync(indexPath)) {
            throw new Error(`[memory-container] index.json 不存在: ${indexPath}`);
        }
        const raw = fs.readFileSync(indexPath, 'utf-8');
        // 【S2 追刀·二】字节与我上次写下去的那份完全相同 ⇒ 跳过 parse + validate。
        // 为什么安全：比较对象是**内容本身**（不是 mtime、不是大小），字节相同则解析结果必然相同。
        // 为什么有效：写事务开头每次都要 load()，而 parse 占了这次重读的九成。
        if (this.index && this.lastIndexRaw !== null && raw === this.lastIndexRaw) {
            // 【L-5】⚠️ 光比快照字节不够：**别的通道可能往增量日志里追加过记录**。
            // 日志时间戳/大小也相同 ⇒ 磁盘状态与内存索引等价，才敢走快路径。
            const logNow = this.statLog();
            const sameLog = (logNow?.size ?? 0) === (this.logStamp?.size ?? 0) &&
                (logNow?.mtimeMs ?? 0) === (this.logStamp?.mtimeMs ?? 0);
            if (sameLog) {
                this.indexStamp = this.statIndex();
                return this.index;
            }
        }
        const parsed = JSON.parse(raw);
        // 【L-5】快照 + 增量日志 = 当前索引（必须在 validate 之前重放：校验要看到合并后的真身）
        const applied = this.replayDeltaLog(parsed, raw);
        this.validate(parsed, verify, repairProjection);
        // 【孤儿发现】只在启动的 verify 档扫（写事务的 verify:false 不付这份 readdir 成本）
        this.orphanFiles = verify ? this.scanOrphanFiles(parsed) : [];
        // ── 【S2 · S2-C】缓存保留判据（写入 O(n) 的真凶就在这几行）──────────────
        // 修复前：每次 `load()` 一律 `entryCache.clear() + corpusCache = null`。
        // 而**每一次写入事务开头都会 `load()`**（见 `writer.runTransaction`，那是 l57 的并发防线，
        // ⛔ 不许省）⇒ 等于"每写一条都把整库从磁盘重读重解析一遍"——判定实验里那 90.6% 的斜率就是它。
        //
        // 判据：**新索引与旧索引等价（同一个指纹）⇒ 文档/语料缓存继续有效，不清**。
        // 为什么安全：语料里的**正文**来自条目文件，由 `readEntry` 的 mtime 比对与
        // `corpusTrusted` 兜底；索引重载换的是**元信息**。索引真变过（外部改动 / 换层 / 增删）
        // 时指纹必然变 ⇒ 走下面那支整片作废（与修复前的行为逐字相同）。
        // 【安全 · 2026-10-09】索引里不许留正文指纹（见 stripFileOnlyFromIndex 的注释）
        const stripped = stripFileOnlyFromIndex(parsed);
        if (stripped > 0) {
            // ⛔ 清到东西就**必须落盘**：只清内存的话，盘上那份残留会一直躺着——
            //    实测（真身：无漂移、无待折平日志）首启动**不会改写 index.json**，
            //    于是 70 条正文指纹（含 8 条墓碑）继续留在设置页读的那份文件里，
            //    等到"下一次自然写入"才消失 —— 那是**不知道什么时候**。
            //    复用现成的 repairedThisLoad 通道（load 末尾统一 saveIndex）。
            this.repairedThisLoad = true;
            this.indexMergeEvents.push(`load: 清掉 ${stripped} 条 file-only 字段残留（checksum，正文指纹）并落盘`);
            if (this.indexMergeEvents.length > 10)
                this.indexMergeEvents.shift();
        }
        const sameIndex = this.index !== null && indexFingerprintOf(this.index) === indexFingerprintOf(parsed);
        this.index = parsed;
        if (!sameIndex) {
            this.entryCache.clear();
            this.tokenCache.clear();
            this.corpusCache = null;
            this.corpusDirtyIds.clear();
            this.corpusTrusted = true;
            this.dupIdx = null;
            this.lastIndexRaw = null; // 索引真变了 ⇒ 原文缓存作废
        }
        this.byId.clear();
        // 乐观锁基线（2026-10-07）：记下"我看到的磁盘索引"长什么样。
        // 之后 saveIndex() 若发现磁盘变了，就知道是**别人**动的，先合并再写。
        this.indexStamp = this.statIndex();
        this.indexBaseline = JSON.parse(JSON.stringify(parsed));
        // ── 【Ledger · L-1】自愈必须**落盘**，否则永远不收敛 ──────────────────
        // 只修内存的话：下次任何写入事务的 `load({verify:false})` **会把盘上那份错的读回来**，
        // 再连同写操作一起把错的写回去 ⇒ 每次启动都要修一遍、每次写入都要修一遍（噪音 + 假象）。
        // 索引是**派生物**（文件才是唯一真源），把投影改回与真源一致是安全动作。
        // ── 【L-5】启动期折平：日志重放过就写回整份快照 ─────────────────────
        // 为什么只在 verify 档做：写事务里那档（verify:false）每写一条就跑一次 load，
        // 折平会让它每条都付一份整份快照的钱 —— 那就白改了。
        // 为什么必须有：折平之后，盘上**任何时刻**都是"单一快照"形态 ⇒ 拔电不会留下难懂状态，
        // 回滚旧代码也只需先跑一次加载（见 scripts/compact-index.mjs）。
        if (verify && applied !== 0) {
            try {
                this.writeSnapshot(this.index);
            }
            catch (error) {
                this.indexLogEvents.push(`${new Date().toISOString()} 启动期折平失败（保留日志，下次再试）: ${String(error).slice(0, 80)}`);
            }
        }
        // 尽力而为：只读介质写不动 ⇒ 保留内存内修正 + 已有留痗，⛔ 不因此阻断加载。
        if (this.repairedThisLoad) {
            this.repairedThisLoad = false;
            try {
                this.saveIndex();
            }
            catch (error) {
                this.indexMergeEvents.push(`${new Date().toISOString()} 自愈落盘失败（保留内存内修正）: ${String(error).slice(0, 80)}`);
            }
        }
        return parsed;
    }
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
    indexStamp = null;
    /** load 时的内存索引快照，用于三路合并判"哪些是本次动过的" */
    indexBaseline = null;
    /** 合并事件（供 /selftest 暴露）：外部修正被保住时要被看见，不许静默 */
    indexMergeEvents = [];
    /** 读索引合并事件（≤10 条，最近在后） */
    getIndexMergeEvents() { return this.indexMergeEvents; }
    /** 【L-5】增量日志现状（进 /selftest 出口：待折平记录数与最老一条的年龄） */
    indexLogStatus() {
        let pendingRecords = 0;
        try {
            const raw = fs.readFileSync(this.deltaLogPath, 'utf-8');
            pendingRecords = raw.split('\n').filter(Boolean).length;
        }
        catch {
            pendingRecords = 0;
        }
        return {
            pendingRecords,
            oldestAgeMs: this.logFirstAt === null ? null : Date.now() - this.logFirstAt,
            snapshotHash: this.snapshotHash,
        };
    }
    statIndex() {
        try {
            const st = fs.statSync(path.join(this.root, 'index.json'));
            return { mtimeMs: st.mtimeMs, size: st.size };
        }
        catch {
            return null;
        }
    }
    /**
     * 校验索引契约，不完整直接抛错（fail-fast）。
     * @param verify true=附带逐条文件交叉校验（默认，见 load() 的两档说明）；false=只校验索引自身
     */
    validate(index, verify = true, repairProjection = false) {
        this.projectionDrift = [];
        this.dataMissing = [];
        this.legacyMissing = [];
        this.checksumMismatch = [];
        this.checksumVerified = 0;
        this.checksumUnverifiable = 0;
        const projectionDrift = this.projectionDrift;
        const dataMissing = this.dataMissing;
        const legacyMissing = this.legacyMissing;
        if (!index.schema?.startsWith('harness-memory-container/')) {
            throw new Error(`[memory-container] 未知 schema: ${index.schema}`);
        }
        if (!Array.isArray(index.entries)) {
            throw new Error('[memory-container] entries 缺失或不是数组');
        }
        // ⚠️ **entries 允许为空数组**（2026-10-06 · S1 补）。
        //
        // 这条与下面 hot_order 那条**是同一个判据**，2026-09-15 收尾轮改了 hot_order、
        // 漏了 entries。而 entries 是同一类问题：
        //   · 合法操作可以把 entries 缩到空 —— 删掉最后一条记忆；
        //   · 此后**每一次 load 都抛错**，容器被自己的校验写死，重启不能自愈；
        //   · 对全新用户（空库）等于插件直接不可用 —— 审计报告把「空库启动」
        //     列在最低闭环第一条，正是这条路径。
        //
        // 判据与 hot_order 对齐：**类型必须是数组**（防缺失 / 配错目录），
        // 但**空数组是合法状态**（含义＝当前没有记忆）。
        // 「该不该有内容」是使用状态，不是数据损坏 —— 不能把"库是空的"伪装成"库坏了"。
        //
        // hot_order 必须存在（persona 注入依赖它）。
        //
        // ⚠️ **允许为空数组**（2026-09-15 收尾轮修正）。
        // 原实现要求「非空」，本意是防「配错了导致 persona 静默丢失」，
        // 但**合法操作可以把 hot_order 缩到空**：`forget` 掉唯一的常驻条目、
        // 或 `update` 时新版本不满足常驻条件。此时索引被写盘成 `hot_order: []`，
        // 之后**每一次 load 都抛错**——容器被自己的校验写死，且重启不能自愈。
        // 实测复现见收尾轮记录：forget 唯一 hot 条目 → 后续 remember 与重启加载双双失败。
        //
        // 现在的判据：**类型必须是数组**（防缺失/配错），但**空数组是合法状态**
        // （含义＝当前没有常驻记忆）。「该不该有 persona」是配置问题（`injectPersona`），
        // 不该由记忆内容的状态来断言——那是把配置错误伪装成数据损坏。
        if (!Array.isArray(index.hot_order)) {
            throw new Error('[memory-container] hot_order 缺失或不是数组，无法注入 persona');
        }
        // 校验条目字段与文件存在性 + 路径必须留在容器根目录内
        const byId = new Map();
        const validLayers = new Set(['hot', 'archive', 'longterm', 'pending']);
        for (const entry of index.entries) {
            if (typeof entry.id !== 'string' || entry.id.length === 0) {
                throw new Error('[memory-container] 存在缺失 id 的条目');
            }
            if (byId.has(entry.id)) {
                throw new Error(`[memory-container] 条目 id 重复: ${entry.id}`);
            }
            if (!validLayers.has(entry.layer)) {
                throw new Error(`[memory-container] 条目 layer 非法: ${entry.id} (${entry.layer})`);
            }
            if (!Array.isArray(entry.tags) || !entry.tags.every((tag) => typeof tag === 'string')) {
                throw new Error(`[memory-container] 条目 tags 必须是字符串数组: ${entry.id}`);
            }
            byId.set(entry.id, entry);
            if (typeof entry.file !== 'string' || entry.file.length === 0) {
                throw new Error(`[memory-container] 条目缺少 file 字段: ${entry.id}`);
            }
            // ↓↓↓ 以下四项是唯一需要文件 I/O 的部分（也是 94.2% 写入开销的来源）：
            //     路径越界、文件存在性、文件可解析、索引与文件的 id/layer 一致。
            //     快档跳过它们，理由见 load() 注释。
            if (!verify)
                continue;
            const filePath = this.resolveInside(entry.file);
            if (!fs.existsSync(filePath)) {
                // ── 【Ledger · L-1】崩溃自愈 ───────────────────────────────────
                // 场景（真 SIGKILL 实测，3/3 复现）：写事务里"文件已移动、索引未提交"处被打断
                // ⇒ 索引仍说 `pending/p01.md`，文件其实已经在 `longterm/p01.md`
                // ⇒ 修复前**启动期直接 fail-fast，插件打不开**（不是慢，是起不来）。
                // 判据（`scripts/crash-recovery.mjs`）：子进程在窗口内被杀 → 重启**可恢复**、不阻断加载，且**留痕**。
                // 边界：只在**按 id 找得回**时才自愈；找不回 = 真丢了，照旧 fail-fast（⛔ 不许把数据丢失粉饰成"已修复"）。
                const found = this.findEntryFileById(entry.id, path.basename(entry.file));
                if (found && found !== entry.file) {
                    const layer = found.split('/')[0];
                    this.repairEvents.push(`${new Date().toISOString()} 崩溃自愈：${entry.id} 索引说 ${entry.file}（不存在），实际在 ${found} ⇒ 已回正索引（layer=${layer}）`);
                    if (this.repairEvents.length > 10)
                        this.repairEvents.shift();
                    entry.file = found;
                    entry.layer = layer;
                    this.repairedThisLoad = true;
                    this.structuralDirty = true; // 【L-5】结构修复 ⇒ 只能整份写，别走增量
                    continue; // 自愈成功：不再抛，让容器起得来
                }
                throw new Error(`[memory-container] 条目文件缺失: ${entry.file} (${entry.id})`);
            }
            const parsedFile = this.parseEntryFile(fs.readFileSync(filePath, 'utf-8'));
            // ── 【V1.3-A · G3】正文完整性校验（复用这一趟读盘 ⇒ **零额外 I/O**）──────────
            // 只报不拦：容器不能被自己的校验写死（2026-09-15 hot_order 空数组、
            // 2026-10-06 entries 空容器，两次都是"校验太严 ⇒ 起不来"）。
            const checksumVerdict = verifyChecksum(parsedFile.frontmatter.checksum, parsedFile.content);
            if (checksumVerdict === 'ok') {
                this.checksumVerified += 1;
            }
            else if (checksumVerdict === 'unverifiable') {
                // 旧格式（v3:）或空值 ⇒ **不算通过也不算失败**，单独计数。⛔ 不许混进"通过"里。
                this.checksumUnverifiable += 1;
            }
            else {
                this.checksumMismatch.push(`${entry.id}（记录=${parsedFile.frontmatter.checksum || '(空)'} 实算=${computeChecksum(parsedFile.content)}）`);
            }
            if (parsedFile.frontmatter.id && parsedFile.frontmatter.id !== entry.id) {
                throw new Error(`[memory-container] 索引与条目文件 id 不一致: ${entry.id} / ${parsedFile.frontmatter.id}`);
            }
            if (parsedFile.frontmatter.layer !== entry.layer) {
                throw new Error(`[memory-container] 索引与条目文件 layer 不一致: ${entry.id}`);
            }
            // ── 投影对账（2026-10-07 加；V1.3-A · G1 改为**注册表驱动的单一判据**）──────
            // 【为什么加】首次全量对账（scripts/drift-audit.mjs）抓到 18 处索引投影与唯一真源不符：
            //   l-e01…l-e09 的 tags 少了 `h01`（按 h01 检索这九条命中不了 —— 真·漏召）、
            //   h01…h09 的 updated 停在 8 月（/list 显示陈旧）。
            //   **223 项测试 + 本函数一条都没报** —— 因为上面只查 id / layer / 文件存在性，
            //   **不查 title / summary / updated / tags**。这就是闸门的覆盖边界。
            //
            // 【为什么只计数、不抛错】容器不能被自己的校验写死。
            //   2026-09-15 hot_order 空数组、2026-10-06 entries 空容器，两次都是"校验太严 ⇒ 起不来"。
            //   投影不符不是结构性损坏（容器能正常读写），它是**派生视图陈旧**，
            //   该由对账脚本按"文件是唯一真源"回正（scripts/repair-index-projection.mjs），
            //   闸门负责**看见**它、不负责拦截它。
            // 【为什么零额外 I/O】frontmatter 上面已经解析出来了，这里只是内存比对。
            //
            // 【2026-10-09 修正】原判据里有一句「单侧缺值 = 隐含默认，不是漂」——
            //   它把"旧条目"（**两侧都缺**）与"索引陈旧"（**文件有、索引没有**）当成了同一件事，
            //   于是 `decay_type` / `source` / `scope` 这一整类真漂移被**静默放过**（开工前先红实测：
            //   删掉索引里的 `decay_type`，四个出口全哑）。现在判定只此一处实现：
            //   `contract/fields.ts` 的 `diffEntryFields()`，本函数只负责把它接到 load 上。
            const drifts = diffEntryFields(entry.id, entry, 
            // ⛔ 必须用 **raw**（文件里真写了什么），不是补过默认的 frontmatter：
            //    否则解析器补的 `scope='global'` 会被当成"文件里有"，造出假漂移；
            //    更糟的是它同时**掩盖**了"文件真写了 scope 但索引没有"这一类真漂移。
            (parsedFile.raw ?? parsedFile.frontmatter));
            for (const d of drifts) {
                const detail = `${d.id}.${d.field}（${d.kind} 索引=${JSON.stringify(d.fromIndex)?.slice(0, 30)} 文件=${JSON.stringify(d.fromFile)?.slice(0, 30)}）`;
                if (!REAL_DRIFT_KINDS.includes(d.kind)) {
                    if (d.kind === 'legacy-missing')
                        legacyMissing.push(detail);
                    else
                        dataMissing.push(detail);
                    continue;
                }
                // 检测与纠正分开：drift 信号永远保留（既有阳性对照的口径）；
                // scope/scope_id 因安全边界**总是**当场回正；其余 mirror 字段仅在 repairProjection=true 时回正
                // （插件启动传 true，写事务/探针默认 false，保留“看得见”的能力）。
                projectionDrift.push(detail);
                const mustRepair = d.field === 'scope' || d.field === 'scope_id' || repairProjection;
                if (mustRepair) {
                    const truth = (parsedFile.raw ?? parsedFile.frontmatter);
                    const want = truth[d.field];
                    const rec = entry;
                    const cur = rec[d.field];
                    if (want === undefined)
                        delete rec[d.field];
                    else
                        rec[d.field] = want;
                    this.repairedThisLoad = true;
                    if (this.repairEvents.length < 10) {
                        this.repairEvents.push(`${new Date().toISOString()} 投影按真源回正 ${d.id}.${d.field}（${d.kind}）：索引=${JSON.stringify(cur)?.slice(0, 24)} → 文件=${JSON.stringify(want)?.slice(0, 24)}`);
                    }
                }
            }
        }
        // hot_order 引用的 id 必须真实存在（否则 persona 会静默丢条目）
        for (const id of index.hot_order) {
            if (!byId.has(id)) {
                throw new Error(`[memory-container] hot_order 引用了不存在的条目: ${id}（索引与条目文件已脱节，请检查该 id 的 file 字段所指文件）`);
            }
        }
        // ── 【D3】常驻名单审计（非抛出；结果进 /selftest 与启动告警）──────────────
        this.hotAudit.length = 0;
        const hotIds = new Set(index.hot_order);
        for (const entry of index.entries) {
            if (entry.layer === 'hot' && !hotIds.has(entry.id)) {
                this.hotAudit.push(`掉线：${entry.id} 在 hot 层但不在 hot_order ⇒ 文件在、永不注入（只有名单算数）`);
            }
        }
        for (const id of index.hot_order) {
            const entry = byId.get(id);
            if (!entry)
                continue;
            if (entry.layer !== 'hot') {
                this.hotAudit.push(`跨层常驻：${id} 在名单里但 layer=${entry.layer}（合法，如实记录）`);
            }
            if (entry.valid_to || entry.expires) {
                this.hotAudit.push(`带到期边界：${id} valid_to=${entry.valid_to ?? '-'} expires=${entry.expires ?? '-'}（D2 会在到点时自动重算）`);
            }
        }
        if (new Set(index.hot_order).size !== index.hot_order.length) {
            throw new Error(`[memory-container] hot_order 存在重复条目: ${index.hot_order.filter((id, i) => index.hot_order.indexOf(id) !== i).join(', ')}`);
        }
        // 已废弃的条目不应继续常驻注入（纠正后旧版本必须退出 hot）
        const staleInHot = index.hot_order.filter((id) => {
            const entry = byId.get(id);
            return entry?.status === 'superseded';
        });
        if (staleInHot.length > 0) {
            throw new Error(`[memory-container] hot_order 残留已废弃条目: ${staleInHot.join(', ')}（其 superseded_by 指向的新版本应已原位继承槽位）`);
        }
        this.assertPendingConsistency(index);
    }
    /**
     * pending 目录一致性（2026-09-14 事故防复发 · 兜底层）：
     * index.json 登记为 pending 的条目，其文件必须落在 pending/ 目录内；反之 pending/ 目录下的
     * .md 文件必须全部被索引登记——否则说明有写入方「只写了文件没登记」或「只登记了没写文件」。
     */
    assertPendingConsistency(index) {
        const pendingDir = path.join(this.root, 'pending');
        for (const entry of index.entries) {
            if (entry.layer !== 'pending')
                continue;
            if (!entry.file.replace(/\\/g, '/').startsWith('pending/')) {
                throw new Error(`[memory-container] pending 条目文件路径非法: ${entry.id} → ${entry.file}（必须在 pending/ 目录内）`);
            }
        }
        if (!fs.existsSync(pendingDir))
            return;
        const onDisk = fs
            .readdirSync(pendingDir)
            .filter((name) => name.endsWith('.md'))
            .map((name) => `pending/${name}`);
        const indexed = new Set(index.entries.filter((entry) => entry.layer === 'pending').map((entry) => entry.file.replace(/\\/g, '/')));
        const orphans = onDisk.filter((file) => !indexed.has(file));
        if (orphans.length > 0) {
            throw new Error(`[memory-container] pending/ 存在未登记进 index.json 的文件: ${orphans.join(', ')}（写入方必须文件与索引联合提交）`);
        }
    }
    /**
     * 公开版本：writer / CLI 需要把相对路径解析成容器内的绝对路径（并做越界与符号链接校验）。
     */
    resolvePath(relPath) {
        return this.resolveInside(relPath);
    }
    /**
     * 确保层目录存在（v0.5 容器没有 pending/，首次写候选时必须自建）。
     * 只创建容器根目录下的直接子目录，且必须留在根目录内。
     */
    ensureLayerDir(layer) {
        const dirPath = this.resolveInside(layer);
        if (fs.existsSync(dirPath)) {
            if (!fs.statSync(dirPath).isDirectory()) {
                throw new Error(`[memory-container] 层路径被同名文件占用: ${layer}`);
            }
            return;
        }
        fs.mkdirSync(dirPath, { recursive: false, mode: 0o700 });
    }
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
    stampV12Fields(id, fields, options = {}) {
        const entry = this.entryMeta(id);
        if (!entry)
            return false;
        const filePath = this.resolveInside(entry.file);
        if (!fs.existsSync(filePath)) {
            throw new Error(`[memory-container] 条目文件缺失，无法回填: ${entry.file} (${id})`);
        }
        const parsed = this.parseEntryFile(fs.readFileSync(filePath, 'utf-8'));
        const fm = { ...parsed.frontmatter, ...fields };
        this.writeEntryFileVerified(filePath, fm, parsed.content);
        this.invalidateCache(id);
        Object.assign(entry, fields);
        if (options.saveIndex !== false)
            this.saveIndex();
        return true;
    }
    restoreIndex(snapshot) {
        this.index = snapshot;
        // ⚠️ 必须清 id→meta 缓存（2026-09-30，B2 修复的连带发现）：
        //   `entryMeta()` 的重建条件是「缓存条数 ≠ 索引条数」——而回滚时两边条数**相同**，
        //   条件永不成立 ⇒ 索引换了、缓存还是旧的 ⇒ 回滚"看着成功、读出来还是新值"。
        //   教训：按"条数"判断失效的缓存，只要新旧长度相等就会静默失效。
        this.byId.clear();
    }
    /**
     * 把容器内相对路径解析到根目录内；拒绝逃逸出根目录的路径（含 ../）。
     * 绝对路径不重锚定——读 voice.md 这类调用方传入的路径时按原样使用。
     */
    resolveInside(relPath) {
        const filePath = path.isAbsolute(relPath) ? relPath : path.resolve(this.root, relPath);
        const rootPrefix = path.resolve(this.root) + path.sep;
        if (filePath !== path.resolve(this.root) && !filePath.startsWith(rootPrefix)) {
            throw new Error(`[memory-container] 路径越界（必须在容器根目录内）: ${relPath}`);
        }
        // 字符串前缀检查挡不住容器内指向外部的符号链接；对已存在目标再做 realpath 校验。
        // 结果按绝对路径缓存（实测单次 realpathSync 0.0188ms，500 条就是 9ms——不能每条都做）。
        const cached = this.realPathCache.get(filePath);
        if (cached === null) {
            throw new Error(`[memory-container] 符号链接越界（目标必须在容器根目录内）: ${relPath}`);
        }
        if (cached === undefined) {
            if (!fs.existsSync(filePath)) {
                // 不存在：不做符号链接判定（调用方自己会处理缺失）
            }
            else {
                const realPath = fs.realpathSync(filePath);
                const realRootPrefix = this.realRoot + path.sep;
                if (realPath !== this.realRoot && !realPath.startsWith(realRootPrefix)) {
                    this.realPathCache.set(filePath, null); // 记住越界，重复访问直接抛
                    throw new Error(`[memory-container] 符号链接越界（目标必须在容器根目录内）: ${relPath}`);
                }
            }
            this.realPathCache.set(filePath, filePath);
        }
        return filePath;
    }
    getIndex() {
        if (!this.index)
            this.load();
        return this.index;
    }
    /** 按 hot_order 返回有序的 hot 条目元信息 */
    hotEntries() {
        const index = this.getIndex();
        const byId = new Map(index.entries.map((e) => [e.id, e]));
        return (index.hot_order ?? [])
            .map((id) => byId.get(id))
            .filter((e) => Boolean(e));
    }
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
    readEntry(id) {
        const entry = this.entryMeta(id);
        if (!entry)
            return null;
        const filePath = this.resolveInside(entry.file);
        let mtimeMs;
        try {
            mtimeMs = fs.statSync(filePath).mtimeMs;
        }
        catch {
            this.entryCache.delete(id);
            return null;
        }
        const cached = this.entryCache.get(id);
        if (cached && cached.mtimeMs === mtimeMs)
            return cached.file;
        // 【S2 · S2-C】mtime 失配 = 文件被**外部**改过（写路径会显式 `invalidateCache`，走不到这）
        // ⇒ 语料缓存里这个 id 的旧文档已经过期，标为不可信，下次 `corpus()` 退回整片重建。
        // 这是"正确性优先于性能"的那道兜底：⛔ 不许为了斜率把这个标记省掉。
        if (cached)
            this.corpusTrusted = false;
        const raw = fs.readFileSync(filePath, 'utf-8');
        const file = this.parseEntryFile(raw);
        this.entryCache.set(id, { mtimeMs, file });
        return file;
    }
    /** 失效单条缓存（写路径调用；外部改动由 mtime 比对兜底） */
    invalidateCache(id) {
        this.entryCache.delete(id);
        this.tokenCache.delete(id);
        this.byId.clear();
        // 【S2 · S2-C】只记脏，**不再整片作废语料缓存**——
        // 原来那句 `corpusCache = null` 就是写入 O(n) 的根：写一条 ⇒ 下一条写入重读整库。
        this.corpusDirtyIds.add(id);
        // 指纹备忘录不必清：它挂在**文档对象**上，重读会产出新对象，旧指纹自动失效。
    }
    /** 清空全部缓存（索引重建、批量操作后调用） */
    clearCache() {
        this.realPathCache.clear();
        this.entryCache.clear();
        this.tokenCache.clear();
        this.corpusCache = null;
        this.corpusDirtyIds.clear();
        this.corpusTrusted = true;
        this.dupIdx = null;
        this.byId.clear();
    }
    /**
     * 取条目的词频表与加权长度（带缓存）。
     *
     * `count` 由调用方注入（检索侧持有分词实现），container 不依赖检索模块。
     * mtime 变化即重算；写路径（invalidateCache）也会清它。
     */
    entryTokenStats(id, count) {
        const entry = this.entryMeta(id);
        if (!entry)
            return null;
        const filePath = this.resolveInside(entry.file);
        let mtimeMs;
        try {
            mtimeMs = fs.statSync(filePath).mtimeMs;
        }
        catch {
            this.tokenCache.delete(id);
            return null;
        }
        const cached = this.tokenCache.get(id);
        if (cached && cached.mtimeMs === mtimeMs)
            return { freq: cached.freq, length: cached.length };
        const file = this.readEntry(id);
        if (!file)
            return null;
        const stats = count(file.content, { title: entry.title, tags: entry.tags, summary: entry.summary });
        this.tokenCache.set(id, { mtimeMs, freq: stats.freq, length: stats.length });
        return stats;
    }
    /** 缓存诊断（日志/测试用） */
    cacheStats() {
        return { size: this.entryCache.size };
    }
    /**
     * 读取容器内的可选文件（如 voice.md）。
     * 相对路径基于容器根目录解析且不得越界；文件不存在返回 null，调用方自定兜底。
     */
    readOptionalFile(relPath) {
        const filePath = this.resolveInside(relPath);
        if (!fs.existsSync(filePath))
            return null;
        return fs.readFileSync(filePath, 'utf-8');
    }
    /** 按层位列出条目 */
    listByLayer(layer) {
        return this.getIndex().entries.filter((e) => e.layer === layer);
    }
    /** 解析条目文件：frontmatter + 正文 */
    parseEntryFile(raw) {
        const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
        if (!m) {
            throw new Error('[memory-container] 条目文件缺少 frontmatter');
        }
        const { frontmatter, raw: rawFm } = this.parseFrontmatter(m[1]);
        return { frontmatter, content: m[2].trim(), raw: rawFm };
    }
    // ── 内存索引操作原语（供 writer 组装事务；只改内存，落盘由 saveIndex 负责） ──
    /** 按 id 查索引条目（走映射，O(1)） */
    entryMeta(id) {
        const index = this.getIndex();
        if (this.byId.size !== index.entries.length)
            this.rebuildById();
        return this.byId.get(id) ?? null;
    }
    /** 重建 id → meta 映射（索引变更后调用） */
    rebuildById() {
        this.byId = new Map(this.getIndex().entries.map((e) => [e.id, e]));
    }
    /**
     * 【Ledger · L-1】按 id 在四层目录里找回条目文件（崩溃自愈用）。
     * 认两种命名：新版 `<id>.md`，存量 `<id>_<title>.md`。
     * 找不到返回 null（⇒ 调用方照旧 fail-fast）。
     */
    findEntryFileById(id, preferredBasename) {
        const layers = ['hot', 'longterm', 'archive', 'pending'];
        // ① **先按原文件名找**（最精确的线索）：崩溃的形态是"文件被搬了层、名字没变"
        //    —— 索引说 `pending/p01.md`，文件其实在 `longterm/p01.md`。同名优先，
        //    才不会被"同 id 的另一个文件"劫走（比如历史遗留的重名残留）。
        // ⚠️ 不加这一遍的话，下面那遍扫描是**按层序瞎挑**的：longterm 排在 archive 前面，
        //    就会把一个诱饵文件认成真身 —— 自愈修错地方比不修更糟（静默修错 = 我们最怕的形态）。
        if (preferredBasename) {
            for (const layer of layers) {
                if (fs.existsSync(path.join(this.root, layer, preferredBasename)))
                    return `${layer}/${preferredBasename}`;
            }
        }
        // ② 再按 id 扫（存量改名等情形）：认 `<id>.md` 与 `<id>_<title>.md`
        for (const layer of layers) {
            let names = [];
            try {
                names = fs.readdirSync(path.join(this.root, layer));
            }
            catch {
                continue;
            }
            const hit = names.find((n) => n === `${id}.md` || n.startsWith(`${id}_`));
            if (hit)
                return `${layer}/${hit}`;
        }
        return null;
    }
    /**
     * 索引指纹：由全部条目的 `id|file|updated` 拼成。
     *
     * 用途：**语料级缓存的失效判据**。逐条比 mtime 的代价是 O(n) 次 statSync
     * （实测 2000 条 = 119ms，把缓存本身的价值吃光了）；指纹是纯内存计算，
     * 只要索引没变就不必再验每条文件——因为文件的变更必然先反映到索引上
     * （写入走容器、外部改动由 load() 重新对齐）。
     */
    indexFingerprint() {
        return indexFingerprintOf(this.getIndex());
    }
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
    corpus() {
        const fp = this.indexFingerprint();
        // ⚠️ 两个条件缺一不可（都是自测抓出来的真缺陷）：
        //   ① `corpusTrusted` —— 外部改动可能只动文件、不动索引（那时指纹不变），
        //      `readEntry` 的 mtime 失配会把它置 false。若只比指纹，这一支会返回陈旧语料。（S2-C③）
        //   ② `corpusDirtyIds.size === 0` —— **写一条也可能不改指纹**：墓碑/改文当天 `updated`
        //      与原值同值，于是 `id|file|updated` 指纹纹丝不动，而正文已经换了。
        //      若只比指纹，这一支会拿旧正文顶（实测：忘掉的条目仍能被检索到）。（S2-C③ / S2-D④）
        if (this.corpusCache && this.corpusTrusted && this.corpusDirtyIds.size === 0 && this.corpusCache.fingerprint === fp) {
            return this.corpusCache.docs;
        }
        if (this.corpusCache && this.corpusTrusted) {
            const docs = this.corpusCache.docs;
            const live = new Set();
            for (const e of this.getIndex().entries)
                live.add(e.id);
            let changed = false;
            for (const id of [...docs.keys()]) { // ① 已移出索引
                if (live.has(id))
                    continue;
                const old = docs.get(id);
                if (old)
                    this.dupIndexRemove(id, old);
                docs.delete(id);
                changed = true;
            }
            for (const id of this.corpusDirtyIds) { // ② 自己写过的
                const old = docs.get(id);
                const file = this.readEntry(id);
                if (file) {
                    if (old)
                        this.dupIndexRemove(id, old);
                    docs.set(id, file);
                    this.dupIndexAdd(id, file);
                    changed = true;
                }
                else if (old) {
                    this.dupIndexRemove(id, old);
                    docs.delete(id);
                    changed = true;
                }
            }
            this.corpusDirtyIds.clear();
            for (const id of live) { // ③ 新增的
                if (docs.has(id))
                    continue;
                const file = this.readEntry(id);
                if (file) {
                    docs.set(id, file);
                    this.dupIndexAdd(id, file);
                    changed = true;
                }
            }
            if (changed)
                this.corpusGeneration += 1;
            this.corpusCache = { fingerprint: fp, docs };
            return docs;
        }
        // 兜底：整片重建（首次调用 / 检测到外部改动）
        const docs = new Map();
        for (const e of this.getIndex().entries) {
            const file = this.readEntry(e.id);
            if (file)
                docs.set(e.id, file);
        }
        this.corpusDirtyIds.clear();
        this.corpusTrusted = true;
        this.corpusCache = { fingerprint: fp, docs };
        this.corpusGeneration += 1;
        this.dupIdx = null; // 全量重建 ⇒ 判重索引作废，下次 dupIndex() 重建（懒建，O(n) 一次）
        return docs;
    }
    /** 【S2 追刀】判重索引的懒建（第一次用到时建一次，此后随语料增量维护） */
    dupIndex() {
        if (this.dupIdx)
            return this.dupIdx;
        const idx = { byFp: new Map(), byTitle: new Map() };
        for (const [id, doc] of this.corpus())
            this.dupIndexAdd(id, doc, idx);
        this.dupIdx = idx;
        return idx;
    }
    /** 加一条到判重索引（`doc` 的指纹走 `contentFpOf` 的对象级记忆化，不重算） */
    dupIndexAdd(id, doc, target = this.dupIdx) {
        const idx = target ?? this.dupIdx;
        if (!idx)
            return;
        const fp = this.contentFpOf(doc);
        const fpList = idx.byFp.get(fp);
        if (fpList) {
            if (!fpList.includes(id))
                fpList.push(id);
        }
        else
            idx.byFp.set(fp, [id]);
        const tk = dupTitleKey(doc.frontmatter.title, doc.frontmatter.decay_type);
        const tList = idx.byTitle.get(tk);
        if (tList) {
            if (!tList.includes(id))
                tList.push(id);
        }
        else
            idx.byTitle.set(tk, [id]);
    }
    /** 从判重索引里摘掉一条（增删/改文都要摘，否则会留幽灵命中） */
    dupIndexRemove(id, doc) {
        const idx = this.dupIdx;
        if (!idx)
            return;
        const fp = this.contentFpOf(doc);
        const fpList = idx.byFp.get(fp);
        if (fpList) {
            const next = fpList.filter((x) => x !== id);
            if (next.length)
                idx.byFp.set(fp, next);
            else
                idx.byFp.delete(fp);
        }
        const tk = dupTitleKey(doc.frontmatter.title, doc.frontmatter.decay_type);
        const tList = idx.byTitle.get(tk);
        if (tList) {
            const next = tList.filter((x) => x !== id);
            if (next.length)
                idx.byTitle.set(tk, next);
            else
                idx.byTitle.delete(tk);
        }
    }
    /**
     * 语料版本串：**索引指纹 + 代数**。给检索侧当缓存失效判据（见 `search.ts` 的 CORPUS_CACHE）。
     * 为什么不能只给索引指纹：外部改文件不改索引时指纹不变，而语料已经换过一代。
     */
    corpusVersion() {
        return `${this.indexFingerprint()}#${this.corpusGeneration}`;
    }
    /**
     * 内容指纹备忘录：键是**条目文件对象本身**（WeakMap）。
     *
     * 为什么用对象当键：`parseEntryFile` 每次都返回**新对象**，所以"对象没换"就等价于
     * "内容没变"——旧指纹随对象一起被 GC，**不需要任何失效逻辑**，也就没有"漏失效"这个坑。
     * 这是把判定实验里那 42% 的"逐条重算指纹"（0.0249 ms/条）干掉的那一刀。
     */
    contentFpOf(doc) {
        const hit = this.fpMemo.get(doc);
        if (hit !== undefined)
            return hit;
        const fp = contentFingerprint(doc.content);
        this.fpMemo.set(doc, fp);
        return fp;
    }
    /** 内部：不走语料缓存地读一条（供 corpus() 构建时使用，避免递归） */
    readEntryUncached(id) {
        const entry = this.entryMeta(id);
        if (!entry)
            return null;
        const filePath = this.resolveInside(entry.file);
        if (!fs.existsSync(filePath))
            return null;
        return this.parseEntryFile(fs.readFileSync(filePath, 'utf-8'));
    }
    /**
     * 从既有 id 生成下一个可用 id（同层前缀序号 +1），不修改任何状态。
     *
     * 【P0 修复 · 2026-10-19】序号必须同时避开**盘上的孤儿文件**：
     * 修前只按索引算 ⇒ `addEntryFile` 先写文件、后登记索引，崩在中间就留下
     * `longterm/l02.md`（不在索引里）；下次 nextSeq 仍给 l02 ⇒ addEntryFile 撞
     * 「条目文件已存在，拒绝覆盖」⇒ **此后再也写不进 longterm**（旧审核 24-4 升级）。
     * 现在把该层目录里已存在的 `<前缀><数字>.md` 也计入上限 —— 孤儿仍在，但不再阻断写入。
     */
    nextEntryId(layer) {
        const ids = this.getIndex().entries.map((e) => e.id);
        const prefix = layer === 'pending' ? 'p' : layer === 'hot' ? 'h' : layer === 'longterm' ? 'l' : 'a';
        try {
            for (const name of fs.readdirSync(path.join(this.root, layer))) {
                const m = name.match(new RegExp(`^${prefix}(\\d+)\\.md$`));
                if (m)
                    ids.push(`${prefix}${m[1]}`);
            }
        }
        catch { /* 层目录不存在：没有孤儿可避 */ }
        return buildEntryId(layer, nextSeq(ids, layer));
    }
    /**
     * 构造并原子写入一个新条目文件，同时登记内存索引。
     * 只做「路径解析 + 序列化 + 落盘 + 登记」，不做任何业务判断；业务规则在 writer。
     */
    /** 【P0-6】回填/刷新派生字段（只改索引，不碰文件） */
    stampSessionDerived(id, has, kind) {
        const meta = this.getIndex().entries.find((e) => e.id === id);
        if (!meta)
            return false;
        meta.has_session = has;
        meta.session_kind = kind;
        this.markIndexDirty(id);
        return true;
    }
    addEntryFile(input) {
        const index = this.getIndex();
        if (index.entries.some((e) => e.id === input.id)) {
            throw new Error(`[memory-container] 条目 id 已存在: ${input.id}`);
        }
        const dir = input.layer;
        // 【S1 · P1-8】文件名只用 id，**不再拼标题**。
        //
        // 原来写 `${id}_${safeTitle(title)}.md`：标题兜底取自正文，于是敏感事实
        // 会留在**文件名**里 —— 审计 P1-8 的样本连文件名都是原敏感标题生成的，
        // 删了正文也还在。id 已经是唯一且稳定的身份，文件名不需要再背内容。
        // 存量文件不强制改名（改名要动索引与全部引用，风险不值当）：索引里存的是 file 字段，
        // 两种命名可以共存；扫描报告见 scripts/scan-title-leaks.mjs。
        const fileName = `${input.id}.md`;
        const relPath = `${dir}/${fileName}`;
        const filePath = this.resolveInside(relPath);
        // 层目录可能还不存在：v0.5 容器没有 pending/，V1.0 首次写候选必须能自建，
        // 否则「写不进候选区」会让模型侧的推断静默丢失。
        this.ensureLayerDir(dir);
        if (fs.existsSync(filePath)) {
            throw new Error(`[memory-container] 条目文件已存在，拒绝覆盖: ${relPath}`);
        }
        // 【V1.3-A · G3】写入即算：**凡是改动了正文的写路径都要算**（新建 / 内容补丁）。
        // ⛔ `stampV12Fields`（路由 touch）**不算** —— 否则"改正文 + touch 一下"就能把
        //    篡改痕迹洗白，校验和当场失去证据价值（见 src/checksum.ts 的三条纪律）。
        const frontmatter = { ...input.frontmatter, checksum: computeChecksum(input.content) };
        this.writeEntryFileVerified(filePath, frontmatter, input.content);
        const meta = {
            id: input.id,
            layer: input.layer,
            title: input.frontmatter.title,
            // 【P0-6】写入时计算：存在性 + 可信度（⛔ 不把 source_session 本身写进索引）
            has_session: Boolean(input.frontmatter.source_session),
            session_kind: classifySessionKind(input.frontmatter.source_session),
            file: relPath,
            tags: [...input.frontmatter.tags],
            priority: input.frontmatter.priority,
            updated: input.frontmatter.updated,
            status: input.frontmatter.status,
            summary: input.frontmatter.summary,
            memory_type: input.frontmatter.memory_type,
            version: input.frontmatter.version,
            idem_key: input.frontmatter.idem_key,
            // scope 族 + 有效期 + 替代链进索引：/list 据此判可见性与时间状态，
            // 避免逐条读文件（压测评审清单 #2；2000 条时原实现 1645ms）
            scope: input.frontmatter.scope,
            scope_id: input.frontmatter.scope_id,
            valid_from: input.frontmatter.valid_from,
            valid_to: input.frontmatter.valid_to,
            expires: input.frontmatter.expires,
            superseded_by: input.frontmatter.superseded_by,
            deleted_at: input.frontmatter.deleted_at,
            deleted_by: input.frontmatter.deleted_by,
            delete_reason: input.frontmatter.delete_reason,
            operator: input.frontmatter.operator,
            operation: input.frontmatter.operation,
            confirmed_at: input.frontmatter.confirmed_at,
            confirmed_by: input.frontmatter.confirmed_by,
            // ── V1.2 五字段进索引（2026-10-03 接线）─────────────────────────
            // 为什么必须进索引：**路由打分读的是 entryMeta(id).decay_type，不是条目文件**。
            // 只写进文件 = 接线只接了一半 —— 路由永远读到 undefined，
            // 而且这种"看起来接好了"的假象正是 V1.2 当年栽的那个坑。
            decay_type: input.frontmatter.decay_type,
            last_accessed: input.frontmatter.last_accessed,
            access_count: input.frontmatter.access_count,
            lifecycle: input.frontmatter.lifecycle,
            cold_start_until: input.frontmatter.cold_start_until,
        };
        // ── 【V1.3-A · G1 追刀】按注册表把**其余必须镜像**的字段一次补齐 ────────────
        // 上面那份手写清单漏了 `source`，后果实测（2026-10-09 最小重现）：
        //   **每写一条新记忆就造一处索引陈旧**（文件有、索引没有），
        //   而旧的 8 字段投影表里没有 `source` ⇒ 看不见。梯子（drift-ladder）一跑就是 24/44 处。
        // 修法不是"补上 source 这一个字段"——那还是手写清单，下次照样漏。
        // 这里改成**从注册表补齐**（`MIRROR_FIELD_NAMES` 是全仓唯一一处"哪些字段必须镜像"的声明）：
        // 只填**上面没写到的**，所以不会覆盖 tags 的拷贝语义等既有行为。
        {
            const metaRec = meta;
            const fmRec = input.frontmatter;
            for (const name of MIRROR_FIELD_NAMES) {
                if (metaRec[name] === undefined && fmRec[name] !== undefined)
                    metaRec[name] = fmRec[name];
            }
        }
        index.entries.push(meta);
        this.markIndexDirty(meta.id); // 【L-5】新增 ⇒ 记进增量（entry_count 也随增量带）
        return meta;
    }
    /** 用最新 frontmatter 同步内存索引条目元信息（供 update/forget 之后调用） */
    syncEntryMeta(id, patch) {
        const meta = this.entryMeta(id);
        if (meta) {
            Object.assign(meta, patch);
            this.markIndexDirty(id); // 【L-5】投影变了 ⇒ 记进增量
        }
    }
    /** 从内存索引移除条目（purge 用；默认墓碑路径不调用它） */
    removeEntryMeta(id) {
        const index = this.getIndex();
        const at = index.entries.findIndex((e) => e.id === id);
        if (at < 0)
            return false;
        index.entries.splice(at, 1);
        this.removedIds.add(id); // 【L-5】删了 ⇒ 增量里要带"删了谁"
        this.dirtyIds.delete(id);
        return true;
    }
    /** 重算 entry_count（写后自检用） */
    recountEntries() {
        const index = this.getIndex();
        index.entry_count = index.entries.length;
        return index.entry_count;
    }
    /** index.json 中登记的总条目数（含 pending） */
    totalEntries() {
        return this.getIndex().entries.length;
    }
    /**
     * hot_order 槽位迁移（memory_update 专用，三条判定见 TechDoc §7）：
     *   a. old ∈ hot 且 new 满足常驻 → new 原位继承旧槽位，删除 old
     *   b. old ∈ hot 但 new 不满足常驻 → 两版一并剔除
     *   c. old ∉ hot → 不触碰
     * 返回迁移快照，供调用方写日志。
     */
    migrateHotSlot(oldId, newId, newQualifies) {
        const index = this.getIndex();
        const before = [...index.hot_order];
        const at = before.indexOf(oldId);
        if (at < 0) {
            return { before, after: before, removed: [], added: [] };
        }
        if (newQualifies && !before.includes(newId)) {
            index.hot_order.splice(at, 1, newId);
            this.markHotOrderDirty(); // 【L-5】hot_order 很小，增量带得动
            return { before, after: [...index.hot_order], removed: [oldId], added: [newId] };
        }
        index.hot_order = before.filter((id) => id !== oldId && id !== newId);
        this.markHotOrderDirty(); // 【L-5】hot_order 很小，增量带得动
        return { before, after: [...index.hot_order], removed: [oldId], added: [] };
    }
    /** 把 id 追加进 hot_order（opinion 直写路径与候选转正路径共用；已存在则原位保留） */
    appendHotOrder(id) {
        const index = this.getIndex();
        const before = [...index.hot_order];
        if (!before.includes(id)) {
            index.hot_order.push(id);
            // ⛔【F · 2026-10-15】**必须标脏** —— 增量记录只在标脏时才带 `hot_order`
            //   （`...(this.hotOrderDirty ? { hot_order: index.hot_order } : {})`）。
            //   漏了它 ⇒ 名单改动**进不了增量日志** ⇒ 重载时被旧快照的名单覆盖回来。
            //   同类的 `migrateHotSlot` 一直有这一行，这两个方法**漏了**（实测抓到：`l73` 的剔除丢写）。
            this.markHotOrderDirty();
        }
        return {
            before,
            after: [...index.hot_order],
            removed: [],
            added: before.includes(id) ? [] : [id],
        };
    }
    /** 从 hot_order 物理剔除（forget 与 discard 必须调用，不能只靠 temporal 过滤） */
    removeFromHotOrder(id) {
        const index = this.getIndex();
        const before = [...index.hot_order];
        const after = before.filter((candidate) => candidate !== id);
        index.hot_order = after;
        // ⛔【F · 2026-10-15】**必须标脏**（理由同 `appendHotOrder`）——
        //   漏了它 ⇒ "迁出 hot 就剔名单"在内存里成立、**落盘时丢掉** ⇒ 重载后名单把退场又推翻。
        if (before.length !== after.length)
            this.markHotOrderDirty();
        return { before, after, removed: before.includes(id) ? [id] : [], added: [] };
    }
    /** hot_order 指针一致性快照（P1 出口条件：必须为空） */
    hotOrderConsistency() {
        const index = this.getIndex();
        const problems = [];
        const byId = new Map(index.entries.map((e) => [e.id, e]));
        for (const id of index.hot_order) {
            const entry = byId.get(id);
            if (!entry) {
                problems.push(`${id}: 条目不存在`);
                continue;
            }
            // ⛔【F 投递权威表 · 2026-10-15】可投递层**只有 `hot` 与 `longterm`**。
            //   修前这里**明确允许 `archive`** ⇒ "进了退场层却仍挂每轮必投"**判不出来**（实测：`l73`）。
            //   出口规则：**迁出可投递层 ⇒ 必须剔名单**（`writer.relocate` 已联动；2026-10-15 补上漏写盘）。
            if (!['hot', 'longterm'].includes(entry.layer)) {
                problems.push(`${id}: 已离开可投递层（layer=${entry.layer}）却仍在 hot_order —— 出口规则要求"迁出即剔名单"`);
            }
            if (entry.status === 'superseded') {
                problems.push(`${id}: 已被替代但仍在 hot_order`);
            }
        }
        return { ok: problems.length === 0, problems };
    }
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
    parseFrontmatter(block) {
        const out = {};
        let currentKey = null;
        let inArray = false;
        const arrayBuf = [];
        const flushArray = () => {
            if (currentKey && inArray) {
                out[currentKey] = arrayBuf
                    .join(' ')
                    .split(',')
                    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
                    .filter(Boolean);
                arrayBuf.length = 0;
                inArray = false;
            }
        };
        for (const line of block.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#'))
                continue;
            if (inArray) {
                const arrMatch = trimmed.match(/^-\s*(.+)$/);
                if (arrMatch) {
                    arrayBuf.push(arrMatch[1]);
                    continue;
                }
                flushArray();
            }
            const kv = trimmed.match(/^([\w-]+):\s*(.*)$/);
            if (!kv)
                continue;
            currentKey = kv[1];
            const val = kv[2].trim();
            if (val === '') {
                inArray = true;
                arrayBuf.length = 0;
            }
            else if (val.startsWith('[') && val.endsWith(']')) {
                try {
                    const parsed = JSON.parse(val);
                    out[currentKey] = Array.isArray(parsed) ? parsed.map(String) : [];
                }
                catch {
                    out[currentKey] = val
                        .slice(1, -1)
                        .split(',')
                        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
                        .filter(Boolean);
                }
            }
            else {
                // 写路径使用 JSON 字符串（合法 YAML 标量）保护冒号、方括号、换行等特殊字符。
                if (val.startsWith('"') && val.endsWith('"')) {
                    try {
                        out[currentKey] = JSON.parse(val);
                    }
                    catch {
                        out[currentKey] = val.slice(1, -1);
                    }
                }
                else {
                    out[currentKey] = val.replace(/^['"]|['"]$/g, '');
                }
            }
        }
        flushArray();
        // 类型收窄到契约
        const num = (v, fallback) => {
            const n = Number(v);
            return Number.isFinite(n) ? n : fallback;
        };
        if (out.scope != null && !['global', 'workspace', 'project'].includes(String(out.scope))) {
            throw new Error(`[memory-container] 条目 scope 非法: ${String(out.scope)}`);
        }
        return { frontmatter: this.narrowFrontmatter(out, num), raw: out };
    }
    /** `out`（原始键值）→ 契约类型。**默认值只在这里补**，⛔ 不往 `raw` 里写。 */
    narrowFrontmatter(out, num) {
        return {
            id: String(out.id ?? ''),
            layer: out.layer ?? 'archive',
            title: String(out.title ?? ''),
            source: String(out.source ?? ''),
            source_line: out.source_line != null ? String(out.source_line) : undefined,
            source_session: out.source_session != null ? String(out.source_session) : undefined,
            source_message: out.source_message != null ? String(out.source_message) : undefined,
            about: Array.isArray(out.about) ? out.about : undefined,
            deleted_source_session: out.deleted_source_session != null ? String(out.deleted_source_session) : undefined,
            deleted_source_message: out.deleted_source_message != null ? String(out.deleted_source_message) : undefined,
            created_at: out.created_at != null ? String(out.created_at) : undefined,
            scope: out.scope === 'workspace' || out.scope === 'project' ? out.scope : 'global',
            scope_id: out.scope_id != null ? String(out.scope_id) : undefined,
            tags: Array.isArray(out.tags) ? out.tags : [],
            priority: num(out.priority, 50),
            // 逐条注入形态（2026-09-30）。**加字段必须同时改两处**：
            // 这里（解析白名单）与 `src/types.ts` 的 EntryFrontmatter。
            // 漏了这里不会报错——字段被静默丢掉，行为退回 full，看起来"没生效"。
            // 这正是审计里"一处字段要改七处"那个坑的缩小版；V1.1 没有字段注册表，
            // 所以只能靠这条注释把人钉在这里。
            hot_mode: out.hot_mode === 'summary' ? 'summary' : 'full',
            updated: String(out.updated ?? ''),
            checksum: String(out.checksum ?? ''),
            summary: String(out.summary ?? ''),
            volume: out.volume != null ? String(out.volume) : undefined,
            chapter: out.chapter != null ? String(out.chapter) : undefined,
            expires: out.expires != null ? String(out.expires) : undefined,
            valid_from: out.valid_from != null ? String(out.valid_from) : undefined,
            valid_to: out.valid_to != null ? String(out.valid_to) : undefined,
            supersedes: Array.isArray(out.supersedes) ? out.supersedes : undefined,
            // 记忆演化闭环 v1（摊平标量，最小解析器兼容）
            type: out.type != null ? String(out.type) : undefined,
            confidence: num(out.confidence, 0),
            confidence_type: out.confidence_type != null ? String(out.confidence_type) : undefined,
            conf_source: num(out.conf_source, 0),
            conf_verify: num(out.conf_verify, 0),
            conf_recurrence: num(out.conf_recurrence, 0),
            conf_freshness: num(out.conf_freshness, 0),
            conflict_state: out.conflict_state != null ? String(out.conflict_state) : undefined,
            conflict_with: out.conflict_with != null ? String(out.conflict_with) : undefined,
            conflict_type: out.conflict_type != null ? String(out.conflict_type) : undefined,
            conflict_resolution: out.conflict_resolution != null ? String(out.conflict_resolution) : undefined,
            status: out.status != null ? String(out.status) : undefined,
            expired_reason: out.expired_reason != null ? String(out.expired_reason) : undefined,
            superseded_by: out.superseded_by != null ? String(out.superseded_by) : undefined,
            last_verified: out.last_verified != null ? String(out.last_verified) : undefined,
            // V1.0 新增字段（缺失即旧行为，旧容器零迁移）
            memory_type: out.memory_type != null && ['experience', 'world', 'opinion'].includes(String(out.memory_type))
                ? String(out.memory_type)
                : undefined,
            version: Number.isFinite(Number(out.version)) ? Number(out.version) : undefined,
            idem_key: out.idem_key != null ? String(out.idem_key) : undefined,
            deleted_at: out.deleted_at != null ? String(out.deleted_at) : undefined,
            deleted_by: out.deleted_by != null ? String(out.deleted_by) : undefined,
            delete_reason: out.delete_reason != null ? String(out.delete_reason) : undefined,
            operator: out.operator != null ? String(out.operator) : undefined,
            operation: out.operation != null && ['remember', 'update', 'forget', 'propose', 'confirm', 'discard', 'relocate'].includes(String(out.operation))
                ? String(out.operation)
                : undefined,
            confirmed_at: out.confirmed_at != null ? String(out.confirmed_at) : undefined,
            confirmed_by: out.confirmed_by != null ? String(out.confirmed_by) : undefined,
            // ── V1.2 五字段（2026-10-03 补）：与 serializeEntryFile 成对 ──────────
            // 白名单解析：非法值当"没有"，不猜、不修正（与 memory_type 同一口径）
            decay_type: out.decay_type != null && ['core', 'recent', 'process'].includes(String(out.decay_type))
                ? String(out.decay_type)
                : undefined,
            last_accessed: out.last_accessed != null ? String(out.last_accessed) : undefined,
            access_count: Number.isFinite(Number(out.access_count)) ? Number(out.access_count) : undefined,
            lifecycle: out.lifecycle === 'active' || out.lifecycle === 'archived'
                ? String(out.lifecycle)
                : undefined,
            cold_start_until: out.cold_start_until != null ? String(out.cold_start_until) : undefined,
        };
    }
    // ── 写路径（默认不启用；由插件 allowEdit 开关显式开启） ──────
    /**
     * 更新单条条目：合并 patch 到 frontmatter + 正文，原子写回条目文件，
     * 并同步更新内存中的 index（不落盘 index.json——saveIndex 负责落盘）。
     * 只改 patch 中出现的字段；不存在的 id 返回 false。
     */
    updateEntry(id, patch) {
        const index = this.getIndex();
        const entry = index.entries.find((e) => e.id === id);
        if (!entry)
            return false;
        const filePath = this.resolveInside(entry.file);
        if (!fs.existsSync(filePath)) {
            throw new Error(`[memory-container] 条目文件缺失，无法更新: ${entry.file} (${id})`);
        }
        const raw = fs.readFileSync(filePath, 'utf-8');
        const parsed = this.parseEntryFile(raw);
        // ── 合并 frontmatter ──
        const fm = { ...parsed.frontmatter };
        if (patch.title !== undefined)
            fm.title = patch.title;
        if (patch.tags !== undefined)
            fm.tags = [...patch.tags];
        if (patch.priority !== undefined)
            fm.priority = patch.priority;
        if (patch.summary !== undefined)
            fm.summary = patch.summary;
        // ── 状态机三字段（【C-0 · H6】）─────────────────────────────────────
        if (patch.status !== undefined) {
            // ⛔ 只有三个合法值 —— "陈旧"不是状态（它是 last_accessed 派生的观感），不许混进来
            if (!['active', 'expired', 'superseded'].includes(patch.status)) {
                throw new Error(`[memory-container] status 非法：${patch.status}（只接受 active/expired/superseded）`);
            }
            fm.status = patch.status;
        }
        if (patch.superseded_by !== undefined)
            fm.superseded_by = patch.superseded_by;
        if (patch.expires !== undefined)
            fm.expires = patch.expires;
        // ⭐【Lite ⑤ · 日界收口 · 2026-10-16】写 `updated` 必须走**唯一权威** `localDay()`。
        //   修前是 `new Date().toISOString().slice(0, 10)` = **UTC 日标签**，与用户的"今天"错开 8 小时
        //   （当地 00:00–08:00 写一次 ⇒ 落昨天的日期）。实测：固定瞬间 2026-10-17 00:30（上海）
        //   本行写的是 `2026-10-16`，而 `idem.today()` 同一瞬间给 `2026-10-17` ⇒ **两份"今天"**。
        //   判据：`test/updated-daykey.test.mjs`（修前退出码 1，修后 0）。
        fm.updated = localDay();
        const newContent = patch.content !== undefined ? patch.content.trim() : parsed.content;
        // 【V1.3-A · G3】正文变了 ⇒ **重算**校验和（原先是置空）。
        // 只有正文变才重算：非内容写入碰它，"改正文 + 改标题"两步就能洗白篡改痕迹。
        if (patch.content !== undefined)
            fm.checksum = computeChecksum(newContent);
        // ── 序列化并原子写回 ──
        const body = this.patchEntryFile(raw, fm, newContent, patch);
        this.atomicWrite(filePath, body);
        // 写后失效缓存：否则 readEntry 会返回陈旧正文（缓存键是 id，不看内容）
        this.invalidateCache(id);
        // ── 同步内存索引条目 ──
        entry.title = fm.title;
        entry.tags = fm.tags;
        entry.priority = fm.priority;
        entry.updated = fm.updated;
        entry.summary = fm.summary;
        // 状态机字段也要镜像进索引（契约里它们是 mirror ⇒ 索引必须同步，否则读路径看旧状态）
        if (patch.status !== undefined)
            entry.status = fm.status;
        if (patch.superseded_by !== undefined)
            entry.superseded_by = fm.superseded_by;
        if (patch.expires !== undefined)
            entry.expires = fm.expires;
        this.markIndexDirty(entry.id); // 【L-5】touch 的投影变了 ⇒ 记进增量
        return true;
    }
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
    updateEntryAndSaveIndex(id, patch) {
        const index = this.getIndex();
        const entry = index.entries.find((e) => e.id === id);
        if (!entry)
            return false;
        const entryPath = this.resolveInside(entry.file);
        const indexPath = this.resolveInside('index.json');
        const originalEntry = fs.readFileSync(entryPath, 'utf-8');
        const originalIndexFile = fs.readFileSync(indexPath, 'utf-8');
        const originalIndex = structuredClone(index);
        try {
            const updated = this.updateEntry(id, patch);
            if (!updated)
                return false;
            this.saveIndex();
            return true;
        }
        catch (error) {
            this.index = originalIndex;
            try {
                this.atomicWrite(entryPath, originalEntry);
                this.atomicWrite(indexPath, originalIndexFile);
            }
            catch (rollbackError) {
                throw new AggregateError([error, rollbackError], '[memory-container] 更新失败，且回滚未完整完成，请从备份检查容器');
            }
            throw error;
        }
    }
    /**
     * 把当前内存 index 落盘为 index.json（原子写）。
     * 调用方（插件 API）在完成一组写入后调用；不自动触发。
     *
     * 2026-10-07 起：写前做一次乐观锁检查（见 `indexStamp` 那段注释）——
     * 磁盘索引若被外部改过，**先三路合并再写**，否则外部修正会被这次写整片抹掉。
     */
    saveIndex() {
        const indexPath = path.join(this.root, 'index.json');
        const stamp = this.statIndex();
        // ── 乐观锁：磁盘被别人改过吗？────────────────────────────────
        if (this.indexStamp && stamp && (stamp.mtimeMs !== this.indexStamp.mtimeMs || stamp.size !== this.indexStamp.size)) {
            const disk = this.readIndexFileQuiet();
            if (disk && Array.isArray(disk.entries)) {
                const merged = mergeIndexThreeWay(this.getIndex(), disk, this.indexBaseline);
                // 合并会把磁盘上那份（可能带残留）带回来 ⇒ 同一个收口函数再抹一次
                stripFileOnlyFromIndex(merged);
                this.index = merged;
                this.indexMergeEvents.push(`${new Date().toISOString()} 检测到 index.json 被外部修改（mtime ${this.indexStamp.mtimeMs}→${stamp.mtimeMs}），已三路合并：磁盘 ${disk.entries.length} 条 / 内存 ${this.getIndex().entries.length} 条`);
                if (this.indexMergeEvents.length > 10)
                    this.indexMergeEvents.shift();
                // 【S2 · S2-C】外部改动已实锤 ⇒ 语料缓存不可信，下次 corpus() 整片重建
                this.corpusTrusted = false;
                // 【L-5】合并后磁盘上的快照不再是我们的基线 ⇒ 只能整份写。
                // ⛔ 走追加的话，记录里的 base 与磁盘快照对不上 ⇒ 下次 load 整份作废、这次改动丢。
                this.structuralDirty = true;
            }
        }
        const index = this.getIndex();
        index.generated_at = new Date().toISOString();
        index.entry_count = index.entries.length;
        // ── 【L-5】分流：写整份快照 还是 追加一条增量 ──────────────────────
        // 只有在"确定只动了少数条目、且盘上有可用基线快照"时才走追加；
        // 其余情形（顶层字段变了 / 增删 / 脏集合过大 / 日志过大 / 没有基线）一律整份写。
        const dirtyCount = this.dirtyIds.size + this.removedIds.size;
        const threshold = Math.max(32, Math.floor(index.entries.length / 10));
        const logBytes = this.logStamp?.size ?? 0;
        let snapshotBytes = 0;
        try {
            snapshotBytes = fs.statSync(indexPath).size;
        }
        catch { /* 首次落盘 */ }
        const logTooBig = snapshotBytes > 0 && logBytes > snapshotBytes * 0.2;
        // ⏱ 时间护栏：**必须有**。盘上的 `index.json` 是快照，追加期间它落后于真身；
        // 任何"直接读 index.json（不走 container.load）"的脚本会读到陈旧视图。
        // 折平的时机：启动期 load({verify:true}) ✓ ／ 尺寸超 20% ✓ ／ **最老一条超 5 分钟** ✓
        // ⇒ 陈旧窗口有上界（≤5 分钟或 ≤20% 体积），不是"跑到下次重启为止"。
        const logTooOld = this.logFirstAt !== null && Date.now() - this.logFirstAt > this.logMaxAgeMs;
        const canAppend = !this.structuralDirty && this.snapshotHash !== '' && dirtyCount > 0 &&
            dirtyCount <= threshold && !logTooBig && !logTooOld;
        if (!canAppend) {
            this.writeSnapshot(index);
            return;
        }
        this.appendDelta(index);
    }
    /** 【L-5】整份快照落盘（把日志折平、清零脏集合） */
    writeSnapshot(index) {
        const text = JSON.stringify(index, null, 2) + '\n';
        this.atomicWrite(path.join(this.root, 'index.json'), text);
        this.lastIndexRaw = text; // 【S2 追刀·二】留下原文，供下次 load() 做字节比较
        this.snapshotHash = MemoryContainer.hashText(text);
        // 快照落定 ⇒ 盘上的日志已无意义，清空（避免下次 load 重放旧记录）
        try {
            fs.writeFileSync(this.deltaLogPath, '', 'utf-8');
        }
        catch { /* 只读介质：下次 load 会因基线不符作废日志 */ }
        this.dirtyIds.clear();
        this.removedIds.clear();
        this.structuralDirty = false;
        this.hotOrderDirty = false;
        this.logFirstAt = null;
        this.logStamp = this.statLog();
        // 写后刷新基线：stamp 记磁盘现状，baseline 记"我刚写下去的这一版"
        this.indexStamp = this.statIndex();
        this.indexBaseline = JSON.parse(JSON.stringify(index));
    }
    /** 【L-5】把"这次动过的条目"追加成一行日志（写一次 ≈ 常数，与库大小无关） */
    appendDelta(index) {
        const byId = new Map(index.entries.map((e) => [e.id, e]));
        const set = [];
        for (const id of this.dirtyIds) {
            const e = byId.get(id);
            if (e)
                set.push(e);
        }
        const record = {
            base: this.snapshotHash, // 基线哈希：与快照对不上 ⇒ 这条日志作废
            at: index.generated_at,
            count: index.entry_count,
            set,
            del: [...this.removedIds],
            ...(this.hotOrderDirty ? { hot_order: index.hot_order } : {}),
        };
        fs.appendFileSync(this.deltaLogPath, JSON.stringify(record) + '\n', 'utf-8');
        if (this.logFirstAt === null)
            this.logFirstAt = Date.parse(index.generated_at) || Date.now();
        this.dirtyIds.clear();
        this.removedIds.clear();
        this.structuralDirty = false;
        this.hotOrderDirty = false;
        // ⛔ 【P2-4 修复 · 2026-10-19】这里**不许**清 logFirstAt：
        //   清掉后 `logTooOld` 每次都从 null 起算 ⇒ 5 分钟折平护栏永远不触发，
        //   进程长开时 index.json 可以无限期落后于 index.delta.jsonl（直接读快照的脚本看到旧层）。
        this.logStamp = this.statLog(); // ⚠️ 连日志时间戳一起更新，字节等价快路径要拿它比
        // ⚠️ **不**刷新 indexStamp / indexBaseline：磁盘上那份快照没动过 —— 刷新会让乐观锁失明
    }
    /**
     * 【L-5】重放增量日志：快照 + 日志 = 当前索引。
     * 基线哈希对不上（快照被别的通道改写过）⇒ **整份作废**，只信快照，并留痕。
     * 返回重放的记录数（-1 表示作废过）。
     */
    replayDeltaLog(parsed, snapshotText) {
        this.snapshotHash = MemoryContainer.hashText(snapshotText);
        const logPath = this.deltaLogPath;
        if (!fs.existsSync(logPath)) {
            this.logStamp = null;
            return 0;
        }
        let raw = '';
        try {
            raw = fs.readFileSync(logPath, 'utf-8');
        }
        catch {
            this.logStamp = null;
            return 0;
        }
        const lines = raw.split('\n').filter(Boolean);
        if (lines.length === 0) {
            this.logStamp = this.statLog();
            return 0;
        }
        const byId = new Map(parsed.entries.map((e) => [e.id, e]));
        this.logFirstAt = null;
        // 【P0 修复 · 2026-10-19】先**全量解析**再决定怎么应用：
        // 修前遇到第一条坏行就 `break`，后面的 `del` 记录被跳过 ⇒ 已删条目复活；
        // 而紧接着的 verify 加载又写快照把坏日志清掉 ⇒ 证据也没了（s3 沙箱实测）。
        const records = [];
        const salvageSets = [];
        let badLines = 0;
        let baseMismatch = false;
        for (const line of lines) {
            let rec;
            try {
                rec = JSON.parse(line);
            }
            catch {
                badLines++;
                continue;
            }
            // 不论基线对不对，先把 set 收进“按文件抢救”的候选：外部重写快照时，
            // 我们的增量日志会整份作废，但那些新增条目的**文件还在**，必须能补回来（S2-C④）。
            for (const e of rec.set ?? [])
                if (e && typeof e.id === 'string')
                    salvageSets.push(e);
            if (rec.base !== this.snapshotHash) {
                baseMismatch = true;
                continue;
            }
            records.push(rec);
        }
        const salvageByFiles = (reason) => {
            // 逐条按“文件是否存在”收回来：删掉的条目从索引里剔除，新增的按文件补回。
            // ⛔ 不凭坏日志凭空造条目（日志可能已被回滚）。
            let removed = 0;
            let added = 0;
            for (const [id, e] of [...byId]) {
                let exists = false;
                try {
                    exists = fs.existsSync(this.resolveInside(e.file));
                }
                catch {
                    exists = false;
                }
                if (exists)
                    continue;
                // 文件可能被搬到别的层（relocate 后索引没记上）⇒ 按 id 找回来
                const found = this.findEntryFileById(id, path.basename(e.file));
                if (found) {
                    e.file = found;
                    const layer = found.split('/')[0];
                    if (layer === 'hot' || layer === 'longterm' || layer === 'archive' || layer === 'pending')
                        e.layer = layer;
                }
                else {
                    byId.delete(id);
                    removed++;
                }
            }
            for (const e of salvageSets) {
                if (byId.has(e.id))
                    continue;
                let exists = false;
                try {
                    exists = fs.existsSync(this.resolveInside(e.file));
                }
                catch {
                    exists = false;
                }
                if (!exists)
                    continue;
                byId.set(e.id, e);
                added++;
            }
            parsed.entries = [...byId.values()];
            parsed.entry_count = parsed.entries.length;
            // 坏日志**保留成 .corrupt-<ts>**：修前 verify 折平会直接清掉它，等于销毁证据。
            const corruptPath = `${logPath}.corrupt-${Date.now()}`;
            try {
                fs.copyFileSync(logPath, corruptPath);
                this.indexLogEvents.push(`${new Date().toISOString()} 增量日志作废（${reason}）：已保留 ${path.basename(corruptPath)}；按文件重建（删 ${removed} / 补 ${added}）`);
            }
            catch (e) {
                this.indexLogEvents.push(`${new Date().toISOString()} 增量日志作废（${reason}）：坏日志备份失败 ${String(e).slice(0, 80)}；按文件重建（删 ${removed} / 补 ${added}）`);
            }
            if (this.indexLogEvents.length > 10)
                this.indexLogEvents.shift();
            // 抢救/重建只活在内存 ⇒ 必须整份写，否则下次 append 又只带一条。
            this.structuralDirty = true;
            this.logStamp = null;
            this.logFirstAt = null;
            return -1;
        };
        if (baseMismatch) {
            // 基线不符：整份作废，不做逐条应用（日志可能属于另一个快照）
            return salvageByFiles('基线哈希不符');
        }
        let applied = 0;
        for (const rec of records) {
            for (const id of rec.del ?? [])
                byId.delete(id);
            for (const e of rec.set ?? [])
                if (e && typeof e.id === 'string')
                    byId.set(e.id, e);
            if (typeof rec.count === 'number')
                parsed.entry_count = rec.count;
            if (Array.isArray(rec.hot_order))
                parsed.hot_order = rec.hot_order;
            if (rec.at)
                parsed.generated_at = rec.at;
            if (this.logFirstAt === null && rec.at)
                this.logFirstAt = Date.parse(rec.at) || Date.now();
            applied++;
        }
        if (badLines > 0) {
            // 坏行**跳过后继续应用**后面的有效记录（否则 del 记录被整段跳过 ⇒ 复活）；
            // 再按文件存在性兜底没解析到的那部分。
            return salvageByFiles(`有 ${badLines} 条无法解析的行`);
        }
        if (applied > 0) {
            parsed.entries = [...byId.values()];
            parsed.entry_count = parsed.entries.length;
        }
        this.logStamp = this.statLog();
        return applied;
    }
    readIndexFileQuiet() {
        try {
            return JSON.parse(fs.readFileSync(path.join(this.root, 'index.json'), 'utf-8'));
        }
        catch {
            return null;
        }
    }
    /** 序列化条目文件：frontmatter + 正文（字段顺序固定，缺失字段不输出） */
    serializeEntryFile(fm, content) {
        const lines = ['---'];
        const push = (key, value) => {
            if (value === undefined || value === '' || value === null)
                return;
            // 【S1 · P0-2 修复】标量与数组一律用 JSON 表示（JSON 是 YAML 的合法子集）。
            //
            // 为什么必须改：原实现是裸拼 `${key}: ${value}`。值里只要带换行，
            // 就会**在 frontmatter 里注入新的字段行**。实测注入路径：
            //   writer.ts 里 `summary = content.slice(0, 80)` —— 摘要取正文前 80 字，
            //   一段含 `id: daily-job` 的用户输入，写盘后文件解析出的 id 就变成 daily-job，
            //   而索引里是 l01 → 重启加载 fail-fast（"索引与条目文件 id 不一致"）。
            // 注意：不是"过滤 id:" 能解决的——任何字段行都能被注入，引号/多行同理。
            //
            // 为什么这次改动面很小：**解析侧早已按这个约定实现**（parseFrontmatter 里
            // "写路径使用 JSON 字符串（合法 YAML 标量）保护冒号、方括号、换行等特殊字符"），
            // patchEntryFile 也一直在用 JSON.stringify。本函数是唯一漏改的一条写路径。
            // 因此本次**不需要动解析器**，老文件（裸值）行为一字不变。
            lines.push(`${key}: ${JSON.stringify(value)}`);
        };
        push('id', fm.id);
        push('layer', fm.layer);
        push('title', fm.title);
        push('source', fm.source);
        push('source_line', fm.source_line);
        push('source_session', fm.source_session);
        push('source_message', fm.source_message);
        push('about', fm.about);
        push('deleted_source_session', fm.deleted_source_session);
        push('deleted_source_message', fm.deleted_source_message);
        push('created_at', fm.created_at);
        push('scope', fm.scope);
        push('scope_id', fm.scope_id);
        push('tags', fm.tags);
        push('priority', fm.priority);
        // 只在 summary 时写盘：不给存量条目增加噪声字段（缺省语义就是 full）
        if (fm.hot_mode === 'summary')
            push('hot_mode', fm.hot_mode);
        push('updated', fm.updated);
        push('checksum', fm.checksum);
        push('summary', fm.summary);
        push('volume', fm.volume);
        push('chapter', fm.chapter);
        push('expires', fm.expires);
        push('valid_from', fm.valid_from);
        push('valid_to', fm.valid_to);
        push('supersedes', fm.supersedes);
        // 记忆演化闭环 v1：序列化时保留摊平字段，避免写回丢失
        push('type', fm.type);
        push('confidence', fm.confidence);
        push('confidence_type', fm.confidence_type);
        push('conf_source', fm.conf_source);
        push('conf_verify', fm.conf_verify);
        push('conf_recurrence', fm.conf_recurrence);
        push('conf_freshness', fm.conf_freshness);
        push('conflict_state', fm.conflict_state);
        push('conflict_with', fm.conflict_with);
        push('conflict_type', fm.conflict_type);
        push('conflict_resolution', fm.conflict_resolution);
        push('status', fm.status);
        push('expired_reason', fm.expired_reason);
        push('superseded_by', fm.superseded_by);
        push('last_verified', fm.last_verified);
        // V1.0 字段（缺失不输出，保持旧条目序列化不变）
        push('memory_type', fm.memory_type);
        push('version', fm.version);
        push('idem_key', fm.idem_key);
        push('deleted_at', fm.deleted_at);
        push('deleted_by', fm.deleted_by);
        push('delete_reason', fm.delete_reason);
        push('operator', fm.operator);
        push('operation', fm.operation);
        push('confirmed_at', fm.confirmed_at);
        push('confirmed_by', fm.confirmed_by);
        // ── V1.2 五字段（2026-10-03 补）────────────────────────────────────
        // ⚠️ **这里与 parseEntryFile 必须成对改**：两个都是白名单，漏一个字段不会报错，
        //    只会"写进去了但读不出来"（或反过来）。这一对漏了整整 3 天，实测后果见下：
        //    stampV12Fields（路由 touch 落盘）写文件时把五字段**静默丢掉**，只有内存索引
        //    和 index.json 拿到值 —— 于是条目文件（真源）里 access_count 是空的，
        //    索引（派生）里已经涨到 619。索引一旦重建（回填 / 迁移 / 手工对齐），衰减状态全部归零。
        push('decay_type', fm.decay_type);
        push('last_accessed', fm.last_accessed);
        push('access_count', fm.access_count);
        push('lifecycle', fm.lifecycle);
        push('cold_start_until', fm.cold_start_until);
        lines.push('---');
        lines.push('');
        lines.push(content);
        return lines.join('\n');
    }
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
    writeEntryFileVerified(filePath, fm, content) {
        const raw = this.serializeEntryFile(fm, content);
        const inMemory = this.parseEntryFile(raw);
        if (inMemory.frontmatter.id !== fm.id || inMemory.frontmatter.layer !== fm.layer) {
            throw new Error(`[memory-container] 序列化往返自检失败，拒绝落盘：期望 ${fm.layer}/${fm.id}，` +
                `往返得到 ${String(inMemory.frontmatter.layer)}/${String(inMemory.frontmatter.id)}`);
        }
        this.atomicWrite(filePath, raw);
        const onDisk = this.parseEntryFile(fs.readFileSync(filePath, 'utf-8'));
        if (onDisk.frontmatter.id !== fm.id || onDisk.frontmatter.layer !== fm.layer) {
            throw new Error(`[memory-container] 落盘后回读不一致：期望 ${fm.layer}/${fm.id}，` +
                `回读到 ${String(onDisk.frontmatter.layer)}/${String(onDisk.frontmatter.id)}（${filePath}）`);
        }
    }
    /**
     * 只替换允许编辑的 frontmatter 字段，保留未知字段、注释及原有字段顺序。
     * 新值用 JSON 表示（JSON 标量/数组是 YAML 的合法子集），避免特殊字符破坏结构。
     */
    patchEntryFile(raw, fm, content, patch) {
        const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
        if (!match)
            throw new Error('[memory-container] 条目文件缺少 frontmatter');
        const replacements = new Map();
        const scalar = (value) => JSON.stringify(value);
        if (patch.title !== undefined)
            replacements.set('title', scalar(fm.title));
        if (patch.tags !== undefined)
            replacements.set('tags', JSON.stringify(fm.tags));
        if (patch.priority !== undefined)
            replacements.set('priority', String(fm.priority));
        if (patch.summary !== undefined)
            replacements.set('summary', scalar(fm.summary));
        replacements.set('updated', scalar(fm.updated));
        if (patch.content !== undefined)
            replacements.set('checksum', scalar(fm.checksum));
        const lines = match[1].split(/\r?\n/);
        for (const [key, value] of replacements) {
            const start = lines.findIndex((line) => new RegExp(`^${key}:`).test(line));
            const replacement = `${key}: ${value}`;
            if (start < 0) {
                lines.push(replacement);
                continue;
            }
            let end = start + 1;
            // 兼容旧版块状 tags 列表，只移除数组项；相邻注释和未知字段原样保留。
            if (key === 'tags') {
                while (end < lines.length && /^\s*-\s+/.test(lines[end]))
                    end++;
            }
            lines.splice(start, end - start, replacement);
        }
        return `---\n${lines.join('\n')}\n---\n\n${content}\n`;
    }
    /** 原子写：先写临时文件再 rename，避免半写状态 */
    atomicWrite(filePath, content) {
        // 目标或其父目录必须最终解析在容器根目录内，阻止符号链接逃逸。
        this.resolveInside(filePath);
        const realParent = fs.realpathSync(path.dirname(filePath));
        const realRootPrefix = this.realRoot + path.sep;
        if (realParent !== this.realRoot && !realParent.startsWith(realRootPrefix)) {
            throw new Error(`[memory-container] 写入目录越界: ${filePath}`);
        }
        const tmp = `${filePath}.tmp-${process.pid}`;
        try {
            fs.writeFileSync(tmp, content, { encoding: 'utf-8', mode: 0o600 });
            fs.renameSync(tmp, filePath);
        }
        finally {
            if (fs.existsSync(tmp))
                fs.unlinkSync(tmp);
        }
    }
}
