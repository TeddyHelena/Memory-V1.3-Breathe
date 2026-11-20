/**
 * contract/fields.ts —— 双真源「必须同步字段」契约（V1.3-A · G1）
 *
 * ── 治的是什么病 ────────────────────────────────────────────────
 * 容器有两个真源：**条目文件的 frontmatter**（唯一持久化真源）与 **index.json**（派生索引）。
 * 「哪些字段必须镜像进索引」这件事，原先**没有任何地方写过**，靠开发者记性维持：
 * 新增一个字段，要在七处分别记得改；漏一处，两端**都不报错**，只是静默地少一个字段。
 *
 * V1.2 实录（真踩过）：第 5 处漏了 `decay_type` / `last_accessed` / `access_count` /
 * `lifecycle` / `cold_start_until` ⇒ **文件里有、索引里没有**，**223 项测试一条都没报**。
 * 当时的修法是给这五个字段补断言 —— 那是给**字段**上的锁，不是给**机制**上的。
 *
 * V1.3-A 开工前实测（先红证据，2026-10-09）：把索引里 `h01` / `l70` 的 `decay_type`
 * 删掉，**四个出口全哑** —— `/list` 的 drift 判据报 0 条、`drift-audit` C 段报「不符 0 处」、
 * `container.load({verify:true})` 通过且无告警、路由侧读到 `undefined` 后静默按未分类处理。
 * 根因就是 `container.validate()` 里那句「单侧缺值 = 隐含默认，不是漂」——
 * 它本意是放过旧条目，实际把**索引陈旧**也一起放过了。
 *
 * ── 本模块给三个东西 ────────────────────────────────────────────
 *   ① **判定准则**（三条，不是一张会过期的表）：见下 `RULE_*`
 *   ② **字段注册表**：每个字段的镜像去向 + 缺省语义 + 归属准则
 *   ③ **单一漂移判据**：`diffEntryFields()` —— `/list`、容器自校验、`/selftest`
 *      以及未来的消费方**共用同一处实现**（⛔ 不许各自另写一份）
 *
 * ── 为什么判定用"准则 + 注册表"而不是只给一张表 ──────────────────
 * 表会过期：加字段的人不知道有这张表存在。准则不会——它回答的是
 * "这个字段该不该进索引"，而这个问题在任何时候都有同一个答案。
 * 防漂移靠 `test/contract-fields.test.mjs`：**新增字段没登记 ⇒ 测试红**。
 */

// ════════════════════════════════════════════════════════════
// 一、判定准则（三条，按顺序问，先命中先算）
// ════════════════════════════════════════════════════════════

/**
 * R1 —— **被索引驱动的读路径消费** ⇒ 必须镜像。
 *
 * 判据不是"谁需要"，而是"**这条路线上有没有文件**"：
 * `/list`、检索、路由、图谱、设置页列表这些路径**不读文件**（读文件就是 O(n) 读盘，
 * @2000 实测 1645ms，V1.1 专门治过），它们只吃索引。字段在这条线上被用 ⇒ 必须进索引。
 */
const RULE_MIRROR_READ_PATH = 'R1'

/**
 * R2 —— **只在单条详情 / 写路径内部使用** ⇒ 不镜像。
 *
 * 反例（刻意不镜像）：`supersedes`（替代链，写事务内部用）、`hot_mode`（装配期逐条读文件）、
 * `checksum`（发布/修复脚本用）。把它们塞进索引**不解决问题，只增加要同步的地方**。
 */
const RULE_FILE_ONLY_DETAIL = 'R2'

/**
 * R3 —— **用于校验 / 审计而非读侧决策** ⇒ 不镜像。
 *
 * `checksum` 是这一类：它的消费者是启动抽样校验与修复脚本，不是路由。
 * ⚠️ 与 R2 的区别是"这个字段该不该有校验"，不是"谁读它"——两条都通往 file-only，
 * 但理由不同，写下来是为了**下一个人改分类时知道当初为什么**。
 */
const RULE_FILE_ONLY_AUDIT = 'R3'

