/**
 * 容器类型定义：对齐 容器规范_v1 的 index.json 契约
 */

export type Layer = 'hot' | 'archive' | 'longterm' | 'pending'

/** 记忆分类（认识论三分类）：V1.0 新增，与既有 type（fact/insight）并存不冲突 */
export type MemoryType = 'experience' | 'world' | 'opinion'

/** 写入操作类型：由「哪个工具被调用」决定，模型不可覆写 */
/**
 * 写操作类型（写进 frontmatter 的 `operation`，是**审计链**的一部分）。
 * `relocate` = 平级换层（hot ⇄ longterm ⇄ archive），⛔ 不等于 `confirm`（那是候选转正）。
 */
export type Operation = 'remember' | 'update' | 'forget' | 'propose' | 'confirm' | 'discard' | 'relocate'

/** 记忆作用域；旧容器未声明时按 global 处理，保持向后兼容。 */
export type MemoryScope = 'global' | 'workspace' | 'project'

/** 当前 DSH 档案允许读取的工作区/项目标识。 */
export interface MemoryScopeContext {
  workspaceId?: string
  projectId?: string
}

/** 读取时计算出的时间状态，不会擅自改写原始 Markdown。 */
export type TemporalState = 'active' | 'stale' | 'future' | 'expired' | 'superseded'

/**
 * V1.2 五字段的类型（2026-09-30 随路由引擎一同移植）。
 *
 * 为什么现在才补：路由打分要 `decay_type`（按类型衰减）与 `cold_start_until`
 * （冷启动豁免），而 V1.1 的 types 里没有它们。
 *
 * ⚠️ **诚实标注**：这些字段目前**只被读取，不被写入**。
 * 真正使用它们算 fresh 的衰减引擎属 V1.3，尚未实现——
 * 所以路由现在拿到的 `decay_type` 多半是 undefined，
 * 打分里的 fresh 项会退回 priority（与「甲方案 w2_pri=0 / fresh≡pri」一致）。
 */
export type DecayType = 'core' | 'recent' | 'process'
/** 生命周期（与 TemporalState/status 分开：这个是"回收"语义，不是"有效期"语义） */
export type LifecycleStatus = 'active' | 'archived'

/** index.json 中的单条条目元信息 */
export interface ContainerEntry {
  id: string
  layer: Layer
  title: string
  file: string
  tags: string[]
  priority: number
  updated: string
  summary: string
  /** 来源追溯（V1.2 起进索引；路由的涌现层标记要用它） */
  source?: string
  /** 【P0-6】是否存在 source_session（**存在性**，不是形状） */
  has_session?: boolean
  /** 【P0-6】会话 id 的可信度分类：host / legacy_literal / placeholder / absent */
  session_kind?: 'host' | 'legacy_literal' | 'placeholder' | 'absent' 
  // ── V1.2 五字段（2026-09-30 随路由移植；当前只读不写，见文件头 DecayType 注释）──
  decay_type?: DecayType
  last_accessed?: string
  access_count?: number
  /** 与 status 分开：这个是"回收"语义，不是"有效期"语义 */
  lifecycle?: LifecycleStatus
  /** 冷启动豁免截止；V1.2 里不参与打分，V1.3 衰减引擎才用 */
  cold_start_until?: string
  // ── V1.0 新增（全可选，缺失即旧行为）──
  memory_type?: MemoryType
  version?: number
  /** 去重锚点；P1 仅落库、不做查重拦截（见 TechDesign §6.2） */
  idem_key?: string
  /** 生命周期标记（active/stale/expired/superseded）；与 temporalState 是两个概念，见 TechDesign §3.2 */
  status?: string
  /**
   * 作用域与作用域标识（2026-09-15 索引补字段 · 压测评审清单 #2）。
   *
   * **为什么要进索引**：`/list` 原实现为拿这两个字段**逐条读文件**——2000 条时单次请求
   * 实测 1645ms。它们是两个小标量，进索引的代价远小于一次全量读盘。
   *
   * 缺失语义（与 `policy.memoryScope` / `isInScope` 严格一致，不许在此处放松）：
   *   - 无 `scope` → 视为 `global`（旧条目默认）
   *   - `scope=workspace|project` 且无 `scope_id` → **不放行**（不给通配符，安全边界）
   */
  scope?: MemoryScope
  scope_id?: string
  /**
   * 有效期与替代链（同样为 /list 元数据化服务）。
   * `temporal_state` 是纯函数，喂它这几个标量即可算出 active/stale/future/expired/superseded，
   * 无需读整个文件——这是 /list 能零读盘的最后一块。
   */
  valid_from?: string
  valid_to?: string
  expires?: string
  superseded_by?: string
  deleted_at?: string
  deleted_by?: string
  delete_reason?: string
  operator?: string
  operation?: Operation
  confirmed_at?: string
  confirmed_by?: string
}

