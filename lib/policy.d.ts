import type { EntryFrontmatter, MemoryScope, MemoryScopeContext, TemporalState } from './types.js';
/** 旧条目没有 scope 时视为全局，升级不要求迁移旧容器。 */
export declare function memoryScope(entry: {
    scope?: MemoryScope;
}): MemoryScope;
/**
 * 【S2 · P1-5】作用域的**同一性**判据 —— 与 `isInScope`（可见性）严格分开。
 *
 * 判重问的是"这是不是同一个项目里的同一条"，**不是**"我能不能看见它"。
 * 口径（作者 2026-10-08 拍板）：**跨 scope 不合并**——
 *   · 两边都 global ⇒ 同一
 *   · 两边同 scope 且 scope_id 相同 ⇒ 同一
 *   · 其余（含 global ↔ project、project A ↔ project B）⇒ **不同一**：
 *     即使内容逐字相同也不合并（把两件事合成一件是不可逆的语义损失；
 *     跨 scope 合并还会让项目记忆被全局记忆吸收）。
 *
 * ⚠️ ⛔ 不许拿 `isInScope` 顶替本函数：可见性允许"全局对谁都可⻅"，
 *    同一性不允许"全局与项目算同一条"——两者混用正是 P1-5 的根。
 */
export declare function sameScope(a: {
    scope?: MemoryScope;
    scope_id?: string;
}, b: {
    scope?: MemoryScope;
    scope_id?: string;
}): boolean;
/**
 * 作用域匹配是模型侧隔离边界：全局记忆始终可见；工作区/项目记忆必须显式匹配。
 * 空标识不使用通配符，避免配置遗漏导致跨项目串记忆。
 */
export declare function isInScope(entry: EntryFrontmatter, context?: MemoryScopeContext): boolean;
/**
 * 作用域判定的**索引投影版**：与 `isInScope` 同一份实现，只是吃索引里的裸字段。
 *
 * 为什么需要它（2026-10-09 · 安全审稿）：
 *   召回侧拿到的不是文件 frontmatter，而是 `index.json` 的投影条目。
 *   在那之前，作用域过滤**只长在检索侧**（`search.ts`），而 `route/recall.ts` 的两条路径
 *   —— hot 池倒排 与 tag 一跳扩散 —— 一行过滤都没有，于是别的项目/工作区的记忆
 *   可以顺着 tag 进动态注入集合；且生产调用点当时**根本没传 `scopeContext`**。
 *   实测复现：other-project 语境下 `project:taskmaster` 的条目进了 main。
 *
 * ⛔ 只有一份实现：`isInScope` 直接委托到这里 —— 两份手写判据必然分叉（本仓踩过两次）。
 * ⛔ 失败方向是**关闭**：非 global 且 `scope_id` 缺失 ⇒ 不放行（不给通配符）。
 */
export declare function scopeAllowsMeta(meta: {
    scope?: MemoryScope;
    scope_id?: string;
}, context?: MemoryScopeContext): boolean;
/**
 * 时态判定所需的**最小字段集** —— 文件 frontmatter 与索引投影（`index.json`）都满足。
 *
 * 为什么要放宽（2026-10-09 安全审稿）：召回侧（面②）拿到的是索引投影，不是文件对象；
 * 若只接受 `EntryFrontmatter`，召回侧要么写不出这条判据、要么用类型断言糊过去 ——
 * 结果是**面①判、面②不判**，同一条过期记忆从动态段照样注入。
 */
export type TemporalFields = Pick<EntryFrontmatter, 'status' | 'superseded_by' | 'valid_from' | 'valid_to' | 'expires'>;
/** 由显式状态和有效期共同计算当前状态；不修改源文件。 */
export declare function temporalState(entry: TemporalFields, now?: Date): TemporalState;
/** 过期、被替代和尚未生效的记忆不参与当前回答。 */
export declare function isCurrentMemory(state: TemporalState): boolean;
/**
 * **可注入**判据 —— 面①（系统提示词 hot 段）与面②（动态段召回）**必须共用这一条**。
 *
 * 2026-10-09 安全审稿：面①按时间状态过滤（`stale` 不自动注入、过期/废弃一律不注入），
 * 而面②的 hot 倒排与 tag 扩散**一条时态判据都没有** ⇒
 * 实测「面①挡住了、面②把它注进来了」——**同一个插件两个投递面对同一条记忆给出了不同答案**。
 * 本仓已有一次同款教训（作用域过滤只长在检索侧），所以这里抽出单一判据、两处共用，
 * ⛔ 不许各自内联写一遍。
 */
export declare function isInjectable(state: TemporalState): boolean;
/** 检索排序使用的保守降权；历史仍可由 id 直接追溯。 */
export declare function temporalWeight(state: TemporalState): number;