export type FieldRule = typeof RULE_MIRROR_READ_PATH | typeof RULE_FILE_ONLY_DETAIL | typeof RULE_FILE_ONLY_AUDIT

// ════════════════════════════════════════════════════════════
// 二、字段注册表（唯一真源）
// ════════════════════════════════════════════════════════════

export type MirrorClass = 'mirror' | 'file-only'

export interface FieldSpec {
  /** frontmatter 字段名（与 `EntryFrontmatter` 一致） */
  readonly name: string
  /** 镜像去向 */
  readonly mirror: MirrorClass
  /** 归属准则 */
  readonly rule: FieldRule
  /**
   * **登记好的缺省值**：文件侧没有这个字段时，索引侧该是什么。
   *
   * 派生视图允许补默认值（`status` 缺省就是 `active`），但**默认值必须登记在这里**，
   * 且判定时按"索引值 == 登记默认"来认——否则索引凭空多出一个别人不知道的值，就是漂移。
   *
   * `undefined` = **没有默认**：这时文件缺、索引有 = 索引凭空多出东西（漂移）；
   * 两侧都缺 = 数据缺口（如实计数，⛔ 不许拿默认值静默顶替）。
   */
  readonly defaultWhenAbsent?: string | number
  /**
   * **两侧都缺**时的性质（只对 `mirror` 字段有意义）。三档，对应三种**不同的动作**——
   * 混成一档就会出现"看得懂但没法下手"或"看不见"：
   * - `'normal'`（缺省）：这个字段本来就是可选的 —— 大多数记忆没有 `valid_to`、
   *   没有墓碑字段、没有 `scope_id`。两侧都缺 = **常态**，⛔ 不计数
   *   （实测第一版把 112 条的 `valid_to` 全算成缺口，1367 处噪声盖住 51 处真信号）。
   * - `'gap'`：**该有值却没有，且能真回填** ⇒ 数据缺口，归回填（G2）。
   * - `'legacy'`：**该有值却没有，但不可重建** ⇒ 历史遗留，⛔ 不许编一个值糊上，
   *   单独计数、如实列出。只登记**V1.3 读得到的那些**，其余留给各自专项。
   */
  readonly absence?: 'normal' | 'gap' | 'legacy'
  /** 为什么这样归类（一句话，给下一个改分类的人看） */
  readonly why: string
}

/**
 * 注册表。**加字段先来这里登记，再去改落点**（否则 `test/contract-fields.test.mjs` 会红）。
 *
 * 排序：先镜像字段（按消费路径分组），后 file-only 字段。
 */
