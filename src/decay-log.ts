/**
 * **L4 全量 · 一份事务日志（append-only）+ 一个可重建的投影**
 *
 * ## 这个文件要解决什么（施工单 §一 的账单）
 *
 * 修前有**三条事件流说同一件事**——"谁、在什么时候、把哪条从哪层搬到哪层"：
 *
 * | 文件 | 它其实是这日志的哪一段 |
 * |---|---|
 * | `.decay-intent.jsonl`（打算搬谁） | **`begin` 段** |
 * | `.decay-audit.jsonl`（搬了谁） | **`step` 段** |
 * | `.decay-sweep.json`（上次何时/批次） | **`commit` 段 + 投影** |
 *
 * **⇒ 三者不是三件事，是同一事务的三个阶段。** 被人为拆成三个文件，才需要互相补——
 * 而"互相补"就是 `decay-sweep.ts` **一天 226 → 833 行**里那 **600 行对账**的来源
 * （`healAuditFromIntents` / `compactIntents` / `intentHealth` / 意图形状校验 …）。
 *
 * ## 铁律（本模块的立足点）
 *
 * > **从日志重建出来的投影，必须与盘上投影逐字节一致。**
 *
 * ⛔ 这一条成立，"日志是真源、投影是派生物"才是**被证明的**而不是被声明的。
 * 修前那三件**没有任何一条这样的判据**——所以才需要"自愈"那种东西。
 *
 * ## 事务语义（崩溃可识别）
 *
 * - `begin` → `step`* → `commit` ＝ 完整批次
 * - **`begin` 有、`commit`/`abort` 无 ＝ 崩在中途** ⇒
 *   **`step` 段照样生效**（条目**在盘上真的搬了**，⛔ 不假装没发生），
 *   但**事务被标记为未完成**、**`lastBatch` 不推进** ⇒
 *   **读者不需要 `intent` 来"补审计"**了 —— 因为"搬了哪些"本来就在 `step` 段里。
 * - `abort` ⇒ 显式记"这批没成"
 *
 * ## ⛔ 本模块**只读不写**（步 ①）
 *
 * 施工单是三步走：**① 只增**（本文件）→ ② 双写 → ③ 切读。
 * **本步不改任何旧件**：旧三件照旧写、读侧一字未动。
 */

/** 事务的四个阶段 —— 少一个都读不出"这批到底成没成" */
import fs from 'node:fs'
import path from 'node:path'

export type DecayLogPhase = 'begin' | 'step' | 'commit' | 'abort'

/**
 * 一步的**四态** —— ⛔ 不许只有"搬了"，"没搬"和"跳过了"同样要留痕（否则读不出判据）。
 *
 * ⭐【2026-10-15 修正 · 判据抓出来的】`intent` 与 `moved` **必须分开**：
 *
 * | 态 | 写在哪 | 意思 |
 * |---|---|---|
 * | `intent` | `relocate` **之前** | "**我要搬它**" —— 崩在中间时，读者知道"可能搬了没记上" |
 * | `moved` | `relocate` **之后**（审计那个点） | "**它确实被搬了**" —— 回滚靠它找批次 |
 *
 * ⛔ **原设计用一个 `move` 兼这两义** ⇒ `readAudit` 一合并就**撒谎**
 *   （把"打算搬"当成"搬成了"）。**F2 测试当场抓住**：
 *   `relocate 中途抛错 ⇒ 已搬的条目每条都有审计` ｜ expected: 4 ｜ actual: 5。
 */
export type DecayLogAction = 'intent' | 'moved' | 'block' | 'skip'

