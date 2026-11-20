/**
 * ── 【P4 · 2026-10-18】链级判据（纯函数，只算不写）────────────────
 *
 * 一句话：**环的衰老按它自己的 age 算；项目状态 = max(子环状态)；条目跟随所属会话。**
 * 设计口径见研究记录 §13.6 / §十六 P4：
 *   · 活跃时钟：age = 活跃日(now) − 活跃日(last_grown)；
 *   · state = 2^(−age/H)，H 为项目链半衰期（活跃日）；
 *   · 档位：完整 ≥0.5 / 快照 ≥0.25 / 轮廓 ≥θ / 遗忘 <θ；
 *   · 版次线（supersedes）不参与衰减；`core` 永不遗忘；未投递过的永不遗忘。
 *
 * ⛔ 本模块**没有 relocate、没有 fs**，返回值是 diff —— 调用方拿不到写能力。
 */
export type ChainTier = 'full' | 'snapshot' | 'outline' | 'forget'

export interface ChainEntryInput {
  id: string
  layer: string
  /**
   * 条目状态（active/stale/expired/superseded…）。
   * 【2026-10-19 修复】不给 status 时，墓碑与 superseded 旧版会进 moves
   * ⇒ relocate 抛“墓碑/废弃条目不做层迁移” ⇒ **一条卡死整批**（P0-2）。
   */
  status?: string
  decayType?: string
  /** 投递次数（from injection-ledger）；undefined = 未知，按“未投递”保守处理 */
  delivered?: number
  hot?: boolean
  convId: string
}

export interface ChainConversationInput {
  convId: string
  /** 该会话最后一个“真人说话”的活跃日序号（无则 null） */
  lastGrownDay: number | null
}

export interface ChainPlanInput {
  /** 今天的活跃日序号（0 起） */
  today: number
  conversations: ChainConversationInput[]
  entries: ChainEntryInput[]
  /** 项目链半衰期（活跃日） */
  H: number
  /** 遗忘阈值（state 低于它算忘） */
  theta: number
  tierFull?: number
  tierSnapshot?: number
  /** 【B3】每批最多搬几条（缺省不限；调用方传 maxPerSweepFor） */
  limit?: number
  /** 【P7】被钉住的条目：永不遗忘 */
  pinned?: ReadonlySet<string>
  /**
   * 【B1 · 2026-10-26】Breathe「池内分位」选中的退场 ids。
   * 这些条目在链级护栏之后仍要退；若 tier 原本不是 forget，强制降为 forget（P6 同步不注入）。
   */
  quantileMoves?: ReadonlySet<string>
  /**
   * 【B1 · P6 渲染】true = 计算“注入形态”而不是“遗忘”：
   * · hot 护栏失效（否则被注入的条目永远 full，档位渲染整条链空转）；
   * · never-delivered 失效（对渲染无意义——在 hot_order 里就说明已投递）。
   * core / pinned 仍然强制 full。
   */
  rendering?: boolean
}

export interface ChainMove {
  id: string
  from: string
  to: 'archive'
  state: number
  ageDays: number
  convId: string
  reason: string
}

export interface ChainTierRow {
  id: string
  convId: string
  state: number
  ageDays: number
  tier: ChainTier
  /** 被护栏拦下（不参与遗忘） */
  guarded?: 'core' | 'hot' | 'pinned' | 'never-delivered' | 'no-session' | 'inactive'
}

export interface ChainPlan {
  moves: ChainMove[]
  tiers: ChainTierRow[]
  stats: {
    conversations: number
    entries: number
    byTier: Record<ChainTier, number>
    projectState: number
    /** 【B3】被每批上限截掉的条数 */
    overLimit: number
    H: number
    theta: number
  }
}

/** state = 2^(−age/H) */
export function stateOf(ageDays: number, H: number): number {
  if (!Number.isFinite(ageDays) || ageDays <= 0) return 1
  return Math.pow(2, -ageDays / Math.max(0.0001, H))
}

/** 档位：完整 / 快照 / 轮廓 / 遗忘 */
export function tierOf(state: number, theta: number, full = 0.5, snapshot = 0.25): ChainTier {
  if (state < theta) return 'forget'
  if (state >= full) return 'full'
  if (state >= snapshot) return 'snapshot'
  return 'outline'
}

