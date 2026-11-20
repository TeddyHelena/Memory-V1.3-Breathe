import { elapsed, type Elapsed } from './clock.js'

/**
 * `freshOf()` —— 新鲜度（E3 窄口径 · **只实现在用的一支**）
 *
 * ## 为什么只有一支
 * A 段纸上证伪（375 次真实装配）实测：
 *   · **会话内轮次钟**：`fresh` 分数极差 **0.126（中位）/ 0.343（p90）** ⇒ 有杠杆；
 *   · **跨会话墙钟**：极差 **0.0009**（比 priority 的 0.086 小 96 倍）⇒ **空转**。
 * 所以这里**只把轮次钟当主判据**；墙钟那一支保留设计形状（`2^(−Δt/30天)`），
 * 但**明确标注"未标定、实测无区分度"** —— ⛔ 不要再往它身上投入标定预算。
 *
 * ## 刻意不实现的两支（⛔ 不留空壳）
 *   · **core**（λ≈0.001/天）：全库 1 条且在 `hot` 层 —— hot 靠名单投递、**不参与打分**；
 *   · **process**（幂律）：`w3_process = 0` ⇒ 曲线整体乘零（P4 待拍：给值还是删分支）。
 *
 * ## 三条纪律
 *   ① `t` 由 `elapsed()` 给出，**已夹到 ≥ 0**（时间回拨不许让 fresh > 1）；
 *   ② 参数带 `*` 表示**未标定**；标定后的值必须回填到 `FRESH_PARAMS` 并留痕；
 *   ③ 输出恒在 (0, 1] 内；输入非法 ⇒ **抛**，⛔ 不许静默 NaN（NaN 会让排序恒 false、静默错乱）。
 */

export interface FreshParams {
  /** 会话内轮次钟的半衰期（轮）。`*` 未标定 */
  halfLifeTurn: number
  /** 跨会话墙钟的半衰期（天）。`*` 未标定，**实测无区分度** */
  halfLifeDay: number
}

/** `*` = 未标定（初值由 A 段的实测分布推来，不是拍的：p50=2 轮 / p90=10 轮 ⇒ 5 轮半衰期能拉开梯度） */
export const FRESH_PARAMS: FreshParams = {
  halfLifeTurn: 5,
  halfLifeDay: 30,
}

/**
 * **按衰减类型给半衰期** —— 这是"快衰"三个字该有的行为差异。
 *
 * 体检（2026-10-10）发现：原来 `decay_type` **完全不参与半衰期** ⇒ core/recent/process
 * 三者衰减速度一模一样 ⇒ "快衰"只是个标签。作者 的判断（"大部分信息其实属于快衰"）
 * 要能落地，前提就是**这里得先分开**。
 *
 * 口径（作者 2026-10-10 拍「超过半衰期」+「B：陈旧⇒自动降层」的延伸）：
 *   · core    —— 人格锚点类，**不衰减**（`Infinity`）
 *   · process —— 快衰：**7 天**
 *   · recent  —— 常规：**30 天**（默认口径不变）
 * ⛔ 改这三个数 = 改产品行为，先跟 作者 说。
 */
export const HALF_LIFE_BY_DECAY: Record<string, number> = {
  core: Number.POSITIVE_INFINITY,
  process: 7,
  recent: 30,
}

/** 取某个 decay_type 的半衰期（天）；未标 / 未知 ⇒ 按 recent（30 天） */
export function halfLifeFor(decayType: string | undefined): number {
  const v = HALF_LIFE_BY_DECAY[String(decayType ?? '')]
  return typeof v === 'number' && v > 0 ? v : FRESH_PARAMS.halfLifeDay
}

export interface FreshInput {
  /** 由 `elapsed()` 得到（含单位与是否退化） */
  elapsed: Elapsed
}

/** 核心纯函数：`fresh = 2^(−t/H)`。 */
export function freshOf(input: FreshInput, params: FreshParams = FRESH_PARAMS): number {
  const e = input.elapsed
  if (!e || typeof e.value !== 'number' || !Number.isFinite(e.value) || e.value < 0) {
    throw new Error(`[fresh] elapsed 非法（必须是非负有限数）：${JSON.stringify(e)}`)
  }
  const H = e.unit === 'turn' ? params.halfLifeTurn : params.halfLifeDay
  if (!Number.isFinite(H) || H <= 0) {
    throw new Error(`[fresh] 半衰期非法：${H}（unit=${e.unit}）`)
  }
  const fresh = Math.pow(2, -e.value / H)
  // 防御：浮点极端值不该逃出 (0,1]
  if (!Number.isFinite(fresh) || fresh <= 0) return Number.MIN_VALUE
  return fresh > 1 ? 1 : fresh
}