export interface DecayLogRecord {
  /** 批次 id（与旧 `batch` 同口径：`sweep-<时间戳>`） */
  txn: string
  /** 事务内序号，**从 0 起且连续** —— 跳号 = 日志被改过 */
  seq: number
  phase: DecayLogPhase
  at: number
  // ── begin ──
  dayKey?: string
  plan?: { pool: number; cap: number }
  // ── step ──
  id?: string
  action?: DecayLogAction
  from?: string
  to?: string
  why?: string
  cls?: string
  // ── commit ──
  /** 回滚事务提交时指向原始扫描批次；只有完整 begin→commit 才构成回滚事实 */
  rollbackOf?: string
  /** 本次回滚事务实际完成回滚的原始条目 ID */
  rolledBackIds?: string[]
  moved?: number
  blocked?: number
  archived?: string[]
  /**
   * ⭐【L4 步④a · 2026-10-15】**"上次自动扫描的绝对时刻"** —— 闸门「一天一次」判据的**真正依托**。
   *
   * ⛔ 为什么必须补：`state` 文件停写前，读侧要改走投影；而投影若没有这个字段，
   *   `sweepDecision` 里 `autoKey=null` ⇒ **同日判据整条失效**、退化成"每 6h 可跑一次"
   *   （实测事故：**07:39 扫过、14:31 又扫一遍** —— 见 `readSweepStateCompat` 注释）。
   * ⚠️ `force` 手动扫描**不推进它**（不占当天额度）⇒ 日志里照记当时的值，⛔ 不自己编。
   */
  lastAutoAt?: number
  // ── abort ──
  reason?: string
}

/** 投影 = **从日志重放出来的当前状态**（⛔ 不是另存的一份事实）*/
export interface DecayProjection {
  /** 最近一次**完成**批次的时刻（⛔ 未完成的批次不推进它） */
  lastCommitAt: number | null
  /** 最近一次**完成**批次的 txn id */
  lastBatch: string | null
  lastMoved: number
  /** ⭐ 最近一次完成批次记下的「上次自动扫描时刻」（⛔ 缺失 ⇒ 闸门同日判据会失效） */
  lastAutoAt: number | null
  /** 日志里出现过的全部已归档 id（按出现顺序） */
  archivedAll: string[]
  /** 按日志推进后的层归属：id → layer */
  layers: Record<string, string>
  /** **有 begin 没有 commit/abort 的事务** ＝ 崩在中途（⛔ 必须能报出来） */
  incompleteTxns: string[]
}

const EMPTY: DecayProjection = {
  lastCommitAt: null,
  lastBatch: null,
  lastMoved: 0,
  lastAutoAt: null,
  archivedAll: [],
  layers: {},
  incompleteTxns: [],
}

/**
 * **重放日志 → 投影。**
 *
 * ⛔ 不抛异常（日志坏了也要能读出"坏在哪"）；坏行/坏结构一律进 `problems`。
 * 这就是"篡改一行 ⇒ 必须报出不一致"那条判据的落点。
 */
