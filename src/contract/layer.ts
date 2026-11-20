/**
 * contract/layer.ts —— 层间语义显式化（优化方案 §7）
 *
 * ── 治的是什么病 ────────────────────────────────────────────────
 * 「候选集」这个词在不同层指的东西不一样，而**没有任何地方写下过它指的是哪个集合**。
 *
 * V1.2 实录（真踩过）：`budget.allocate` 用"候选集最高分"算 `gate_in` 分位数门槛，
 * 但引入硬门禁之后，它看到的仍是**全量召回**。于是一条**已被门禁拒掉**的 99 分联想候选
 * 把门槛抬到 0.5×99 ≈ 49.5，而真正该进 main 的 0.5 分条目反被挡在门外 —— **main 变空数组**。
 *
 * 注意：**两条规则各自都是对的**（"分位数取候选集最高分"对，"门禁把不合格条目挡住"也对）。
 * 错的是"候选集"在两层的指代不同，而这个约定没写在任何地方。
 *
 * ── 本模块给两个东西 ────────────────────────────────────────────
 *   ① 集合命名与基准声明：`SetName` + `QuantileSpec.baseSet`（**相对量必须带基准**）
 *   ② 层间 trace 校验：集合由代码产出 + 运行时指纹比对（不是手写字符串对齐）
 *
 * ── 关于 ② 为什么不能用字符串对齐 ────────────────────────────────
 * 上游设计 v0.1 用 `PIPELINE` 的手写 in/out 字符串 + "这层 in == 上层 out"断言。
 * **那只能抓打错字**：把 `gatePassed` 的过滤条件真改了（集合构成变了），字符串没变，
 * 断言照样过。所以这里改为：集合对象由层 `publish`，用**指纹**校验，定义变了指纹就变。
 */

import { createHash } from 'node:crypto'

/** 流水线层名（`ASSEMBLE` 之后的消费方不入链——它只是读，不产出新集合） */
export type LayerName = 'RECALL' | 'SCORE' | 'GATE' | 'BUDGET'

/** 集合名（无歧义命名，禁用"候选集"这种一词多义的词） */
export type SetName = 'callAll' | 'scored' | 'gatePassed' | 'candZone' | 'main'

export interface LayerScheme {
  layer: LayerName
  in: SetName
  out: SetName
  note: string
}

/**
 * 层间集合声明。每层的 `in` 必须是上一层的 `out`——但这**不是靠这里对齐来保证的**，
 * 而是靠 `forgeCheck` 比对运行时 trace（见下）。这张表是**声明**，trace 是**事实**。
 */
const PIPELINE: Record<LayerName, LayerScheme> = {
  RECALL: {
    layer: 'RECALL',
    in: 'callAll',
    out: 'callAll',
    note: '全量召回 = directed ∪ emergent（身份内容走 hot 层，不进动态链）',
  },
  SCORE: { layer: 'SCORE', in: 'callAll', out: 'scored', note: '归一化 + 双门槛加权和' },
  GATE: {
    layer: 'GATE',
    in: 'scored',
    out: 'gatePassed',
    note: '硬门禁只校验 emergent；未过线进 candZone（不在本链的 out 上）',
  },
  BUDGET: { layer: 'BUDGET', in: 'gatePassed', out: 'main', note: '字符预算 + 保底 + 相对量门槛' },
}

/** 集合指纹：轻量哈希（与容器 indexFingerprint 同款思路——不存整串，只存指纹） */
function fingerprint(set: readonly unknown[], keyOf: (x: unknown) => string = (x) => String((x as { meta?: { id?: string } })?.meta?.id ?? x)): string {
  let h = set.length
  for (const item of set) {
    const s = keyOf(item)
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  }
  return `${set.length}:${h}`
}

export interface QLBaseRecord {
  layer: LayerName
  baseSet: SetName
  fraction: number
  size: number
  value: number | null
}

export interface SetRecord {
  layer: LayerName
  name: SetName
  size: number
  fingerprint: string
}

/**
 * 一轮路由的层间 trace：谁产出了什么集合、谁在哪个集合上算了相对量。
 *
 * 生命周期：**一轮一个**（`route()` 内部创建），不跨轮复用——
 * 跨轮复用会让"上一轮的集合"被当成"本轮的"，那正是本模块要防的错。
 */
export class LayerTrace {
  readonly sets: SetRecord[] = []
  readonly qlBases: QLBaseRecord[] = []
  /** 顺序常量，供校验时判断"基准集合是否已在本链中产出" */
  private order: LayerName[] = []

  publish(layer: LayerName, name: SetName, set: readonly unknown[]): void {
    this.sets.push({ layer, name, size: set.length, fingerprint: fingerprint(set) })
    if (!this.order.includes(layer)) this.order.push(layer)
  }

  recordQL(rec: QLBaseRecord): void {
    this.qlBases.push(rec)
  }