export const FIELD_REGISTRY: readonly FieldSpec[] = [
  // ── 结构性核心（R1）────────────────────────────────────────────
  { name: 'id', mirror: 'mirror', rule: RULE_MIRROR_READ_PATH, why: '索引与文件对账的锚点，两侧必须都有' },
  { name: 'layer', mirror: 'mirror', rule: RULE_MIRROR_READ_PATH, why: '分层列表/归档视图按它分组，两侧必须都有' },
  { name: 'title', mirror: 'mirror', rule: RULE_MIRROR_READ_PATH, why: '/list、检索、人脸卡都读它' },
  { name: 'tags', mirror: 'mirror', rule: RULE_MIRROR_READ_PATH, why: '检索按标签命中，读索引不读文件' },
  { name: 'priority', mirror: 'mirror', rule: RULE_MIRROR_READ_PATH, why: '路由打分（normPri）与保底配额都吃它' },
  /**
   * ⚠️ 2026-10-16 更正 `why`（**改的是描述，不是规则**——mirror 类别没动）。
   * 原文写的是「/list 排序与陈旧判定；索引指纹也用它」，**前两项与代码不符**（逐处核过）：
   *   · 全仓没有任何排序吃 `updated`（`/list` 的排序在 API 层，不吃它）；
   *   · 陈旧判定吃的是 `last_accessed`（`route/fresh.ts` 的 `freshForEntry`），⛔ 不是 `updated`。
   * 它真实的**决策**用途只有一个：索引指纹（`container.ts` `indexFingerprintOf` 的 `id|file|updated`）
   * ⇒ 指纹变 ⇒ 清文档/语料缓存。其余是**展示面**（面板「更新日期」）。
   * 作者 2026-10-16 拍：「`updated` 只做元数据，不参与决策」——与上面这条实测一致。
   */
  { name: 'updated', mirror: 'mirror', rule: RULE_MIRROR_READ_PATH, why: '展示面（面板更新日期）+ 索引指纹（id|file|updated）；⛔ 不参与排序/陈旧/衰减判定' },
  { name: 'summary', mirror: 'mirror', rule: RULE_MIRROR_READ_PATH, absence: 'legacy', why: '摘要注入形态（hot_mode=summary）与列表副标题' },

  // ── 作用域（R1，安全边界）──────────────────────────────────────
  {
    name: 'scope', mirror: 'mirror', rule: RULE_MIRROR_READ_PATH, defaultWhenAbsent: 'global',
    why: '/list 可见性判定与路由 scope 过滤；缺省语义＝global（与 policy.memoryScope 严格一致）',
  },
  {
    name: 'scope_id', mirror: 'mirror', rule: RULE_MIRROR_READ_PATH,
    why: 'project/workspace 作用域的判定依据；缺它＝**不放行**（不给通配符，安全边界，所以刻意不登记默认）',
  },

  // ── 时间状态（R1）──────────────────────────────────────────────
  /**
   * 【L2-T2 · 2026-10-15 · 作者 拍 A / A2】**`status` 有两义**：
   *   ① **人工标记到期**（`status='expired'`）—— ⚠️ 这是**第二个到期来源**（与时间边界并列）；
   *   ② **只读溯源**（`active` / `superseded`）。
   * ⛔ **但"判到期"只准 `temporalState` 一个函数做**（唯一判定出口）——
   *    其他**决策点**不得自己问 `status`；**展示/统计/UI 读它是允许的**（A2）。
   * 病灶（10-09）：真身 `a36` `status=active` 但已过期 ⇒ 引擎不注入、面板曾画"活跃"。
   * 真身盘点：`active` 104 / `superseded` 14 / `expired` 7 / 缺 1。
   */
  { name: 'status', mirror: 'mirror', rule: RULE_MIRROR_READ_PATH, defaultWhenAbsent: 'active', why: '**人工标记到期 + 只读溯源**（⛔ 判到期只准 `temporalState`，其他决策点不得问）；缺省语义即 active' },
  { name: 'valid_from', mirror: 'mirror', rule: RULE_MIRROR_READ_PATH, why: 'temporal_state 的 future 判定' },
  /**
   * 【L2-T1 · 2026-10-15 · 作者 拍 · **2026-10-15 修方向**】**`valid_to` 为正、`expires` 降为只读别名。**
     * ⛔ **本行曾把方向写反**：原文写"`expires` 为正"，与**同一段的理由**
     * （"引擎现状就是 `valid_to ?? expires`"）**互斥** —— 若真按"`expires` 为正"，就得**改引擎优先级**，
     * 那就不叫"与现实同向/最小迁移"了。**是独立审稿（fresh eyes）抓出来的**（它指出本行与施工稿
     * §四 主线二"以 `valid_to` 为正（引擎现在就是 `valid_to ?? expires`）"方向互斥）。
     * ⇒ 以**引擎原文**（`hot-invalidation.ts:18`："取一个条目上的'到期时刻'（`valid_to ?? expires`…）"）
     * 与**施工稿**为准：**`valid_to` 先取 ⇒ 为正**。
   * 裁决依据：引擎现状就是 `temporalState(valid_to ?? expires)` ⇒ **裁决与现实同向**（最小迁移）。
   * 真身盘点（126 条）：`expires` **1 条**（`a36`）· `valid_to` **0 条** ⇒ **无数据要搬**，只改契约口径。
   * ⛔ **不删 `valid_to`**（盘上契约，旧代码继续读得到）。
   */
  { name: 'expires', mirror: 'mirror', rule: RULE_MIRROR_READ_PATH, why: '**有效期的正名**（唯一写入口 = `/entry-expire`）' },
  { name: 'valid_to', mirror: 'mirror', rule: RULE_MIRROR_READ_PATH, why: '**只读别名**（与 `expires` 同义；⛔ 真身 0 条，仅兼容旧代码继续读）' },
  { name: 'superseded_by', mirror: 'mirror', rule: RULE_MIRROR_READ_PATH, why: 'hot_order 残留检查与替代链展示' },

  // ── 路由/衰减（R1，V1.3-B 的读数来源）──────────────────────────
  { name: 'decay_type', mirror: 'mirror', rule: RULE_MIRROR_READ_PATH, absence: 'gap', why: '衰减引擎按类型选曲线，路由只读索引。**刻意不登记默认**——未分类必须被看见并回填，不许静默当成 recent' },
  { name: 'last_accessed', mirror: 'mirror', rule: RULE_MIRROR_READ_PATH, absence: 'gap', why: '衰减引擎算 t 的起点，路由只读索引' },
  { name: 'access_count', mirror: 'mirror', rule: RULE_MIRROR_READ_PATH, defaultWhenAbsent: 0, why: 'lifecycle 晋升与反马太的输入；缺省即 0 次访问' },
  { name: 'lifecycle', mirror: 'mirror', rule: RULE_MIRROR_READ_PATH, defaultWhenAbsent: 'active', why: '回收语义（active/archived），与 status 分开；缺省即 active' },
  { name: 'cold_start_until', mirror: 'mirror', rule: RULE_MIRROR_READ_PATH, why: '**溯源标记**：这条的 last_accessed 是回填时编的（A 段回填打的）。⛔ **不是**豁免开关——「豁免衰减」那一义 2026-10-09 已取消（只写不读、从未生效）' },
  { name: 'memory_type', mirror: 'mirror', rule: RULE_MIRROR_READ_PATH, why: '/list 与检索的分型展示' },
  { name: 'version', mirror: 'mirror', rule: RULE_MIRROR_READ_PATH, defaultWhenAbsent: 1, why: '版本链展示与 supersede 判定；首版不写 version，语义即 1' },
  { name: 'source', mirror: 'mirror', rule: RULE_MIRROR_READ_PATH, absence: 'legacy', why: '来源追溯；路由涌现层标记要用它（V1.2 起进索引）。实测 42 条索引陈旧，见 V1.3-A 验收报告' },
  { name: 'idem_key', mirror: 'mirror', rule: RULE_MIRROR_READ_PATH, why: '去重锚点，写侧要按索引查重' },

  // ── 墓碑/审计标量（R1：列表与详情都要看，且是小标量）────────────
  { name: 'deleted_at', mirror: 'mirror', rule: RULE_MIRROR_READ_PATH, why: '墓碑展示与残留判定' },
  { name: 'deleted_by', mirror: 'mirror', rule: RULE_MIRROR_READ_PATH, why: '墓碑来源（人/模型/脚本）' },
  { name: 'delete_reason', mirror: 'mirror', rule: RULE_MIRROR_READ_PATH, why: '墓碑原因' },
  { name: 'operator', mirror: 'mirror', rule: RULE_MIRROR_READ_PATH, why: '写入者标识，列表与审计要读' },
  { name: 'operation', mirror: 'mirror', rule: RULE_MIRROR_READ_PATH, why: '写入动作类型（remember/propose/confirm…）' },
  { name: 'confirmed_at', mirror: 'mirror', rule: RULE_MIRROR_READ_PATH, why: '候选转正时间，候选视图要用' },
  { name: 'confirmed_by', mirror: 'mirror', rule: RULE_MIRROR_READ_PATH, why: '转正者标识' },

  // ── file-only：只走详情 / 写路径（R2）──────────────────────────
  { name: 'source_line', mirror: 'file-only', rule: RULE_FILE_ONLY_DETAIL, why: '详情页展示用，单条读取即可' },
  { name: 'source_session', mirror: 'file-only', rule: RULE_FILE_ONLY_DETAIL, why: '幂等锚点的计算输入（写路径消费）；列表/检索不读它' },
  { name: 'source_message', mirror: 'file-only', rule: RULE_FILE_ONLY_DETAIL, why: '同上，幂等锚点的计算输入' },
  { name: 'created_at', mirror: 'file-only', rule: RULE_FILE_ONLY_DETAIL, why: '详情页展示；列表排序用 updated，不是它' },
  { name: 'hot_mode', mirror: 'file-only', rule: RULE_FILE_ONLY_DETAIL, why: '装配期逐条读文件时判定，索引不必知道' },
  { name: 'volume', mirror: 'file-only', rule: RULE_FILE_ONLY_DETAIL, why: '来源卷册，仅详情页展示' },
  { name: 'chapter', mirror: 'file-only', rule: RULE_FILE_ONLY_DETAIL, why: '来源章节，仅详情页展示' },
  { name: 'supersedes', mirror: 'file-only', rule: RULE_FILE_ONLY_DETAIL, why: '替代链**写事务内部**用（撤销整条血缘），读侧不消费' },
  { name: 'about', mirror: 'file-only', rule: RULE_FILE_ONLY_DETAIL, why: 'P2 次事 subject：只记录，不参与判定、不刷时间' },
  { name: 'deleted_source_session', mirror: 'file-only', rule: RULE_FILE_ONLY_DETAIL, why: '墓碑：删除者会话 id（原作者 source_* 保留）' },
  { name: 'deleted_source_message', mirror: 'file-only', rule: RULE_FILE_ONLY_DETAIL, why: '墓碑：删除者消息 id' },
  { name: 'expired_reason', mirror: 'file-only', rule: RULE_FILE_ONLY_DETAIL, why: '详情页展示失效原因' },
  { name: 'last_verified', mirror: 'file-only', rule: RULE_FILE_ONLY_DETAIL, why: '记忆演化闭环的核查时间，暂未进任何读侧路径' },

  // ── file-only：记忆演化闭环（R2：目前只有详情页与离线评估用）────
  { name: 'type', mirror: 'file-only', rule: RULE_FILE_ONLY_DETAIL, why: 'fact/insight 分型，当前只有详情页与离线评估消费' },
  { name: 'confidence', mirror: 'file-only', rule: RULE_FILE_ONLY_DETAIL, why: '置信度硬分；若将来要在列表/图谱展示，须按 R1 改判并进索引' },
  { name: 'confidence_type', mirror: 'file-only', rule: RULE_FILE_ONLY_DETAIL, why: '冗余字段，以 type 为准' },
  { name: 'conf_source', mirror: 'file-only', rule: RULE_FILE_ONLY_DETAIL, why: '置信度分项①（来源强度）' },
  { name: 'conf_verify', mirror: 'file-only', rule: RULE_FILE_ONLY_DETAIL, why: '置信度分项②（验证强度）' },
  { name: 'conf_recurrence', mirror: 'file-only', rule: RULE_FILE_ONLY_DETAIL, why: '置信度分项③（重现一致性）' },
  { name: 'conf_freshness', mirror: 'file-only', rule: RULE_FILE_ONLY_DETAIL, why: '置信度分项④（时效与冲突）' },
  { name: 'conflict_state', mirror: 'file-only', rule: RULE_FILE_ONLY_DETAIL, why: '冲突状态，冲突机制化属 V1.4' },
  { name: 'conflict_with', mirror: 'file-only', rule: RULE_FILE_ONLY_DETAIL, why: '冲突对象，同上' },
  { name: 'conflict_type', mirror: 'file-only', rule: RULE_FILE_ONLY_DETAIL, why: '冲突类型，同上' },
  { name: 'conflict_resolution', mirror: 'file-only', rule: RULE_FILE_ONLY_DETAIL, why: '冲突裁决方式，同上' },

  // ── file-only：校验/审计（R3）──────────────────────────────────
  { name: 'checksum', mirror: 'file-only', rule: RULE_FILE_ONLY_AUDIT, why: '启动抽样校验与修复脚本消费；**写侧每次内容变更都要重算**（V1.3-A · G3）' },
]

