/**
 * 「一天」的**单一权威**（E 段 · 1.4 · 2026-10-09）
 *
 * ## 为什么要有这个模块
 * 修前同一个仓里有**三套"一天"**，而且互不一致：
 *   · `policy.parseTime(..., endOfDate)`：日期粒度补到 **UTC 日末** ——
 *     `valid_to: 2026-10-09` 在上海是 **10-10 07:59:59.999** 才失效（**多活 8 小时**）；
 *   · `ingest.coldStartActive`：裸 `Date.parse` ⇒ 日期粒度落在 **UTC 日初**（与上面差一整天两端）；
 *   · `idem.today()`：`toISOString().slice(0,10)` ⇒ **UTC 日标签**，与用户的"今天"错开 8 小时。
 * 后果不是"差几小时好看不好看"，而是：日期粒度的到期时刻**取决于代码路径**，
 * 而"每日一次"的任务可能**跳过某个本地日、又把另一天跑两遍**。
 *
 * ## 口径（作者 2026-10-09 拍板）
 * **以配置时区为准**（本机 `timeZone: 'Asia/Shanghai'`）：
 * `2026-10-09` = **当地那一天的结束**（23:59:59.999），也就是"9 号过完"。
 * 默认值写死为 `UTC` 只为让纯函数在无配置时仍有确定行为；
 * **插件启动时必然用配置覆盖它**（见 `setDayTimeZone`），且只有那一个写入点。
 *
 * ## 边界（如实写）
 * · 带完整时区的时间戳（`...Z` / `+08:00`）**是绝对时刻**，与本模块无关，原样解析；
 * · 不带时区的 date-time（`2026-10-09T10:00:00`）按 **JS 规范 = 运行环境的本地时区**解析 ——
 *   本机运行环境就是 Asia/Shanghai，与配置一致；若将来进程时区与配置不同，这里会分叉，
 *   ⛔ 那时要在解析前显式补时区（已在 `parseInstant` 的注释里标出）。
 */

/** 唯一写入点：插件启动时设一次。默认 UTC 只为无配置时有确定行为。 */
let dayTimeZone = 'UTC'

export function setDayTimeZone(tz: string): void {
  if (typeof tz === 'string' && tz.trim()) dayTimeZone = tz.trim()
}

export function getDayTimeZone(): string {
  return dayTimeZone
}

/** 该时区在某一时刻的墙上时间（用 Intl，不依赖进程 TZ）。 */
function wallClockAt(instantMs: number, timeZone: string): { y: number; m: number; d: number; h: number; mi: number; s: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const p: Record<string, number> = {}
  for (const part of fmt.formatToParts(new Date(instantMs))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value)
  }
  return { y: p.year, m: p.month, d: p.day, h: p.hour % 24, mi: p.minute, s: p.second }
}

/**
 * 「某地在某一天 00:00:00.000」对应的绝对时刻。⛔ 不导出（工作由 `parseInstant` 对外提供）。
 * 做法：先用 UTC 午夜猜一次，量出墙上时间与 UTC 的偏差再校正；
 * 迭代两次以覆盖夏令时切换当天（校正量在边界处会变）。
 */
function startOfDayMs(dateStr: string, timeZone: string = dayTimeZone): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim())
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const target = Date.UTC(y, mo - 1, d, 0, 0, 0, 0)
  // 迭代式：`T = 目标墙上时间 − 该时刻的时区偏移`。
  // ⛔ 第一版我写成 `guess −= 偏移`（把偏移从**当前猜测**里减掉），
  //    结果每次迭代都多减一个偏移 —— 上海会偏出整整 8 小时（实测：
  //    `2026-10-09` 的"当天结束"给成 10-09 07:59 而不是 23:59）。
  //    正解是**从目标出发**减偏移，而不是从猜测出发。
  let guess = target
  for (let i = 0; i < 3; i++) {
    const w = wallClockAt(guess, timeZone)
    const offset = Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - guess
    const next = target - offset
    if (next === guess) break
    guess = next
  }
  return guess
}

/** 日期粒度的「当天结束」：当地 23:59:59.999。⛔ 不导出：外部一律走 `parseInstant`（同一个实现）。 */
function endOfDayMs(dateStr: string, timeZone: string = dayTimeZone): number | null {
  const start = startOfDayMs(dateStr, timeZone)
  return start === null ? null : start + 24 * 60 * 60 * 1000 - 1
}

/**
 * 解析一个时间值：
 *   · `YYYY-MM-DD` ⇒ 按**当日结束**（口径见文件头）；
 *   · 其它 ⇒ 绝对时刻（带时区偏移的按偏移，不带偏移的按运行环境本地时区，见边界说明）。
 */
export function parseInstant(value: string | undefined, endOfDate = false, timeZone: string = dayTimeZone): number | null {
  if (!value) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    return endOfDate ? endOfDayMs(value, timeZone) : startOfDayMs(value, timeZone)
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** 指定时区下的日期标签（`YYYY-MM-DD`）——"每日一次"这类键必须用它。 */
export function dayKey(now: Date = new Date(), timeZone: string = dayTimeZone): string {
  const w = wallClockAt(now.getTime(), timeZone)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${w.y}-${pad(w.m)}-${pad(w.d)}`
}

/**
 * **写进 `updated` / `created_at` 的那个"今天"**（`YYYY-MM-DD`，当地时区）。
 *
 * ## 为什么必须只有一个出口（2026-10-16 实测 · Lite 0.15 红项）
 * `container.updateEntry` 原先自己切 **UTC**：`new Date().toISOString().slice(0, 10)`。
 * 于是同一个仓里有两份"今天"：
 *   · `idem.today()` ⇒ `dayKey`（当地，**对的**）；
 *   · 条目文件的 `updated` ⇒ UTC 切片（**错的**）—— 当地 **00:00–08:00** 写一次，
 *     落的是**昨天**的日期（Asia/Shanghai 实测：`2026-10-17 00:30` 写成 `2026-10-16`）。
 * ⇒ 本函数是**唯一出口**：容器与 `idem.today()` 都走它，
 *   「同一瞬间两条写路径给同一个答案」由判据钉住（`test/updated-daykey.test.mjs`）。
 *
 * ## 依赖方向（⛔ 别倒过来）
 * 权威在**本模块**：`idem` 已经 import 它，反过来 import 会成环。
 * 所以它从"内部用"变成"出口用"——这是收口这条红项必须付的那一点。
 */
export function localDay(now: Date = new Date()): string {
  return dayKey(now)
}