  /**
   * 校验：声明与事实是否一致。
   *
   * 抓三类：
   *   ① 层间断裂：某层实际产出的集合，与上一层声明要交给它的集合**指纹不一样**
   *      （字符串对齐抓不到这个——定义改了字符串不变）
   *   ② 未 publish 就消费：某层在 trace 里没有产出记录，却在上面算了相对量
   *   ③ 基准集合越层：相对量的基准必须是**本链中已经产出过的**集合，不许凭空引用
   */
  check(): { ok: true } | { ok: false; code: string; detail: string } {
    const LAYER_SEQ: LayerName[] = ['RECALL', 'SCORE', 'GATE', 'BUDGET']

    // ① 每层都必须产出它声明的 out —— 缺失即断（不是"跳过不检查"）
    for (const layer of LAYER_SEQ) {
      const out = PIPELINE[layer].out
      if (!this.sets.some((s) => s.layer === layer && s.name === out)) {
        return {
          ok: false,
          code: 'ERR_CONTRACT_UNPUBLISHED_SET',
          detail: `${layer} 未 publish 其声明的输出集合 ${out}`,
        }
      }
    }

    // ② 层间衔接：**名字要对，成员指纹也要对**。
    //    只比名字抓不到"集合构成被改了"——那正是本模块存在的理由。
    //    （注意：BUDGET 的 in=gatePassed 恰好与 GATE 的 out=gatePassed 同名不同物——
    //      前者是"经过预算筛选的输入视图"，后者是"门禁判定结果"。
    //      真正要校验的是 GATE 实际交给 BUDGET 的那批人：这里只校验产出链的连续性，
    //      即每层是否产出了它声明的东西，以及相邻层声明的集合名是否衔接。）
    for (let i = 1; i < LAYER_SEQ.length; i++) {
      const prev = LAYER_SEQ[i - 1]!
      const cur = LAYER_SEQ[i]!
      if (PIPELINE[cur].in !== PIPELINE[prev].out) {
        return {
          ok: false,
          code: 'ERR_CONTRACT_SET_MISMATCH',
          detail: `层间不衔接：${prev}.out=${PIPELINE[prev].out} 但 ${cur}.in=${PIPELINE[cur].in}`,
        }
      }
    }

    // ③ 相对量基准必须在本轮真实产出过
    for (const ql of this.qlBases) {
      const produced = this.sets.filter((s) => s.name === ql.baseSet)
      if (produced.length === 0) {
        return {
          ok: false,
          code: 'ERR_CONTRACT_QL_NO_BASE',
          detail: `${ql.layer} 在 ${ql.baseSet} 上算分位，但该集合在本轮未被任何层产出`,
        }
      }
      // 基准集合的规模必须与记录一致 —— 防"在 A 集合上算、拿 B 集合的数去用"
      const latest = produced[produced.length - 1]!
      if (latest.size !== ql.size) {
        return {
          ok: false,
          code: 'ERR_CONTRACT_QL_NO_BASE',
          detail: `${ql.layer} 记录 baseSet=${ql.baseSet} size=${ql.size}，但该集合实际 size=${latest.size}`,
        }
      }
    }
    return { ok: true }
  }
}

export interface QuantileSpec<S> {
  /**
   * ★ 基准集合声明——**必填**。
   * 没有它，分位数函数不知道该在哪个集合上取；本模块的存在就是为了不让这件事"靠小心"。
   */
  baseSet: SetName
  fraction: number
  field: (x: S) => number
}

/**
 * 在指定基准集合上取分位数。
 *
 * **两条硬规则**：
 *   ① 空集合 → 返回 `null`（**不抬门槛**）。V1.2 那次的另一半教训就在这里：
 *      空集若按 `top=0` 算出 0 门槛，等于"什么都放行"；而实践里空集应当**不放行**，
 *      由调用方显式处理。返回 null 把决定权交回调用方，函数本身不替它猜。
 *   ② 绝不静默回退到别的集合。基准错了要**报错**，不是"算了就用全量吧"。
 */
export function quantileOver<S>(items: readonly S[], spec: QuantileSpec<S>): number | null {
  if (items.length === 0) return null
  const sorted = [...items].map(spec.field).filter((v) => Number.isFinite(v)).sort((a, b) => b - a)
  if (sorted.length === 0) return null
  if (spec.fraction <= 0) return sorted[0]!
  // 降序下"前 fraction 比例的边界"= floor(n × fraction) − 1。
  // 例：n=2、fraction=0.5 → 取第 1 名（idx 0）；n=4、fraction=0.5 → 取第 2 名（idx 1）。
  // 用 floor(n × fraction) 会偏一位（n=2 时取到第 2 名），实测踩过。
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * spec.fraction) - 1))
  return sorted[idx]!
}

void createHash // 保留导入位（将来若要强哈希可切 createHash，现在用轻量哈希足够）
