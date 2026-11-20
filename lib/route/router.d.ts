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
import type { MemoryContainer } from '../container.js';
import type { MemoryScopeContext } from '../types.js';
import { type ScoreOptions } from './score.js';
import { type RouteConfig, type RouteResult } from './types.js';
export interface RouterOptions {
    /** 【E3】fresh 取值器（见 ScoreOptions.freshLookup）；不传 ⇒ 回落到 `fresh = pri` */
    freshLookup?: ScoreOptions['freshLookup'];
    config?: RouteConfig;
    scopeContext?: MemoryScopeContext;
    now?: Date;
}
/**
 * 路由器：**持有倒排索引与 touch 累积**。
 *
 * 为什么不是一个纯函数：
 *   ① 倒排索引构建一次、复用多轮（纯函数会每轮重建，把 V1.1 的检索优化吃回去）
 *   ② touch 是"写意图"，不该每轮同步落盘——累积起来批量提交，
 *      否则每轮对话都要写 13+ 个文件
 */
export declare class Router {
    private readonly container;
    private readonly config;
    private tagIndex;
    private tagIndexFingerprint;
    /** 待落盘的 touch 累积：id → { last_accessed, access_count } */
    private pendingTouch;
    constructor(container: MemoryContainer, config?: RouteConfig);
    /** 倒排索引按需重建（索引指纹变化时）——写入后由指纹自动触发，不需要外部置脏 */
    private recallContext;
    /** 每轮路由：纯计算，不落盘（touch 进 pending，由 flushTouch 提交） */
    route(query: string, opts?: RouterOptions): RouteResult;
    /**
     * 记 touch（**内存态**，不落盘）。
     *
     * V1.2 的诚实口径：这里只保证 `last_accessed` / `access_count` 被正确维护，
     * **不保证立刻可见于磁盘**。落盘交给 `flushTouch()`——由插件在写入事务或
     * 会话边界调用，避免每轮对话写十几个文件（那是 V1.1 明确治过的性能病）。
     */
    private touchAll;
    /**
     * 把**账本判定为"发生了唤起"**的条目记账（C 段）。
     *
     * ⛔ 只接受 id：**判断谁算唤起是账本的事**（`InjectionLedger`），路由不掺和 ——
     *    否则"什么算唤起"又会分叉成两份实现（本仓反复踩过的病）。
     * 记账本身仍然只是攒 `pendingTouch`，落盘照旧走 `flushTouch`（30s 地板 + 写事务）。
     */
    touchEntries(ids: string[], now: Date): number;
    /** 待提交的 touch 数量（自检/审计用） */
    pendingTouchCount(): number;
    /**
     * 把累积的 touch 落盘。
     *
     * 走容器的 `stampV12Fields`（只改 V1.2 字段，不动 updated / checksum）——
     * 与回填同一入口，保证两条写路径的字段语义一致。
     */
    flushTouch(): {
        written: number;
        failed: string[];
        indexSaved: boolean;
    };
}
