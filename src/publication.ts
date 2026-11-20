/**
 * ── 【P7 · 2026-10-19】公示制核心（纯函数；接线开关默认关）────────────
 * 口径：进濒死清单 ⇒ 公开提名 N 个活跃日；人不说话=同意；钉住=否决。
 * ⛔ 空清单也必须落一行「今日无」（否则“漏一天重置”会让健康系统永远过不了）。
 *
 * 【P7 顺序修复】先算计划 → 按上一批到期切 due → 只搬 due → 再公示其余。
 * 【P7 口径 A · 2026-10-19 拍板】**同一时刻只允许一个未结批次**：
 *   prev 没到期就不落新公示行；到期消费完才开下一批。
 *   修前的病：每个墙钟日都落新行、把订阅期重签成 today+N ⇒ 每天启动一次时 due 恒空。
 *   B（多批独立结算）风险更大，暂不做；未来转 B 时按“每条首次提名日”起表。
 *
 * 到期口径：N = max(3 活跃日, 7 日历日) —— 两个时钟都记，**取较晚者**。
 */
import type { ChainPlan, ChainMove } from './chain.js'
import type { DecayPlan } from './decay.js'
import { chainPlanToDecayPlan } from './chain-adapter.js'

export interface Notice {
  batch: string
  ids: string[]
  publishedDay: number
  expireDay: number
  /** 发布时的墙钟日（YYYY-MM-DD）；老行没有 ⇒ 只按活跃日判到期（向后兼容） */
  publishedWallDay?: string
  /** 到期墙钟日（YYYY-MM-DD）；老行没有 ⇒ 只按活跃日判到期 */
  expireWallDay?: string
}

const CALENDAR_N_DEFAULT = 7
/** 每批公示上限（与 chain plan 的每批搬走上限分开） */
const NOTICE_LIMIT = 20

function plusDays(wallDay: string, days: number): string {
  const [y, m, d] = wallDay.split('-').map(Number)
  const dt = new Date(y, m - 1, d + days)
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
}

/** 生成公示（剔除已钉住；同时记活跃日与墙钟日两个到期口径） */
export function planNotice(
  forgetIds: readonly string[],
  pinned: ReadonlySet<string>,
  activeDay: number,
  N: number,
  wallDay?: string,
  calendarN = CALENDAR_N_DEFAULT,
): Omit<Notice, 'batch'> {
  return {
    ids: forgetIds.filter((id) => !pinned.has(id)),
    publishedDay: activeDay,
    expireDay: activeDay + Math.max(1, N),
    ...(wallDay ? { publishedWallDay: wallDay, expireWallDay: plusDays(wallDay, Math.max(1, calendarN)) } : {}),
  }
}

/** 订阅期到了吗：活跃日 ≥ expireDay **且**（若记了墙钟日）墙钟日 ≥ expireWallDay */
export function isMatured(notice: Pick<Notice, 'expireDay' | 'expireWallDay'>, activeDay: number, wallDay?: string): boolean {
  if (activeDay < notice.expireDay) return false
  if (notice.expireWallDay && wallDay && wallDay < notice.expireWallDay) return false
  return true
}

/** 到期可遗忘的 id（仍剔除钉住；订阅期未到返回空） */
export function dueForgetting(notice: Notice, pinned: ReadonlySet<string>, activeDay: number, wallDay?: string): string[] {
  if (!isMatured(notice, activeDay, wallDay)) return []
  return notice.ids.filter((id) => !pinned.has(id))
}

/** 空清单行（“今日无”也是投递，算公示不断档） */
export function emptyNoticeRow(activeDay: number): { day: number; ids: []; note: '今日无' } {
  return { day: activeDay, ids: [], note: '今日无' }
}

/**
 * 空计划（P7 计算失败时的**保守替身**）：⛔ 只搬 due 的路径绝不能退化成“搬全部”。
 * 只用在“公示批次算不出来”的异常路径；正常路径永远用 `planPublicationBatch().override`。
 */
export function emptyDecayPlan(): DecayPlan {
  return chainPlanToDecayPlan({
    moves: [],
    tiers: [],
    stats: { conversations: 0, entries: 0, byTier: { full: 0, snapshot: 0, outline: 0, forget: 0 }, projectState: 0, overLimit: 0, H: 0, theta: 0 },
  })
}

/**
 * 一次启动的公示批次（**口径 A：单未结批次**）。
 *
 * 硬约束：
 * · 首启（无 prev）⇒ due=[]、公示第一批
 * · prev 未到期 ⇒ **不落新批次**（A 的核心；这是“不重签订阅期”的实现）
 * · prev 到期 ⇒ 只搬 due；扫描真的跑过才落 due 行；之后再公示下一批
 * · due 里有新 pin ⇒ 在 `dueForgetting` 剔除
 * · due 里某条已不在链级计划中（重新活跃）⇒ 不搬（`override` 只取 plan.moves 交集）
 * · 同墙钟日批次号 ⇒ `duplicate=true`，调用方不重复落行
 */
