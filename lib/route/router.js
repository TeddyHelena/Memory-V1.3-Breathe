/**
 * router.ts —— V1.2 路由主流程（契约清单 §五 / §三）
 *
 * ```
 *   ┌ 每轮 ────────────────────────────────────────────────────────┐
 *   │ ① recall   定向（hot 倒排 + BM25）+ 涌现（1 跳）                │
 *   │ ② score    log+z-score 归一 → 双门槛加权和（fresh = pri）      │
 *   │ ③ gate     硬门禁只校验 emergent（关键词绝对阈值 + 白名单）      │
 *   │ ④ budget   字符预算 + 保底 → main / candidates                 │
 *   │ ⑤ touch    命中的条目重置 last_accessed（V1.2 简化版）         │
 *   │ ⑥ 装配     main 走用户轮次（自替换快照，不进系统提示词）        │
 *   └──────────────────────────────────────────────────────────────┘
 * ```
 *
 * ── 装配这一刀为什么必须切在这里 ──────────────────────────────────
 * `main` 每轮按 query 变 → 只能走**用户轮次注入**（自替换快照）。
 * 若把它塞进系统提示词，每轮前缀从首字节失效、整段上下文按全价重算——
 * 09-15 实测过一次（时间行一分钟一变，156 次全失效，折 ¥15.38）。
 *
 * 常驻身份内容**不归本模块管**：它由 hot 层（hot_order + 预算）经系统提示词投递，
 * 每轮字节不变、缓存命中。2026-10-03 删掉的路由侧 `prefixStable` 就是想在这里
 * 再管一遍同一件事 —— 那会造出第二个真源（实测多出来的 12 条恰是人工决定不注入的）。
 * **本模块只产出"这一轮该想起什么"，装配位置由上游决定。**
 */
import { scopeAllowsMeta } from '../policy.js';
import { touchFields } from '../ingest.js';
import { buildInvertedTagIndex, directed, emergent } from './recall.js';
import { scoreAll } from './score.js';
import { validate } from './gate.js';
import { allocate } from './budget.js';
import { DEFAULT_ROUTE_CONFIG } from './types.js';
import { LayerTrace } from '../contract/layer.js';
/**
 * 路由器：**持有倒排索引与 touch 累积**。
 *
 * 为什么不是一个纯函数：
 *   ① 倒排索引构建一次、复用多轮（纯函数会每轮重建，把 V1.1 的检索优化吃回去）
 *   ② touch 是"写意图"，不该每轮同步落盘——累积起来批量提交，
 *      否则每轮对话都要写 13+ 个文件
 */