/**
 * **接线同版必须一起换的权重向量**（E3 施工单 §二-3：权重重绑定不许单独留着）。
 *
 * ## 为什么必须同版换
 * `fresh ≡ pri` 是刻意的静态近似：那时 `priority` 借 `w3_fresh` 这条通道**被计了两次**
 * （`w3·fresh + w4·imp`，其中 `imp` 也回落 pri）⇒ 实测有效权重 **0.6**。
 * 一旦 `fresh` 换成真值，priority 只剩 `imp` 那条 ⇒ **掉到 0.2**。
 * 所以"只换条曲线"在算术上不存在 —— 换 fresh 就是一次**重标定**。
 *
 * ## 值怎么来的（不是拍的 —— 两把尺子都量过）
 *
 * **尺子一：标定集（22 题，有真值）** —— 给**下限**
 *   · 接线 + `w2_pri=0` ⇒ 命中 11 / 漏掉 3（比基线差一条）；
 *   · 接线 + `w2_pri≥0.1` ⇒ 命中 12 / 漏掉 2（与基线持平）；
 *   · 仪器**分辨不出 0.1 与 0.4 的差别**（22 题 / 14 个 expect 到头了）。
 *
 * **尺子二：真身 A/B（12 个 query，看"翻动率"与"谁被挤出去"）** —— 定**取值**
 *   | w2_pri | 注入集合变化 | 被挤出去的条目平均 priority |
 *   |---|---|---|
 *   | 0    | 11/12 | **90** |
 *   | 0.2  | 11/12 | **86** |
 *   | **0.4** | **2/12** | 75 |
 *   为什么：`fresh` 在真身的中位数是 **0.983**，而 priority 归一化后中位约 0.6–0.7 ⇒
 *   `fresh` 一旦顶替 `pri`，**w3 槽里的 priority 区分度就被整体抹掉**，
 *   于是高 priority 条目成批掉出。`w2_pri=0.4` 把 priority 的**总影响还原到基线的 ~0.6**
 *   （0.4 明账 + 0.2 的 `imp`），扰动从 11/12 降到 **2/12**。
 *   ⚠️ **我第一版取 0.2 是错的**：那是拿"`imp` 的量级"当依据，而该对齐的是
 *   "priority 在基线里的**总**影响"（0.6）。
 *
 * ⇒ 取 **0.4**：满足标定下限、把 priority 的影响还原、且与 `w1_rel`/`w3_fresh` 同为 0.4。
 *   **仍标 `*`**：它是"两把尺子指向的初值"，不是标定终值（真标定要"带真值的会话内回放"，未建）。
 */
export const E3_WEIGHTS = {
  w1_rel: 0.4,
  w2_pri: 0.4,
  w3_fresh: 0.4,
  w4_imp: 0.2,
  w3_process: 0,
} as const

/**
 * 打分配置里"是否用真 fresh"的开关（接线用）。
 * ⛔ 默认 false：不改变行为，直到 作者 亲口批准部署（E3 施工单 §二-3）。
 */
export const FRESH_WIRING_DEFAULT = false

/**
 * **一处算 fresh**（`/list` 与 `/graph` 共用 —— ⛔ 不许两份实现，否则哪天口径改了必分叉）。
 *
 * 契约（作者 拍）：陈旧 ⇔ `fresh < 0.5` ⇔ 超过半衰期；半衰期按 decay_type 分（`HALF_LIFE_BY_DECAY`）。
 * ⚠️ `core` 必须**在调 `freshOf` 之前短路**：它是"不衰减"，而 `freshOf` 对非有限 H 是**抛错**的——
 *    2026-10-10 实测：把 `Infinity` 喂进去 ⇒ 只要有 1 条 core，`/list` 整条挂掉（HTTP 400）。
 * ⚠️ 缺 / 非法 `last_accessed` ⇒ **不猜，就不动**（返回 `FRESH_WHEN_UNKNOWN`），理由见下。
 */
export function freshForEntry(lastAccessed: string | undefined, decayType: string | undefined, nowMs = Date.now()): number {
  if (decayType === 'core') return 1
  const t = Date.parse(String(lastAccessed ?? ''))
  // 缺 / 非法 ⇒ 不猜（旧口径详见 FRESH_WHEN_UNKNOWN 的注释）
  if (!Number.isFinite(t)) return FRESH_WHEN_UNKNOWN
  const days = Math.max(0, (nowMs - t) / 86_400_000)
  return freshOf(
    { elapsed: { value: days, unit: 'day', degraded: false } },
    { halfLifeTurn: FRESH_PARAMS.halfLifeTurn, halfLifeDay: halfLifeFor(decayType) },
  )
}

