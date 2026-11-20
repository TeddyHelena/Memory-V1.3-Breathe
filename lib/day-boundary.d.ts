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
export declare function setDayTimeZone(tz: string): void;
export declare function getDayTimeZone(): string;
/**
 * 解析一个时间值：
 *   · `YYYY-MM-DD` ⇒ 按**当日结束**（口径见文件头）；
 *   · 其它 ⇒ 绝对时刻（带时区偏移的按偏移，不带偏移的按运行环境本地时区，见边界说明）。
 */
export declare function parseInstant(value: string | undefined, endOfDate?: boolean, timeZone?: string): number | null;
/** 指定时区下的日期标签（`YYYY-MM-DD`）——"每日一次"这类键必须用它。 */
export declare function dayKey(now?: Date, timeZone?: string): string;
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
export declare function localDay(now?: Date): string;
