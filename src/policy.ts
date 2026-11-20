import { parseInstant } from './day-boundary.js'
import type {
  EntryFrontmatter,
  MemoryScope,
  MemoryScopeContext,
  TemporalState,
} from './types.js'

/** 旧条目没有 scope 时视为全局，升级不要求迁移旧容器。 */
export function memoryScope(entry: { scope?: MemoryScope }): MemoryScope {
  return entry.scope === 'workspace' || entry.scope === 'project' ? entry.scope : 'global'
}

/**
 * 【S2 · P1-5】作用域的**同一性**判据 —— 与 `isInScope`（可见性）严格分开。
 *
 * 判重问的是"这是不是同一个项目里的同一条"，**不是**"我能不能看见它"。
 * 口径（Teddy 2026-10-08 拍板）：**跨 scope 不合并**——
 *   · 两边都 global ⇒ 同一
 *   · 两边同 scope 且 scope_id 相同 ⇒ 同一
 *   · 其余（含 global ↔ project、project A ↔ project B）⇒ **不同一**：
 *     即使内容逐字相同也不合并（把两件事合成一件是不可逆的语义损失；
 *     跨 scope 合并还会让项目记忆被全局记忆吸收）。
 *
 * ⚠️ ⛔ 不许拿 `isInScope` 顶替本函数：可见性允许"全局对谁都可⻅"，
 *    同一性不允许"全局与项目算同一条"——两者混用正是 P1-5 的根。
 */
export function sameScope(
  a: { scope?: MemoryScope; scope_id?: string },
  b: { scope?: MemoryScope; scope_id?: string },
): boolean {
  const sa = memoryScope(a)
  const sb = memoryScope(b)
  if (sa !== sb) return false
  return sa === 'global' ? true : (a.scope_id ?? '') === (b.scope_id ?? '')
}

/**
 * 作用域匹配是模型侧隔离边界：全局记忆始终可见；工作区/项目记忆必须显式匹配。
 * 空标识不使用通配符，避免配置遗漏导致跨项目串记忆。
 */
export function isInScope(entry: EntryFrontmatter, context: MemoryScopeContext = {}): boolean {
  return scopeAllowsMeta(entry, context)
}

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
export function scopeAllowsMeta(
  meta: { scope?: MemoryScope; scope_id?: string },
  context: MemoryScopeContext = {},
): boolean {
  const scope = memoryScope(meta)
  if (scope === 'global') return true
  if (!meta.scope_id) return false
  return scope === 'workspace'
    ? Boolean(context.workspaceId) && meta.scope_id === context.workspaceId
    : Boolean(context.projectId) && meta.scope_id === context.projectId
}

/**
 * 时间解析 —— **统一走 `day-boundary` 的单一权威**（E 段 · 1.4 · 2026-10-09）。
 *
 * 修前这里是"日期粒度补到 **UTC** 日末"，与 `ingest.coldStartActive`（UTC 日初）
 * 和 `idem.today()`（UTC 日标签）三套口径并存；现在全部收敛到
 * **配置时区下的当地日**（Teddy 拍板：`2026-10-09` = 当地那一天的结束）。
 */
function parseTime(value: string | undefined, endOfDate = false): number | null {
  return parseInstant(value, endOfDate)
}

/**
 * 时态判定所需的**最小字段集** —— 文件 frontmatter 与索引投影（`index.json`）都满足。
 *
 * 为什么要放宽（2026-10-09 安全审稿）：召回侧（面②）拿到的是索引投影，不是文件对象；
 * 若只接受 `EntryFrontmatter`，召回侧要么写不出这条判据、要么用类型断言糊过去 ——
 * 结果是**面①判、面②不判**，同一条过期记忆从动态段照样注入。
 */
export type TemporalFields = Pick<
  EntryFrontmatter,
  'status' | 'superseded_by' | 'valid_from' | 'valid_to' | 'expires'
>

/** 由显式状态和有效期共同计算当前状态；不修改源文件。 */
export function temporalState(entry: TemporalFields, now = new Date()): TemporalState {
  if (entry.status === 'superseded' || entry.superseded_by) return 'superseded'
  if (entry.status === 'expired') return 'expired'
  if (entry.status && !['active', 'stale', 'expired', 'superseded'].includes(entry.status)) return 'stale'
  const instant = now.getTime()
  const from = parseTime(entry.valid_from)
  const toValue = entry.valid_to ?? entry.expires
  const to = parseTime(toValue, true)
  // 格式错误的时间边界不应被当作“永远有效”。保守标记为 stale。
  if ((entry.valid_from && from === null) || (toValue && to === null)) return 'stale'
  if (from !== null && instant < from) return 'future'
  if (to !== null && instant > to) return 'expired'
  if (entry.status === 'stale') return 'stale'
  return 'active'
}

/** 过期、被替代和尚未生效的记忆不参与当前回答。 */
export function isCurrentMemory(state: TemporalState): boolean {
  return state === 'active' || state === 'stale'
}

/**
 * **可注入**判据 —— 面①（系统提示词 hot 段）与面②（动态段召回）**必须共用这一条**。
 *
 * 2026-10-09 安全审稿：面①按时间状态过滤（`stale` 不自动注入、过期/废弃一律不注入），
 * 而面②的 hot 倒排与 tag 扩散**一条时态判据都没有** ⇒
 * 实测「面①挡住了、面②把它注进来了」——**同一个插件两个投递面对同一条记忆给出了不同答案**。
 * 本仓已有一次同款教训（作用域过滤只长在检索侧），所以这里抽出单一判据、两处共用，
 * ⛔ 不许各自内联写一遍。
 */
export function isInjectable(state: TemporalState): boolean {
  return isCurrentMemory(state) && state !== 'stale'
}

/** 检索排序使用的保守降权；历史仍可由 id 直接追溯。 */
export function temporalWeight(state: TemporalState): number {
  return state === 'stale' ? 0.55 : isCurrentMemory(state) ? 1 : 0
}