/**
 * **缺 / 非法 `last_accessed` 时的落点**（2026-10-11 定，⛔ 改这个数 = 改产品行为，先跟 作者 说）。
 *
 * 旧口径是"按很旧算（拿半衰期本身当经过了多久）"，注释还写着「缺失算陈旧（安全侧，宁可不留）」——
 * 实测对不上，而且是**随 decay_type 两种结果**：
 *   · `recent`（H=30）⇒ days=30 ⇒ `fresh = 2^(-1) = 0.5`，陈旧判据是 `fresh < 0.5`
 *     ⇒ **正好卡在边界外 ⇒ 永不降层**（注释说会降，实测不降）；
 *   · `process`（H=7）⇒ days=30 ⇒ `fresh = 0.051` ⇒ **会**降层。
 * 同一件事两种结果 ⇒ 那是 bug，不是口径。
 *
 * 现口径：**不猜就不动** —— 取 `0.5`（=陈旧判据的边界，不算陈旧），与
 * 「没有 fresh ⇒ 不判」同源。为什么选"不动"而不是"当陈旧"：
 * 降层会把条目移出默认检索面（archive 默认不参与检索），对一条"我们什么都不知道"的条目
 * 做这种**看不见的处置**，比留着它危险；而且它随时可以被显式判废。
 * ⛔ 要翻成"当陈旧"，改这一个常量即可（并同步改注释与本条测试）。
 */
export const FRESH_WHEN_UNKNOWN = 0.5

/**
 * ═══ 衰减**有效年龄**的频率权重（2026-10-14 · 作者 拍「甲乙一起做」）═══
 *
 * ## 为什么需要它
 * 真身诊断（2026-10-14，可降层池 71 条）：`fresh = 2^(−t/H)` 的分布是
 *   min 0.61 · p10 0.93 · **p50 0.98** · max 1.00 —— **74/111 挤在 0.9~1.0**，陈旧线 0.5 落在一个**空档**里。
 * 实测：把 H 从 30 天砍到 7 天，p50 只从 0.961 掉到 0.843 —— **调 H 救不了**。
 * 根因：可降层池里**最久没碰的也只有 5.1 天**（条目一直在被召回）⇒ 纯年龄判据**不可达**。
 *
 * ## 口径（频率**只降不升**）
 *   `有效年龄 = 2^(−t/H) × (1 − w + w × S(count))`，`S(c) = 1 − exp(−c/C)`
 *   · `count` 越大 ⇒ `S→1` ⇒ 乘子趋近 1 ⇒ **按年龄正常衰减**；
 *   · `count` 越小 ⇒ 乘子趋近 `1−w` ⇒ **衰减更快**。
 * ⛔ 方向不能反：写成 `H×(1+k·ln(1+c))`（提高 H ⇒ 更慢）会把分布**推向更不可达**
 *   （实测 p50 从 0.98 升到 0.9953），那是把病治反。
 *
 * ## 这两个数是**标定出来的，不是拍的**
 * 判据：①今天真跑一次要动 **1~5 条**（不是 0，也不能把池子搬掉一半）
 *       ②**一周内碰过的**一条都不许动（相对基准：池内 p82 分位）③库分位要有梯度（p10/p50 明显小于 1）。
 * 扫描 48 组参数（w ∈ {0.3,0.5,0.7,0.85} × C ∈ {50,150,300,800} × 地板 ∈ {1,2,3}）后选定：
 *   **w=0.85 · C=300 · 地板 2 天** ⇒ 今天动 5 条 · 被地板保护的 9 条（刚写但还没被想起）一条不动 ·
 *   p10/p50 = **0.217**（原 0.95 ⇒ 梯度出来了）· count=0 的两条排在最前（`l73`/`p31`，一次没被想起）。
 *
 * ⛔ 改这两个数 = 改产品行为（会改变"谁退场"）⇒ 先跟 作者 说，并按上面的三条判据重扫。
 */
/** 频率权重（0 = 不看 count，1 = 完全由 count 决定）—— ⛔ 不导出：只经 `effectiveAge` 生效（死导出门禁）*/
const FRESH_FREQ_WEIGHT = 0.85
/** 频率饱和常数（count 到这个量级时 S≈0.63）—— ⛔ 不导出：同上 */
const FRESH_FREQ_SATURATION = 300

