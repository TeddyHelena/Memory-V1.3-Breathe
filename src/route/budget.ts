/**
 * budget.ts —— V1.2 预算守护（契约清单 §四）
 *
 * ── 三个必须先说清的口径（TechDesign 初稿在这三处都不清）──────────
 * ① **货币是字符，不是条数**。V1.1 的动态预算（`budget.ts` 的 `TokenBudget`）
 *    算出来的是字符额度；这里若再引一套"条数上限"，两套货币打架时无法预测
 *    实际注入。所以：条数只用于**保底额度**，总量完全由字符把控。
 * ② **按 `summary.length` 计数，因为注入的就是 summary**。
 *    初稿按 summary 计、注入全文时，16k 的"硬上限"实际能顶到 2~3 倍——
 *    安全阀变成心理安慰。计数口径与注入口径必须同一个字段。
 * ③ **保底条目也计入 `mainChars`**，但豁免"超预算就拒收"。
 *    否则保底与预算是两条互不相干的规则，合起来能突破任何上限。
 */

import type { RouteConfig, ScoredEntry } from './types.js'
import { quantileOver, type LayerTrace } from '../contract/layer.js'

export interface AllocationResult {
  main: ScoredEntry[]
  candidates: ScoredEntry[]
  /** 审计信息（回执与自检端点用） */
  info: {
    mainChars: number
    hardCap: number
    guaranteedUsed: number
    guaranteedQuota: number
    /** 因预算不足转入候选区的条数 */
    overflowed: number
    /** 因**条数硬上限**转入候选区的条数（与 overflowed 分开计：两者的修法不同） */
    capBlocked: number
    /** 因未过硬门禁被挡在 main 之外的条数 */
    gateBlocked: number
    /** 每个未进 main 的条目：hot-resident/gate/max-entries/gate-in/budget-chars */
    dropReasons: Record<string, string>
  /** 因已常驻（hot_order）被挡出动态段的条数（D1 去重投递） */
  dedupedBlocked: number
    /**
     * gate_in 的基准集合声明与实际取到的门槛值。
     *
     * `baseSet` 恒为 `'gatePassed'`（**不是** 'callAll'）；`value === null` 表示
     * 基准集合为空 → **不抬门槛、main 为空**。
     * 这两个字段存在的理由：让"相对量用了哪个基准"变成**可审计的运行期事实**，
     * 而不是注释里的一句承诺。
     */
    gateIn: { baseSet: 'gatePassed'; fraction: number; value: number | null; eligible: number }
  }
}

/** 条目注入体的字符数（注入 summary，所以数 summary） */
function injectedChars(entry: ScoredEntry): number {
  return (entry.meta.summary ?? '').length
}

/** 保底资格：身份卡，或 priority 达到阈值（口径 0~100，契约 §1.2） */
function isGuaranteed(entry: ScoredEntry, config: RouteConfig): boolean {
  const meta = entry.meta as { identity_card?: boolean; priority?: number }
  if (meta.identity_card === true) return true
  return Number(meta.priority) >= config.keep_alive_priority
}

/**
 * 分配：排序 → 硬门禁分流 → 保底 → 字符预算。
 *
 * 顺序不可交换：**先分流再算预算**，否则未过门禁的条目会先占掉字符额度，
 * 把有资格的条目挤进候选区（这是"预算被污染"的典型形态）。
 */