/**
 * 纯函数：只算「该动谁 / 谁在哪一档」，⛔ 不改任何数据。
 * 护栏优先级：core > hot > never-delivered > 无年龄。
 */
export function planChainSweep(input: ChainPlanInput): ChainPlan {
  const H = Math.max(0.0001, input.H)
  const theta = input.theta
  const full = input.tierFull ?? 0.5
  const snap = input.tierSnapshot ?? 0.25
  const byConv = new Map(input.conversations.map((c) => [c.convId, c]))
  const rows: ChainTierRow[] = []
  const moves: ChainMove[] = []
  const byTier: Record<ChainTier, number> = { full: 0, snapshot: 0, outline: 0, forget: 0 }
  let projectState = 0

  for (const conv of input.conversations) {
    const age = conv.lastGrownDay === null ? null : Math.max(0, input.today - conv.lastGrownDay)
    const state = age === null ? 0 : stateOf(age, H)
    if (state > projectState) projectState = state
  }

  for (const e of input.entries) {
    const conv = byConv.get(e.convId)
    const hasAge = conv !== undefined && conv.lastGrownDay !== null
    const age = hasAge ? Math.max(0, input.today - (conv!.lastGrownDay as number)) : null
    const state = age === null ? 1 : stateOf(age, H)
    let tier: ChainTier = age === null ? 'full' : tierOf(state, theta, full, snap)
    let guarded: ChainTierRow['guarded']

    if (input.pinned?.has(e.id)) { tier = 'full'; guarded = 'pinned' }
    else if (e.decayType === 'core') { tier = 'full'; guarded = 'core' }
    // 【P0-2 修复 · 2026-10-19】非 active 一律不参与遗忘（墓碑/已替代/过期）。
    // 旧判据 decay.ts 本来就有这道护栏；链级判据漏了 ⇒ 墓碑进 moves ⇒ relocate 抛错。
    else if (e.status !== undefined && e.status !== 'active') { tier = 'full'; guarded = 'inactive' }
    else if (!input.rendering && e.hot) { tier = 'full'; guarded = 'hot' }
    else if (!input.rendering && (e.delivered === undefined || e.delivered <= 0)) { tier = 'full'; guarded = 'never-delivered' }
    else if (age === null) { tier = 'full'; guarded = 'no-session' }

    // 【B1】池内分位选中：护栏之后仍要退；tier 同步改 forget（P6 不能再注入它）。
    const quantileSelected = !guarded && input.quantileMoves?.has(e.id) === true
      && e.layer !== 'archive' && e.layer !== 'pending'
      && (e.status === undefined || e.status === 'active')
    if (quantileSelected && tier !== 'forget') tier = 'forget'
    byTier[tier]++
    rows.push({ id: e.id, convId: e.convId, state, ageDays: age ?? -1, tier, ...(guarded ? { guarded } : {}) })

    if (tier === 'forget' && !guarded && e.layer !== 'archive' && e.layer !== 'pending'
      && (e.status === undefined || e.status === 'active')) {
      moves.push({
        id: e.id,
        from: e.layer,
        to: 'archive',
        state,
        ageDays: age ?? -1,
        convId: e.convId,
        reason: quantileSelected
          ? `池内分位（Breathe 目标口径；state=${state.toFixed(3)}，H=${H}）`
          : `链龄 ${age ?? '?'} 活跃日（state=${state.toFixed(3)} < θ=${theta}；H=${H}）`,
      })
    }
  }

  // 【B3】每批上限：按 state 升序（最该忘的先走），超出的记 overLimit，⛔ 不许一次搬空
  const limit = input.limit
  let overLimit = 0
  let capped = moves
  if (limit !== undefined && Number.isFinite(limit) && moves.length > Math.max(0, limit)) {
    capped = [...moves].sort((a, b) => a.state - b.state || a.id.localeCompare(b.id)).slice(0, Math.max(0, limit))
    overLimit = moves.length - capped.length
  }

  return {
    moves: capped,
    tiers: rows,
    stats: { conversations: input.conversations.length, entries: input.entries.length, byTier, projectState, overLimit, H, theta },
  }
}