export function replay(records: readonly DecayLogRecord[]): {
  projection: DecayProjection
  problems: string[]
} {
  const problems: string[] = []
  const p: DecayProjection = { ...EMPTY, archivedAll: [], layers: {}, incompleteTxns: [] }
  const seen = new Map<string, { seq: number; closed: boolean; beganAt: number }>()
  const order: string[] = []
  const movedByTxnId = new Map<string, { from: string; to: string }>()
  const rolledBackKeys = new Set<string>()

  for (let i = 0; i < records.length; i++) {
    const r = records[i] as DecayLogRecord
    const at = `第 ${i + 1} 条`
    if (!r || typeof r !== 'object') { problems.push(`${at}：不是对象`); continue }
    if (typeof r.txn !== 'string' || !r.txn) { problems.push(`${at}：缺 txn`); continue }
    if (typeof r.seq !== 'number' || !Number.isInteger(r.seq) || r.seq < 0) {
      problems.push(`${at}（${r.txn}）：seq 不是非负整数`); continue
    }
    if (!['begin', 'step', 'commit', 'abort'].includes(r.phase)) {
      problems.push(`${at}（${r.txn}）：未知 phase=${String(r.phase)}`); continue
    }
    if (typeof r.at !== 'number' || !Number.isFinite(r.at) || Math.abs(r.at) > 8.64e15) {
      problems.push(`${at}（${r.txn}）：at 必须是有限的 Unix 毫秒时间戳`); continue
    }

    const st = seen.get(r.txn)
    if (r.phase === 'begin') {
      if (st) { problems.push(`${at}（${r.txn}）：重复的 begin`); continue }
      if (r.seq !== 0) { problems.push(`${at}（${r.txn}）：begin 的 seq 必须是 0，实为 ${r.seq}`); continue }
      seen.set(r.txn, { seq: 0, closed: false, beganAt: r.at })
      order.push(r.txn)
      continue
    }
    if (!st) { problems.push(`${at}（${r.txn}）：没有 begin 就先出现 ${r.phase}`); continue }
    if (st.closed) { problems.push(`${at}（${r.txn}）：已 ${r.phase === 'commit' ? '提交' : '关闭'}后又有记录`); continue }
    if (r.seq !== st.seq + 1) {
      problems.push(`${at}（${r.txn}）：seq 跳号 —— 期望 ${st.seq + 1}，实为 ${r.seq}（日志被改过？）`)
      continue
    }
    st.seq = r.seq

    if (r.phase === 'step') {
      if (typeof r.id !== 'string' || !r.id.trim()) { problems.push(`${at}（${r.txn}）：step 缺少有效字符串 id`); continue }
      if (!r.action || !['intent', 'moved', 'block', 'skip'].includes(r.action)) {
        problems.push(`${at}（${r.txn}）：step 的 action 非法（${String(r.action)}）`); continue
      }
      // ⭐ 情形分三种（⛔ 这是"一条日志取代三件"的立足点）：
      //   · `moved`  ⇒ **确实搬了** ⇒ 推进层归属
      //   · `intent` ⇒ **只是想搬** ⇒ ⛔ **不推进**（崩在中途时它可能根本没搬成）
      //   · `block`/`skip` ⇒ 没搬
      if (r.action === 'moved') {
        if (typeof r.from !== 'string' || !r.from || typeof r.to !== 'string' || !r.to) {
          problems.push(`${at}（${r.txn}）：moved 缺 from/to`); continue
        }
        if (r.from !== 'longterm' || r.to !== 'archive') {
          problems.push(`${at}（${r.txn}）：moved 层跃迁非法（${r.from} → ${r.to}）`); continue
        }
        p.layers[r.id] = r.to
        movedByTxnId.set(`${r.txn}\u0000${r.id}`, { from: r.from, to: r.to })
      } else if (r.action === 'intent') {
        if (typeof r.from !== 'string' || !r.from || typeof r.to !== 'string' || !r.to) {
          problems.push(`${at}（${r.txn}）：intent 缺 from/to`); continue
        }
        if (r.from !== 'longterm' || r.to !== 'archive') {
          problems.push(`${at}（${r.txn}）：intent 层跃迁非法（${r.from} → ${r.to}）`); continue
        }
      }
      continue
    }

    st.closed = true
    if (r.phase === 'commit') {
      const hasRollback = r.rollbackOf !== undefined || r.rolledBackIds !== undefined
      if (hasRollback) {
        if (typeof r.rollbackOf !== 'string' || !r.rollbackOf ||
            !Array.isArray(r.rolledBackIds) ||
            r.rolledBackIds.some((id) => typeof id !== 'string' || !id.trim()) ||
            new Set(r.rolledBackIds).size !== r.rolledBackIds.length) {
          problems.push(`${at}（${r.txn}）：回滚提交缺少有效 rollbackOf/rolledBackIds`)
          continue
        }
        for (const id of r.rolledBackIds) {
          const key = `${r.rollbackOf}\u0000${id}`
          const source = movedByTxnId.get(key)
          if (!source || source.from !== 'longterm' || source.to !== 'archive' || rolledBackKeys.has(key)) {
            problems.push(`${at}（${r.txn}）：回滚条目没有唯一可信 moved 来源或已回滚：${id}`)
            continue
          }
          rolledBackKeys.add(key)
          p.layers[id] = 'longterm'
        }
      } else {
        p.lastCommitAt = r.at
        p.lastBatch = r.txn
        p.lastMoved = typeof r.moved === 'number' ? r.moved : 0
        p.lastAutoAt = typeof r.lastAutoAt === 'number' ? r.lastAutoAt : null
        if (Array.isArray(r.archived)) {
          for (const id of r.archived) if (!p.archivedAll.includes(id)) p.archivedAll.push(id)
        }
      }
    }
    // abort：显式关闭，⛔ 不推进 lastCommitAt/lastBatch（"这批没成"）
  }

  for (const t of order) {
    const st = seen.get(t)!
    if (!st.closed) p.incompleteTxns.push(t)
  }
  return { projection: p, problems }
}