export interface PublicationBatchPlan {
  /** 墙钟日批次号（`pub-YYYY-MM-DD`） */
  batch: string
  /** 活跃日序号（`publishedDay` / `expireDay` 的口径） */
  day: number
  /** 上一批到期、且此刻仍未被钉住的 ids（首启 / 未到期 ⇒ 空） */
  due: string[]
  /** 上一批订阅期已到（到期但全被钉住时 due=[] 而这里为 true） */
  prevDue: boolean
  /** 上一批公示了多少条（0 = 空批次「今日无」） */
  prevCount: number
  /** 本期是否允许落新公示（A：prev 为空或已到期） */
  publishNew: boolean
  /** ⛔ 唯一允许搬的计划：只含 due 里仍在链级计划中的 longterm→archive */
  override: DecayPlan
  /** 真正会搬的 ids */
  executed: string[]
  /** 本批公示（A 下 prev 未到期时为 null ⇒ 不落行） */
  notice: Omit<Notice, 'batch'> | null
  /** 还没进公示的候选数（观测用：积压） */
  waiting: number
  /** 被每批上限截掉的条数（观测用） */
  overLimit: number
  /** 上一批批次号 */
  prevBatch: string | null
  dueBatch: string | null
  dueDuplicate: boolean
  /** 到期消费意图行批次（`intent-due-<batch>`；先落意图再搬，崩溃后可对账） */
  intentBatch: string | null
  intentDuplicate: boolean
  duplicate: boolean
}
export function planPublicationBatch(input: {
  plan: ChainPlan
  pins: ReadonlySet<string>
  prev: Notice | null
  today: number
  wallDay: string
  seenBatches: Iterable<string>
  /** 到期条目的当前层（缺省不补 due；B1 排序变动时用） */
  layerOf?: (id: string) => string | null | undefined
  N?: number
  calendarN?: number
}): PublicationBatchPlan {
  const prevDue = input.prev !== null && isMatured(input.prev, input.today, input.wallDay)
  const due = prevDue && input.prev ? dueForgetting(input.prev, input.pins, input.today, input.wallDay) : []
  const dueSet = new Set(due)
  const moveById = new Map(input.plan.moves.map((m) => [m.id, m]))
  const tierById = new Map(input.plan.tiers.map((t) => [t.id, t]))
  // ⛔ 只搬 due：其余候选哪怕也在 forget 档，也必须等自己的订阅期到期。
  // 【B1 · 2026-10-26】到期条目可能因池内分位排名变化已不在当前 moves 里，
  // 但它已经在 N 天前被公示、用户没有 pin ⇒ 不能因为“今天排名变了”就静默留在库里。
  // 只对仍在 longterm、未护栏的 due 补一条到期 move；已 archive（崩后重入）不补，由 due 真值账处理。
  const dueMoves: ChainMove[] = []
  for (const id of due) {
    const layer = input.layerOf?.(id)
    if (layer !== undefined && layer !== null && layer !== 'longterm') continue
    const m = moveById.get(id)
    if (m) { dueMoves.push(m); continue }
    const tier = tierById.get(id)
    if (!tier || tier.guarded) continue
    if (layer !== 'longterm') continue
    dueMoves.push({
      id, from: 'longterm', to: 'archive', state: tier.state, ageDays: tier.ageDays, convId: tier.convId,
      reason: '到期批次（订阅期已满；当前排序已变）',
    })
  }
  const override = chainPlanToDecayPlan({ ...input.plan, moves: dueMoves })
  // ⛔ A：prev 未到期 ⇒ 不落新批次（否则就是重签订阅期，P0-1 复发）
  const publishNew = input.prev === null || prevDue
  const candidateIds = input.plan.moves.filter((m) => !dueSet.has(m.id)).map((m) => m.id)
  // 每批只公示前 NOTICE_LIMIT 条；due 不占下一批名额（修前 plan 被 limit=20 截断，
  // 到期后下一批只剩 1 条、其余 9 条要再等一期的空洞）
  const noticeIds = candidateIds.slice(0, NOTICE_LIMIT)
  const notice = publishNew
    ? planNotice(noticeIds, input.pins, input.today, input.N ?? 3, input.wallDay, input.calendarN ?? CALENDAR_N_DEFAULT)
    : null
  const waiting = publishNew
    ? Math.max(0, candidateIds.length - noticeIds.length)
    : input.plan.moves.length
  const batch = `pub-${input.wallDay}`
  const seen = new Set(input.seenBatches)
  const prevBatch = input.prev?.batch ?? null
  const dueBatch = prevBatch === null ? null : `due-${prevBatch}`
  return {
    batch,
    day: input.today,
    due,
    prevDue,
    prevCount: input.prev?.ids.length ?? 0,
    publishNew,
    override,
    executed: override.moves.map((m) => m.id),
    notice,
    waiting,
    overLimit: waiting,
    prevBatch,
    dueBatch,
    dueDuplicate: dueBatch !== null && seen.has(dueBatch),
    intentBatch: dueBatch === null ? null : `intent-${dueBatch}`,
    intentDuplicate: dueBatch !== null && seen.has(`intent-${dueBatch}`),
    duplicate: publishNew && seen.has(batch),
  }
}