/** 镜像字段名（派生，⛔ 不许再手写第二份 —— 历史上那三份已经静默对不上过一次） */
export const MIRROR_FIELD_NAMES: readonly string[] = FIELD_REGISTRY.filter((f) => f.mirror === 'mirror').map((f) => f.name)

/** 索引**独有**（frontmatter 里没有）的结构字段——`file` 是索引自己算出来的相对路径 */
export const INDEX_ONLY_FIELDS: readonly string[] = ['file', 'has_session', 'session_kind']

const BY_NAME = new Map(FIELD_REGISTRY.map((f) => [f.name, f]))


// ════════════════════════════════════════════════════════════
// 三、单一漂移判据（全消费方共用这一处）
// ════════════════════════════════════════════════════════════

/**
 * 漂移分类。**必须分得开"旧条目"与"真漂移"** —— 混在一起就没人看得懂读数，
 * 而"看不懂"的下一步就是"不看了"（本项目反复栽在这条链上）。
 */
export type DriftKind =
  /** 文件有、索引没有 ⇒ 索引陈旧（真漂移） */
  | 'index-stale'
  /** 索引有、文件没有 ⇒ 索引多出东西（真漂移，通常是回滚或手改留下） */
  | 'index-extra'
  /** 两侧都有但值不同 ⇒ 索引陈旧（真漂移） */
  | 'value-mismatch'
  /** 两侧都没有、且**能真回填** ⇒ 数据缺口（回填的活，不是漂移） */
  | 'both-missing'
  /** 两侧都没有、且**不可重建** ⇒ 历史遗留（⛔ 不许编个值糊上，只如实记录） */
  | 'legacy-missing'