/** 容器总索引（插件唯一入口） */
export interface ContainerIndex {
  schema: string
  generated_at: string
  source_root: string
  entry_count: number
  entries: ContainerEntry[]
  hot_order: string[]
  archive_index: Record<string, string[]>
  longterm_tags: Record<string, string[]>
}

/** 条目文件 frontmatter（解析后） */
export interface EntryFrontmatter {
  id: string
  layer: Layer
  title: string
  source: string
  source_line?: string
  source_session?: string
  source_message?: string
  /** 【P2】次事 subject（可多个；主事在会话级，不在这里） */
  about?: string[]
  /** 【修复】墓碑：删除者的来源（原作者的 source_* 原样保留） */
  deleted_source_session?: string
  deleted_source_message?: string
  created_at?: string
  scope?: MemoryScope
  scope_id?: string
  tags: string[]
  priority: number
  // ── V1.2 五字段（2026-09-30 随路由移植；当前只读不写）──
  decay_type?: DecayType
  last_accessed?: string
  access_count?: number
  lifecycle?: LifecycleStatus
  cold_start_until?: string
  /**
   * 逐条注入形态（2026-09-30）。缺省 `full`（不写这个字段行为不变）。
   *
   * - `full`：正文进系统提示词（身份/底线/协作/纪律这类**每轮都可能被引用**的条目）
   * - `summary`：只注入 summary（产出口径、版本号裁定这类**读一次就够**的条目）
   *
   * 为什么逐条而不是全局：全局 `personaMode` 开关会把上述两类绑在一起——
   * 要么全部全文（8,625 字符），要么全部摘要（829 字符），没有中间档。
   * 实测：热层全文占系统提示词（18,585 字符）的 46%。
   */
  hot_mode?: 'full' | 'summary'
  updated: string
  checksum: string
  summary: string
  volume?: string
  chapter?: string
  expires?: string
  valid_from?: string
  valid_to?: string
  supersedes?: string[]
  // 记忆演化闭环 v1（摊平标量，最小解析器兼容）
  type?: string            // fact | insight
  confidence?: number      // 0-100 硬分
  confidence_type?: string // 冗余，用 type 为准
  conf_source?: number     // ① 来源强度 (0-40)
  conf_verify?: number     // ② 验证强度 (0-30)
  conf_recurrence?: number // ③ 重现一致性 (0-20)
  conf_freshness?: number  // ④ 时效与冲突 (0-10)
  conflict_state?: string  // none | pending | resolved
  conflict_with?: string
  conflict_type?: string   // fact | insight
  conflict_resolution?: string // keep_new | keep_old | merge | coexist
  status?: string          // active | stale | expired | superseded
  expired_reason?: string
  superseded_by?: string
  last_verified?: string
  // ── V1.0 新增（全可选）──
  memory_type?: MemoryType
  version?: number
  idem_key?: string
  deleted_at?: string
  deleted_by?: string
  delete_reason?: string
  operator?: string
  operation?: Operation
  confirmed_at?: string
  confirmed_by?: string
}

/** 写入事务统一入参（内部类型，非工具入参） */
export interface WriteRecord {
  title: string
  content: string
  memory_type: MemoryType
  tags: string[]
  priority: number
  scope: MemoryScope
  scope_id?: string
  valid_from?: string
  valid_to?: string
  source_session: string
  source_message: string
  /** 【P2】次事 subject（只记录，不参与判定） */
  about?: string[]
  operation: Operation
  operator: string
  idem_key: string
  summary: string
  /** 写入目标层；remember 固定 longterm，propose 固定 pending */
  layer: Layer
  /**
   * 衰减类型（调用方显式指定，可缺省）。V1.2 接线（2026-10-03）：
   * 缺省时由 ingest.classifyDecayType 按 operation 推定（remember→recent / propose→process），
   * `core` **只能显式给**，不自动晋升。
   */
  decay_type?: string
}