/**
 * **逐字节比较**：投影一致吗？（施工单里最硬的那条判据的入口）
 * ⚠️ 用**规范化 JSON**（键序固定）比，⛔ 不用 `===`（对象引用比不出内容）。
 */
export function projectionFingerprint(p: DecayProjection): string {
  const norm = {
    lastCommitAt: p.lastCommitAt,
    lastBatch: p.lastBatch,
    lastMoved: p.lastMoved,
    lastAutoAt: p.lastAutoAt,
    archivedAll: [...p.archivedAll],
    layers: Object.fromEntries(Object.entries(p.layers).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    incompleteTxns: [...p.incompleteTxns].sort(),
  }
  return JSON.stringify(norm)
}

/** 序列化一行（⛔ 不写盘、不碰文件 —— 落盘由调用方决定，步 ① 只提供能力）*/
export function serializeRecord(r: DecayLogRecord): string {
  return JSON.stringify(r)
}

/** 逐行解析（容错；坏行进 problems）—— 与 `replay` 的"坏行要报出来"同一条原则 */
export function parseLog(text: string): { records: DecayLogRecord[]; problems: string[] } {
  const records: DecayLogRecord[] = []
  const problems: string[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      records.push(JSON.parse(line) as DecayLogRecord)
    } catch (e) {
      problems.push(`第 ${i + 1} 行不是合法 JSON：${String((e as Error)?.message ?? e).slice(0, 60)}`)
    }
  }
  return { records, problems }
}

// ══════════════════════════════════════════════════════════════════════
// 步 ②「双写」的**写**侧（2026-10-15）
//
// ⛔ 纪律：**新日志与旧三件同写，读侧仍走旧的。**
// ⛔ 而且：**新的坏了不能影响旧的** —— 所以这里**吞异常、只回报**，⛔ 绝不抛给扫描。
//    （扫描是正事，记账是次要点；这条与旧 `appendIntent` 的口径一致。）
// ══════════════════════════════════════════════════════════════════════

/** 日志文件名（相对容器根） */
export const SWEEP_LOG_FILE = '.sweep-log.jsonl'

/** 追加一批记录（append-only：⛔ 不读改写、⛔ 不截断）。**失败不抛**。 */
export function appendLog(root: string, records: readonly DecayLogRecord[]): { ok: boolean; err?: string } {
  if (!records.length) return { ok: true }
  try {
    fs.appendFileSync(path.join(root, SWEEP_LOG_FILE), records.map(serializeRecord).join('\n') + '\n', 'utf-8')
    return { ok: true }
  } catch (e) {
    return { ok: false, err: String((e as Error)?.message ?? e).slice(0, 160) }
  }
}

/** 启动期对账：日志里有 begin 但没有 commit/abort 的事务（半批/崩溃现场）。⛔ 只报告，不自动修。 */
export function readIncompleteSweeps(root: string): { txns: string[]; problems: string[] } {
  const { records, problems } = readLog(root)
  return { txns: replay(records).projection.incompleteTxns, problems }
}

/** 读整份日志（⛔ 容错：坏行进 problems，不抛） */
export function readLog(root: string): { records: DecayLogRecord[]; problems: string[] } {
  try {
    const f = path.join(root, SWEEP_LOG_FILE)
    if (!fs.existsSync(f)) return { records: [], problems: [] }
    return parseLog(fs.readFileSync(f, 'utf-8'))
  } catch (e) {
    return { records: [], problems: [`读日志失败：${String((e as Error)?.message ?? e).slice(0, 120)}`] }
  }
}