export interface FieldDrift {
  id: string
  field: string
  kind: DriftKind
  fromIndex: unknown
  fromFile: unknown
}

/** 真漂移：需要人处理的三类 */
export const REAL_DRIFT_KINDS: readonly DriftKind[] = ['index-stale', 'index-extra', 'value-mismatch']

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b)
  return String(a) === String(b)
}

function isAbsent(v: unknown): boolean {
  return v === undefined || v === null || v === ''
}

/**
 * 单条条目的字段漂移。**这是全仓唯一一处漂移判定实现。**
 *
 * 判据（三个分支，与 `container.validate()` 的调用点共同构成契约）：
 *   · 只比 `mirror: 'mirror'` 的字段（file-only 字段本来就不进索引）
 *   · **文件有、索引没有** ⇒ `index-stale`（派生视图陈旧，真漂移）
 *   · **文件没有、索引有** ⇒ 只有等于**登记默认值**才合法；否则 `index-extra`（索引凭空多出东西）
 *   · **两侧都缺** ⇒ `both-missing`：这**不是漂移**，是数据缺口（未回填的旧条目），
 *     单独计数、单独汇报 —— ⛔ 不许拿登记默认值静默顶替（那正是 G2 回填要治的病）
 *
 * V1.2 那句「单侧缺值 = 隐含默认，不是漂」为什么是错的：它把"旧条目"（**两侧都缺**）
 * 与"索引陈旧"（**文件有、索引没有**）当成了同一件事，于是一整类真漂移被静默放过。
 */
