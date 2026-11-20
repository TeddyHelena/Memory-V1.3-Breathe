/**
 * 条目文字/墓碑口径（移植自 `01-Memory.html` 2026-10-19 版）。
 *
 * ⛔ 两个必须由渲染层兜住的点：
 *   ① 墓碑优先：`[已遗忘]` 标题 + 「已删除：仅保留元数据」摘要是真的删过内容，
 *      不能再按年龄算成「快照」并显示一个不存在的摘要；
 *   ② 标题单行化：标题里的换行/制表能伪造 hot 注入行，渲染侧先压平。
 *
 * 这两个函数必须与 `01-Memory.html` 的 `safeTitle/isTombstone/cleanTitle` 同口径；
 * 改原型时同步改这里，否则 UI 又会开始“按年龄猜”。
 */

/** 标题单行化：换行/制表压成空格，连续空白归一。 */
export function safeTitle(value: unknown): string {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
}

/** 去掉墓碑前缀，拿到可显示的标题（只用于渲染，不改盘上 title）。 */
function cleanTitle(value: unknown): string {
  return safeTitle(value).replace(/^\[已遗忘\]\s*/, '')
}

/** 墓碑：标题前缀或摘要哨兵二选一即可，避免只修了其中一条数据。 */
export function isTombstone(entry: { title?: unknown; summary?: unknown; status?: unknown } | null | undefined): boolean {
  if (!entry) return false
  if (entry.status === 'expired' && String(entry.summary ?? '').includes('已删除：仅保留元数据')) return true
  if (/^\[已遗忘\]/.test(String(entry.title ?? ''))) return true
  return /（已删除：仅保留元数据）/.test(String(entry.summary ?? ''))
}

/** 列表/抽屉共用的显示标题：墓碑不把 `[已遗忘]` 当标题内容。 */
export function displayTitle(entry: { title?: unknown; summary?: unknown; status?: unknown }): string {
  return isTombstone(entry) ? cleanTitle(entry.title) : safeTitle(entry.title)
}
