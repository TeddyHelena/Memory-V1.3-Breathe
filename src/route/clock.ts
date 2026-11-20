/**
 * 时钟语义 —— `elapsed()` 的**单一入口**（E3 · E1）
 *
 * ## 为什么要有这个模块
 * "距上次想起过了多久"这件事此前**没有定义**：`last_accessed` 是墙上时间戳，
 * 而"多久"在不同尺度上含义完全不同 ——
 *   · **同一会话内**：几轮之前 ≈ 几分钟，轮次是自然尺度；
 *   · **跨会话**：隔了一天还是三天，轮次差毫无意义（每次会话从 1 开始数）。
 * 混着用会出现"A/B 两个会话的第 3 轮撞键"那类错误（外审第 7 条）。
 *
 * ## 口径（E3 窄口径 · 2026-10-09）
 *   ① 同一会话 + **轮次号已知** ⇒ 轮次差；
 *   ② 跨会话 / 轮次号未知 ⇒ 墙钟天数差；
 *   ③ 闲置超过 `SESSION_IDLE_MIN`（30 分钟）视为**跨会话**（轮次差跨不过闲置边界）；
 *   ④ ⛔ **`t` 一律夹到 ≥ 0** —— 系统时间回拨（NTP 校时 / 改表 / 休眠唤醒）会让差值变负，
 *      不夹的话 `fresh > 1` 会把排序顶穿（可验证性镜头实测点名的缺口）。
 *
 * ## 数据源
 * 投递账本（C 段建的事件流）给"上次投递的轮次/时刻"；条目自带的 `last_accessed` 是兜底。
 */

export interface ElapsedInput {
  /** 当前会话 id（拿不到就给 undefined ⇒ 退化到墙钟） */
  sessionId?: string
  /** 当前轮次号（宿主 `turn/start` 给；拿不到就给 undefined） */
  turn?: number
  /** 当前时刻 */
  now: Date
  /** 同会话边界：闲置超过它就当跨会话（默认 30 分钟） */
  idleMs?: number
  /** 该条目**上一次被投递**的记录（来自投递账本） */
  last?: {
    session?: string
    turn?: number
    /** 上次投递时刻（ISO） */
    at: string
  }
  /** 账本里没有时用条目自带的 last_accessed（ISO） */
  lastAccessed?: string
}

export interface Elapsed {
  /** 以什么尺度量的 */
  unit: 'turn' | 'day'
  /** 差值（**已夹到 ≥ 0**） */
  value: number
  /** 是否走了退化路径（跨会话 / 轮次未知）—— 留痕用 */
  degraded: boolean
}

const DAY_MS = 86_400_000
// ⛔ 不导出（内部件）：外部只需知道「闲置超边界即转跨会话」，边界值由本模块与判据共同钉住。
const DEFAULT_IDLE_MS = 30 * 60 * 1000

/** 时刻解析（解析不了返回 null，⛔ 不许静默当 0） */
function instantOf(iso: string | undefined): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

/**
 * 距"上次被想起"过了多久。
 * ⛔ 返回值里的 `value` **一定 ≥ 0**；负差值（时间回拨）被夹到 0 并标 `degraded`。
 */
export function elapsed(input: ElapsedInput): Elapsed {
  const idleMs = input.idleMs ?? DEFAULT_IDLE_MS
  const lastAtRaw = instantOf(input.last?.at) ?? instantOf(input.lastAccessed)
  const clamp = (v: number): number => (Number.isFinite(v) && v > 0 ? v : 0)

  // ── 同会话 + 轮次号双方都在 ⇒ 轮次差 ──────────────────────────────
  const sameSession =
    Boolean(input.sessionId) &&
    Boolean(input.last?.session) &&
    input.sessionId === input.last?.session &&
    // 闲置超过边界 ⇒ 不算同一会话（哪怕 session id 相同）
    lastAtRaw !== null &&
    input.now.getTime() - lastAtRaw <= idleMs
  if (sameSession && input.turn !== undefined && input.last?.turn !== undefined) {
    const dt = input.turn - input.last.turn
    return { unit: 'turn', value: clamp(dt), degraded: dt < 0 }
  }

  // ── 其余一律走墙钟天数（含"跨会话"与"轮次未知"两种退化）────────────
  if (lastAtRaw === null) {
    // 完全没有时间依据：如实报"无从计量"（值 0 + degraded），⛔ 不许假装刚想起过
    return { unit: 'day', value: 0, degraded: true }
  }
  const dtDays = (input.now.getTime() - lastAtRaw) / DAY_MS
  return { unit: 'day', value: clamp(dtDays), degraded: dtDays < 0 }
}