export function diffEntryFields(
  id: string,
  fromIndex: Record<string, unknown>,
  fromFile: Record<string, unknown>,
): FieldDrift[] {
  const out: FieldDrift[] = []
  for (const spec of FIELD_REGISTRY) {
    if (spec.mirror !== 'mirror') continue
    const iv = fromIndex[spec.name]
    const fv = fromFile[spec.name]
    const iAbsent = isAbsent(iv)
    const fAbsent = isAbsent(fv)
    if (iAbsent && fAbsent) {
      if (spec.absence === 'gap') out.push({ id, field: spec.name, kind: 'both-missing', fromIndex: iv, fromFile: fv })
      else if (spec.absence === 'legacy') out.push({ id, field: spec.name, kind: 'legacy-missing', fromIndex: iv, fromFile: fv })
      continue
    }
    if (fAbsent) {
      if (spec.defaultWhenAbsent !== undefined && sameValue(iv, spec.defaultWhenAbsent)) continue
      out.push({ id, field: spec.name, kind: 'index-extra', fromIndex: iv, fromFile: fv })
      continue
    }
    if (iAbsent) {
      out.push({ id, field: spec.name, kind: 'index-stale', fromIndex: iv, fromFile: fv })
      continue
    }
    if (!sameValue(iv, fv)) {
      out.push({ id, field: spec.name, kind: 'value-mismatch', fromIndex: iv, fromFile: fv })
    }
  }
  return out
}