/**
 * **地板比例**：距上次访问不足 `H × 这个比例` 的条目**一律不进退场判定**。
 *
 * ⛔ 为什么必须有它（2026-10-14 实测抓到）：频率权重是"只降不升"的，
 * 于是一条**刚写、count=0** 的条目会被算成"最该退场"——实测 dry-run 差点把
 * 今天刚落盘的 `l75`/`l76`（0.0 天、count 5）划进归档。
 * **新条目的低 count 是"还没来得及被想起"，不是"没价值"。**
 * 地板给它一个被想起的窗口；且它按比例走 ⇒ 换 decay_type 时自动跟着半衰期缩放。
 *
 * 取值依据：真身可降层池的年龄分位 p82 ≈ 2 天（H=30 ⇒ 比例 ≈ 0.067），
 * 而池内 p90=2.99 天 ⇒ 地板只挡住尾部约 18% 的条目，不伤可达性（今天仍动 5 条）。
 */
export const FRESH_FLOOR_RATIO = 0.067

/** 某类型的**地板年龄（天）**：`H × FRESH_FLOOR_RATIO`；`core`（H=∞）⇒ 无地板（它本来就不判） */
/**
 * ⭐【Breathe · 2026-10-16 · 作者 拍「非对称地板」】**已经被想起过**的条目地板更短。
 *
 * ## 为什么要非对称（真身实测的画像）
 * 地板挡下的 79 条里：**15 条是从没被想起过的**（其中 11 条是刚批量写入的），
 * 其余 **64 条只是"最近 1–2 天没碰"** —— 它们天天被召回，**根本不缺保护**。
 * 而同一个地板线（2.01 天）把两类一起挡住 ⇒ 每天只放行 3 条 ⇒ 窗口(a5–9 名)里根本没有选择余地，
 * **排序键形同虚设**。
 * ⇒ 按"有没有被想起过"分档：见过的按 `0.03×H`（recent ⇒ 0.90 天）、
 *    没被想起过的仍按 `0.067×H`（recent ⇒ 2.01 天）。
 * ⚠️ 实测：这样放行 45 条、且那 15 条"从没被想起"的一条不放（保护不打折）。
 *
 * ⛔ `count=0` 必须走**保护档**：`count` 是第一层排序键、0 最小 ⇒
 *    若让它们进排名，它们会排在名次最前、**当天就被退场**（正是地板当初要防的事）。
 */
const FRESH_FLOOR_SEEN_RATIO = 0.03

/** 某类型的**地板年龄（天）**；`core`（H=∞）⇒ ∞（它本来就不判） */
export function floorDaysFor(halfLifeDays: number, accessCount?: number): number {
  /**
   * ⛔ **非有限半衰期 ⇒ 地板 = ∞（永不判）**，2026-10-14 对抗验证 D 修。
   *
   * 修前这里返回 **0** —— 本意大概是"它永远不会陈旧，所以不需要地板"，
   * 但地板是 `ageDays < floorD` 这种**下界**用法：返回 0 等于**把护栏整个拆掉**。
   * 实测后果（真容器端到端可复现）：`decay_type:'core'`（半衰期 ∞、文档写明永不衰减）
   * 且 `access_count=0` 时，有效年龄 = `1 × 0.15 = 0.15 < 0.5` ⇒ **今天刚写的 core 首扫即被归档**，
   * 而地板本该公司拦（`0 < 0` 为假 ⇒ 放行）。
   * ⇒ 改成 ∞：`ageDays < ∞` 恒为真 ⇒ **永远被地板挡住**（与"永不衰减"的语义一致）。
   */
  if (!Number.isFinite(halfLifeDays)) return Infinity
  // ⭐ 非对称：被想起过的用短地板；**没被想起的（含 count 缺失）走保护档**
  const seen = Number(accessCount) > 0
  return halfLifeDays * (seen ? FRESH_FLOOR_SEEN_RATIO : FRESH_FLOOR_RATIO)
}

/**
 * 有效年龄：**纯年龄 × 频率权重**（只降不升）。`count` 缺失 ⇒ 按 0 处理（⛔ 不猜成高频）。
 * ⚠️ 与 `freshOf()` 的分工：`freshOf` 是**纯年龄**（那是对外可见的"新鲜度"），
 * 本函数是**判定侧**用的量（决定谁退场）。两者刻意分开——别互相调用错。
 */
export function effectiveAge(age: number, accessCount: number | undefined, w = FRESH_FREQ_WEIGHT, c = FRESH_FREQ_SATURATION): number {
  const n = Number(accessCount)
  const cnt = Number.isFinite(n) && n > 0 ? n : 0
  const s = 1 - Math.exp(-cnt / c)
  return age * (1 - w + w * s)
}