/** hot_order 迁移快照：写入日志，用于事后审计「纠正是否动过常驻」 */
export interface HotOrderSnapshot {
  /** 迁移前的 hot_order */
  before: string[]
  /** 迁移后的 hot_order */
  after: string[]
  /** 因本次操作被移出 hot_order 的 id */
  removed: string[]
  /** 本次新增进 hot_order 的 id */
  added: string[]
}

/** 写入结果（四个工具与 CLI/HTTP 共用） */
export interface WriteOutcome {
  ok: boolean
  id?: string
  old_id?: string
  new_id?: string
  version?: number
  layer?: Layer
  mode?: 'tombstone' | 'purge'
  temporal_state?: TemporalState
  hot_order?: HotOrderSnapshot
  /**
   * 判重吸收（V1.2 接线，2026-10-03）：本次**没有新建条目**，而是命中了既有条目
   * 并记了一次 access。`id` 就是被命中的那条（与 outcome.id 相同）。
   */
  duplicate?: { via: 'content'; id: string }
  /**
   * 标题撞车提示（不合并）：标题与既有条目完全相同、但正文不同。
   * **刻意不自动合并** —— 合并 = 把两件事合成一件，是不可逆的语义损失（见 writer.absorbDuplicate 注释）。
   * 调用方（工具层）据此提示模型：要么用 memory_update 纠正既有条目，要么换个标题。
   */
  title_collision?: { id: string; title: string }
  /**
   * 【S2 · P1-5】跨作用域同文提示（不合并）：内容与**另一个 scope** 里的条目逐字相同。
   * 口径（Teddy 2026-10-08 拍板）：**跨 scope 不合并**——两边各归各（global ↔ project、
   * project A ↔ project B 都算跨）。把两件事合成一件是不可逆的语义损失；跨 scope 合并
   * 还会让项目记忆被全局记忆吸收。
   * 本次写入**照常新建**，只回这条提示；⛔ 不改对方条目的任何字段（访问计数也不动）。
   */
  scope_collision?: { id: string; scope: MemoryScope; scope_id?: string }
  /**
   * 本次遗忘**实际抹掉的版本数**（含被删的那条自身）。
   *
   * 2026-10-06（Teddy 拍板 (a)）：忘掉一条记忆 = 抹掉它的**整条版本血脉**。
   * 因为 `update` 不物理删除旧版、只标 `superseded`；只删当前版本的话，
   * 被纠正过的记忆的历史版本会原样留着（标题 / 摘要 / 正文都在）——"忘掉"就是假的。
   * 1 = 没被纠正过；>1 = 连同历史版本一起抹了。
   */
  wiped_versions?: number
  /**
   * 【P1 修复 · 2026-10-19】purge 的暂存文件未能真删（EPERM/EACCES/同步锁）。
   * 值 = 残留目录。出现它就说明“物理删除”没有彻底完成 —— 调用方必须看得见（⛔ 不许 ok:true 当没事）。
   */
  purge_leftover?: string[]
}

/** 条目文件完整内容 */
export interface ContainerEntryFile {
  frontmatter: EntryFrontmatter
  /** 正文 markdown（已剥离 frontmatter） */
  content: string
  /**
   * 【V1.3-A · G1】frontmatter 的**原始键值**（未补任何默认）。
   *
   * 为什么必须有它：`parseFrontmatter` 会补默认值（文件没写 `scope` 时给 `'global'`），
   * 于是"文件里明写了 global"与"文件里根本没写"在解析结果上**长得一模一样**。
   * 双真源对账要是拿这个视图去比索引，就会同时犯两个错：
   *   · 造假漂移 —— 索引按缺省不写 `scope`，却被判"文件有、索引没有"；
   *   · **掩盖真漂移** —— 真写了 `scope` 的条目与没写的无法区分。
   * 所以对账只认这份原始视图；带默认值的 `frontmatter` 是**消费方视图**。
   */
  raw?: Record<string, unknown>
}

/** 检索命中结果 */
export interface MemorySearchHit {
  id: string
  layer: Layer
  title: string
  tags: string[]
  score: number
  /** 命中片段（截取） */
  snippet: string
  file: string
  /** 透明解释为什么这条记忆被召回。 */
  reasons: string[]
  scope: MemoryScope
  scope_id?: string
  temporal_state: TemporalState
  source?: string
  source_line?: string
  source_session?: string
  source_message?: string
}