/**
 * 消费方遇到"索引侧缺字段"时的取值：**先真源（文件）、再登记缺省、最后显式 undefined**。
 *
 * 为什么不直接一律用登记缺省：`scope` 的缺省是 `global`，而 `global` 是**最宽松的一档**——
 * 拿它当默认值等于**放大了可见性**（安全边界往宽处走）。所以顺序必须是
 * **文件优先**（文件是唯一真源），登记缺省只在真源也没有时才用，而且每一处缺失都要被报出来。
 */

/** 一条条目是否需要回退读文件（给 `/list` 这类元数据化路径用；判据同样只此一处） */

/**
 * **索引侧缺了就必须回退读真源**的字段（声明在这里，⛔ 不许在 `/list` 里再硬编码字段名）。
 *
 * 为什么只有这三个：
 *   · `scope` / `scope_id` —— **安全边界**。`scope` 的登记默认是 `global`，而那是最**宽松**的一档，
 *     拿缺省当默认值等于**放宽可见性**。宁可读一次文件，也不许把作用域判宽。
 *   · `status` —— `/list` 的状态标签直接渲染它，错一格用户看到的就是错的。
 *
 * ⛔ **刻意不含** `valid_from` / `valid_to` / `expires` / `superseded_by` / `decay_type` 这些：
 *   它们对**大多数条目本来就常年缺席**（多数记忆不过期、不是候选、没有替代链）。
 *   把"缺席即回退"写进去 ⇒ `/list` 对几乎每条都读盘 ⇒ **把 V1.1 治过的 O(n) 读盘又请回来**
 *   （@2000 实测 1645ms，这正是这套元数据化当初要解决的病）。
 *   它们的索引陈旧由**加载期**的 `diffEntryFields()` 抓（那时文件本来就在读，零额外 I/O），
 *   从 `/selftest → projection_drift` 出去 —— **看见它，但不为它逐条读盘**。
 */
const FALLBACK_ON_INDEX_MISSING: readonly string[] = ['scope', 'scope_id', 'status']

/**
 * 索引侧缺了哪些"必须回退"的字段（纯索引计算，**不读文件** —— 这正是它能用在 `/list` 快路径上的原因）。
 *
 * `scope_id` 单独处理：它**只在 `scope` 是 workspace/project 时才有意义**，
 * `global` 条目常年没有它 —— 无脑把它算进回退，等于又给全体条目加一次读盘，
 * 而且那是**语义错误**（`global` 本来就不该有 scope_id）。判定与 `policy.isInScope` 对齐。
 */
export function listFallbackFields(fromIndex: Record<string, unknown>): string[] {
  const out: string[] = []
  for (const name of FALLBACK_ON_INDEX_MISSING) {
    if (name === 'scope_id') {
      const scope = fromIndex.scope
      const scoped = scope === 'workspace' || scope === 'project'
      if (scoped && isAbsent(fromIndex.scope_id)) out.push(name)
      continue
    }
    if (isAbsent(fromIndex[name])) out.push(name)
  }
  return out
}

/** 读数汇总（报告用；**照实报绝对数，⛔ 不许用比率掩盖数量**） */