export class Router {
    container;
    config;
    tagIndex = null;
    tagIndexFingerprint = '';
    /** 待落盘的 touch 累积：id → { last_accessed, access_count } */
    pendingTouch = new Map();
    constructor(container, config = DEFAULT_ROUTE_CONFIG) {
        this.container = container;
        this.config = config;
    }
    /** 倒排索引按需重建（索引指纹变化时）——写入后由指纹自动触发，不需要外部置脏 */
    recallContext(now, scopeContext) {
        const fp = this.container.indexFingerprint();
        if (!this.tagIndex || fp !== this.tagIndexFingerprint) {
            this.tagIndex = buildInvertedTagIndex(this.container.getIndex().entries);
            this.tagIndexFingerprint = fp;
        }
        return { container: this.container, config: this.config, tagIndex: this.tagIndex, scopeContext, now };
    }
    /** 每轮路由：纯计算，不落盘（touch 进 pending，由 flushTouch 提交） */
    route(query, opts = {}) {
        const t0 = Date.now();
        const now = opts.now ?? new Date();
        const ctx = this.recallContext(now, opts.scopeContext);
        // 层间 trace：一轮一个，记录"谁产出了哪个集合、谁在哪个集合上算了相对量"
        const trace = new LayerTrace();
        // ① 召回（身份卡层已于 2026-10-03 删除：hot_order 是"什么进前缀"的唯一真源，见 recall.ts）
        const directHits = directed(ctx, query);
        const seeds = emergent(ctx, directHits, { secondHop: directHits.length === 0 });
        trace.publish('RECALL', 'callAll', [...directHits, ...seeds]);
        const tRecall = Date.now() - t0;
        // ② 打分（分布只吃 directed 的真实 BM25）
        const t1 = Date.now();
        // 【E3】`freshLookup` 必须**转下去**：否则调用方给了取值器、分数却纹丝不动 ——
        // 那会让标定网格全行相等，看起来像"权重无影响"，实际是**假阴性**（实测踩过）。
        const { scored } = scoreAll([...directHits, ...seeds], {
            config: this.config,
            now,
            freshLookup: opts.freshLookup,
        });
        trace.publish('SCORE', 'scored', scored);
        const tScore = Date.now() - t1;
        // ③ 硬门禁（只对 emergent 生效）
        const t2 = Date.now();
        const gated = validate(scored, query, this.config);
        trace.publish('GATE', 'gatePassed', gated.entries.filter((e) => e.gatePass));
        trace.publish('GATE', 'candZone', gated.entries.filter((e) => !e.gatePass));
        const tGate = Date.now() - t2;
        // ④ 预算 + 保底（基准集合由 allocate 内部显式声明为 gatePassed 并 publish）
        const t3 = Date.now();
        // 【D1 · 去重投递】已常驻（hot_order）的条目不再进动态段 ——
        // 面①每轮都在投它们，面②再投一次是同一份内容付两次 token（实测某查询 6 格里占 3 格）。
        // 开关默认开；关掉即回到"两面都投"的旧行为（回滚路径）。
        const hotIds = this.config.exclude_hot_from_route
            ? new Set(this.container.getIndex().hot_order ?? [])
            : null;
        const alloc = allocate(gated.entries, this.config, trace, {
            exclude: hotIds ? (e) => hotIds.has(e.meta.id) : undefined,
        });
        const tBudget = Date.now() - t3;
        // 层间契约校验：声明与事实不一致 → 直接抛（不静默降级）
        const forge = trace.check();
        if (!forge.ok) {
            throw new Error(`[route] 层间契约校验失败 ${forge.code}: ${forge.detail}`);
        }
        // ⑤ 【C 段 · 2026-10-09】路由**不再自己记账**。
        //    旧行为：`touchAll(main ∪ candidates)` —— 把"**被考虑过但没被注入**"也算成一次唤起，
        //    于是候选区（每轮 20–32 条）天天把整个语料扫成"刚刚访问过"：
        //    实测 10 次路由覆盖 **92%** 语料、35 条**从未进过注入**的条目两天各涨 **326** 次，
        //    衰减引擎的输入因此被扫平（`t` 中位 0.154 天）。
        //    新口径（唯一权威在 `InjectionLedger`）：**唤起 ≡ 注入**；候选区**只读不写**；
        //    按宿主轮次号去重。记账由**真正把内容渲染进上下文的那一处**（插件注入点）负责 ——
        //    只有那里知道"到底谁被投出去了"。
        //    注：`route()` 的契约本来就是"纯计算，不落盘"（见函数头注释），这里是把契约兑现。
        return {
            main: alloc.main,
            candidates: alloc.candidates,
            stats: {
                recall: { directed: directHits.length, emergent: seeds.length },
                scanned: scored.length,
                scored: scored.length,
                gated: { passed: gated.passed, failed: gated.failed },
                main: alloc.main.length,
                candidates: alloc.candidates.length,
                capped: alloc.info.capBlocked,
                drops: alloc.info.dropReasons,
                gateIn: alloc.info.gateIn,
                timing: {
                    recall: tRecall,
                    score: tScore,
                    gate: tGate,
                    budget: tBudget,
                    total: Date.now() - t0,
                },
            },
        };
    }
    /**
     * 记 touch（**内存态**，不落盘）。
     *
     * V1.2 的诚实口径：这里只保证 `last_accessed` / `access_count` 被正确维护，
     * **不保证立刻可见于磁盘**。落盘交给 `flushTouch()`——由插件在写入事务或
     * 会话边界调用，避免每轮对话写十几个文件（那是 V1.1 明确治过的性能病）。
     */
    touchAll(entries, now, scopeContext) {
        const iso = now.toISOString();
        const seen = new Set();
        for (const s of entries) {
            // ⛔ 纵深防御（2026-10-09 安全审稿）：**写侧不许跨作用域**。
            //    召回侧已经过滤了一次（见 recall.ts 的两条路径），但这里是**唯一会改别条记录
            //    文件的路径** —— 一旦将来哪条召回路径再漏，写盘不该跟着漏。
            //    实测形态（修前）：候选区里别作用域的条目，其 last_accessed 被 flushTouch 改写。
            if (!scopeAllowsMeta(s.meta, scopeContext))
                continue;
            // 同一轮内同一条目命中多次只算一次访问（否则 fanout 越大的条目计数越高，
            // access_count 就成了"被多少 tag 带到"的度量，而不是"被唤起多少次"）
            if (seen.has(s.meta.id))
                continue;
            seen.add(s.meta.id);
            // 基线取 pending 累积值优先，其次取索引里的既有值
            const base = this.pendingTouch.get(s.meta.id)?.access_count ?? (Number(s.meta.access_count) || 0);
            const next = touchFields({ access_count: base }, iso);
            this.pendingTouch.set(s.meta.id, next);
            s.meta.last_accessed = next.last_accessed;
            s.meta.access_count = next.access_count;
        }
    }
    /**
     * 把**账本判定为"发生了唤起"**的条目记账（C 段）。
     *
     * ⛔ 只接受 id：**判断谁算唤起是账本的事**（`InjectionLedger`），路由不掺和 ——
     *    否则"什么算唤起"又会分叉成两份实现（本仓反复踩过的病）。
     * 记账本身仍然只是攒 `pendingTouch`，落盘照旧走 `flushTouch`（30s 地板 + 写事务）。
     */
    touchEntries(ids, now) {
        if (ids.length === 0)
            return 0;
        const entries = ids
            .map((id) => this.container.entryMeta(id))
            .filter((m) => Boolean(m))
            .map((meta) => ({ meta }));
        this.touchAll(entries, now, undefined);
        return entries.length;
    }
    /** 待提交的 touch 数量（自检/审计用） */
    pendingTouchCount() {
        return this.pendingTouch.size;
    }
    /**
     * 把累积的 touch 落盘。
     *
     * 走容器的 `stampV12Fields`（只改 V1.2 字段，不动 updated / checksum）——
     * 与回填同一入口，保证两条写路径的字段语义一致。
     */
    flushTouch() {
        const failed = [];
        let written = 0;
        for (const [id, fields] of this.pendingTouch) {
            try {
                // 批处理：显式关闭单条落盘，末尾统一 saveIndex（避免写 N 次索引）
                if (this.container.stampV12Fields(id, fields, { saveIndex: false }))
                    written += 1;
                else
                    failed.push(`${id}: not-found`);
            }
            catch (error) {
                failed.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        this.pendingTouch.clear();
        // ★ 索引侧必须跟着落盘 —— 否则文件与索引分叉，而且是**慢性分叉**：
        //   文件每次 flush 都写，索引只在别的写操作（remember 等）触发 saveIndex 时才落。
        //   实测踩过：30 条条目的 last_accessed/access_count 在文件里是新值、索引里是旧值，
        //   对账工具直接报「值不等」——**这是我自己引入的双真源分叉**，与本轮在治的病同源。
        //
        //   `stampV12Fields` 内部已经 `Object.assign` 到内存索引 meta，所以这里只需把索引落盘。
        //   失败不静默：indexSaved=false 时由调用方记警告（文件已写、索引没落 = 分叉状态）。
        let indexSaved = false;
        if (written > 0 && failed.length === 0) {
            try {
                this.container.saveIndex();
                indexSaved = true;
            }
            catch (error) {
                failed.push(`saveIndex: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        return { written, failed, indexSaved };
    }
}