export function allocate(
  entries: ScoredEntry[],
  config: RouteConfig,
  trace?: LayerTrace,
  opts: { exclude?: (e: ScoredEntry) => boolean } = {},
): AllocationResult {
  const hardCap = config.budget.hard_cap
  const quota = config.budget.guaranteed_quota
  // 0 = 不限（默认）。非 0 时是**硬上限**，保底条目也计入 —— 见 RouteBudget.max_entries 注释。
  const maxEntries = config.budget.max_entries ?? 0

  const main: ScoredEntry[] = []
  const candidates: ScoredEntry[] = []
  let mainChars = 0
  let guaranteedUsed = 0
  let overflowed = 0
  let gateBlocked = 0
  let capBlocked = 0
  const dropReasons: Record<string, string> = {}

  // ⚠️ 分流必须**先于**分位数计算。原实现在全量里取 top 分算 gate_in，
  //    而 top 很可能是一条**已经被硬门禁拒掉**的高分联想候选——
  //    它的 99 分会把门槛抬到 0.5×99，导致真正有资格的条目（0.5）被挡在门外。
  //    实测这条在测试里直接暴露：main 变成空数组。
  const eligible: ScoredEntry[] = []
  let dedupedBlocked = 0
  for (const s of entries) {
    // ── 【D1 · 去重投递】已常驻条目**不再进动态段**（2026-10-09）──────────────
    // 面①（系统提示词 hot 段）每轮都在投它们，再在面②投一次 = **同一份内容付两次 token**，
    // 而且第二份进的还是"不可自替换"的那类通道。实测：某查询 6 个槽位里 **3 个**是常驻条目。
    // ⛔ 放在 eligible **之前**过滤 ⇒ **补位自动发生**（会照常取下一名），
    //    不需要另写补位逻辑 —— 那种"先选 6 条再剔除再补"的写法必然漏一条。
    if (opts.exclude?.(s)) {
      candidates.push(s)
      dedupedBlocked += 1
      dropReasons[s.meta.id] = 'hot-resident'
      continue
    }
    if (s.origin === 'emergent' && !s.gatePass) {
      candidates.push(s)
      gateBlocked += 1
      dropReasons[s.meta.id] = 'gate'
      continue
    }
    eligible.push(s)
  }

  eligible.sort((a, b) => b.score_in - a.score_in)

  // ── gate_in：相对量**必须声明基准集合** ──────────────────────────
  // 基准 = gatePassed（有资格竞争 main 的集合）。**绝不是 callAll**——
  // 门禁已把被拒的高分条目分出，让它们参与分位数的 top 会把门槛抬到荒谬的高度。
  // （V1.2 实测：99 分被拒项把门槛抬到 49.5，真该进的 0.5 分反被挡，main 变空。）
  const gateInSpec = { baseSet: 'gatePassed' as const, fraction: config.gate_in_keep_fraction, field: (x: ScoredEntry) => x.score_in }
  const gateInValue = quantileOver(eligible, gateInSpec)

  // publish 集合对象（供 trace 校验；不是手写字符串）
  trace?.publish('BUDGET', 'gatePassed', eligible)
  trace?.recordQL({
    layer: 'BUDGET',
    baseSet: 'gatePassed',
    fraction: config.gate_in_keep_fraction,
    size: eligible.length,
    value: gateInValue,
  })

  const gateInEff = gateInValue ?? Number.NEGATIVE_INFINITY

  for (const s of eligible) {
    // ⓪ 条数硬上限（0 = 不限）：**排在保底之前**，所以它连保底条目一起封顶。
    //    与"预算截断"分开记账：预算截断是"这轮装不下"，条数封顶是"这轮不想装那么多"。
    if (maxEntries > 0 && main.length >= maxEntries) {
      candidates.push(s)
      capBlocked += 1
      dropReasons[s.meta.id] = 'max-entries'
      continue
    }

    // ① 保底：身份卡 / 高优先级 —— 计入字符但豁免"超预算拒收"
    if (isGuaranteed(s, config) && guaranteedUsed < quota) {
      main.push(s)
      mainChars += injectedChars(s)
      guaranteedUsed += 1
      continue
    }

    // ② 常规：字符预算 + 分位数门槛
    // ⚠️ 空基准集合（gateInValue === null）时门槛为 -∞：**常识上"没人有资格"应导致 main 为空**，
    //    但那要另说——见下面 trace 校验与单测。这里保持"空集不放行"由 eligible 为空自然实现
    //    （eligible 空 → 循环不执行 → main 空）。之所以不把门槛设成 +∞，是为了让
    //    "空集合"与"全员低于门槛"两种情况在审计字段里可区分（value=null vs value=数值）。
    if (mainChars + injectedChars(s) <= hardCap && s.score_in >= gateInEff) {
      main.push(s)
      mainChars += injectedChars(s)
    } else {
      candidates.push(s)
      overflowed += 1
      dropReasons[s.meta.id] = s.score_in >= gateInEff ? 'budget-chars' : 'gate-in'
    }
  }

  // publish 本层声明的输出集合（main）——**不能少**：
  // 少了它 forgeCheck 会在真实链路上抛 ERR_CONTRACT_UNPUBLISHED_SET。
  // ⚠️ 这条恰好说明"单测里手写 trace 夹具"是不足的：夹具补了这步，实现没补，单测仍然全绿。
  //    真实路由链路才是最终判据。
  trace?.publish('BUDGET', 'main', main)

  return {
    main,
    candidates,
    info: {
      mainChars,
      hardCap,
      guaranteedUsed,
      guaranteedQuota: quota,
      capBlocked,
      overflowed,
      gateBlocked,
      dropReasons,
      // 【D1】因"已常驻"被挡出动态段的条数（⛔ 不许静默：它直接决定动态段的可用名额）
      dedupedBlocked,
      gateIn: {
        baseSet: 'gatePassed',
        fraction: config.gate_in_keep_fraction,
        value: gateInValue,
        eligible: eligible.length,
      },
    },
  }
}
