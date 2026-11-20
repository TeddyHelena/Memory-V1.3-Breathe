/**
 * 动态预算（方案A）——「上一轮实际用量」驱动本轮 hot 段字符预算
 *
 * ── 为什么必须是「上一轮驱动本轮」（物理原因，不是设计偏好）───────────────
 * 装配点注册的是 `systemPrompt.section({ text: (context: AssembleContext) => string })`，
 * 而 `AssembleContext` 只有 `scope?: ScopeKey` / `signal?: AbortSignal` —— **拿不到 session**。
 * `ctx.tokenMeter.measure(session)` 必须传 session，而 `ScopeKey` 是不透明 object
 * （`export type ScopeKey = object`），无法可靠反查会话。
 * 所以**注入时无法实时测量上下文压力**，唯一可行的闭环是：
 *   事件回调记录用量 → 存插件状态 → 下一轮装配读它算预算。
 *
 * ── 「用量」取值的取舍（与 PRD 措辞的差异，如实标注）────────────────────
 * PRD 写「上一轮实际用量」。若按「整轮所有模型调用累加」理解会算错：
 * 一个 turn 可能有多个 step，**每次调用都携带完整上下文**，累加等于把上下文
 * 重复计 N 次 —— 数字虚高、预算过度收缩。
 * 本实现取 **最近一次调用的 `total ?? (input + output)`**：它才是
 * 「此刻上下文占了多少 token」的近似，也正是要防止挤爆窗口的那个量。
 *
 * ── 数据源 ──────────────────────────────────────────────────────────────
 * 会话事件 `assistant/message`（`{ turn, step, message, stream, usage? }`）里的
 * `usage?: TokenUsage`（`inputTokens` / `outputTokens` / `totalTokens?`）。
 * 该事件**只在 adapter 报了用量时才带 usage** —— 缺失时本模块不猜、跳过采样。
 */
/** 一次模型调用的用量样本（对应会话事件 `assistant/message`.usage） */
export interface UsageSample {
    inputTokens: number;
    outputTokens: number;
    /** adapter 报的整次调用合计；缺失时由 input + output 兜底 */
    totalTokens?: number;
}
/**
 * 从一个会话事件里取出用量样本。
 *
 * ⚠️ **结构提醒（我写错过一次，故固化成函数 + 测试，不留在接线处靠记性）**：
 * DSH 的 `SessionEvent` 是 `{ type, seq, time, data, ignorable? }` 的**包装**，
 * 事件载荷在 `event.data` 里 —— `assistant/message` 的 `usage` 在 **`event.data.usage`**，
 * **不在顶层**。按顶层取会永远采样不到，而且**静默**：不报错、不告警，
 * 动态预算恒等于静态上限，看起来"功能正常"。
 *
 * 字段不合法（非对象 / 缺 input·output）一律返回 null —— 不猜、不补零。
 */
export declare function usageFromSessionEvent(event: unknown): UsageSample | null;
export interface BudgetOptions {
    /**
     * 预算地板（字符）。**没有它就会出现"记忆静默清空"**：窗口被占满时
     * `(窗口 − 占用) × charsPerToken` 会算成 0，hot 段直接注入空字符串 ——
     * 用户只会看到"记忆没了"，且没有任何提示。地板保证任何情况下都保留
     * 最核心的常驻条目（hot_order 本就是按常驻优先级排的）。
     */
    hotMinChars?: number;
    /**
     * 宿主上下文窗口（token）。**DSH 不暴露该值**（`TokenMeterConfig = Record<string, never>`），
     * 所以由插件配置，默认 1M（与宿主窗口一致）。
     */
    contextWindow: number;
    /** hot 段字符硬上限（静态配置）——预算的**实际约束**通常压在这头上 */
    hotMaxChars: number;
    /**
     * token → 字符换算比。中文为主的环境取 1.5：
     * DeepSeek 分词下 1 个汉字约 0.6~0.7 token（即 1 token ≈ 1.4~1.7 字符），取偏保守值。
     */
    charsPerToken: number;
}
export interface BudgetSnapshot {
    /** 最近一次采样到的上下文占用（token）；无样本时为 0 */
    contextTokens: number;
    /** 采样次数（0 = 冷启动） */
    samples: number;
    /** 最近一次采样时间（epoch ms） */
    updatedAt: number | null;
}
/**
 * 上下文占用账本 + 预算计算。
 *
 * 纯状态机，不做 IO、不读配置 —— 便于单测（见 `test/budget.test.mjs`）。
 */
export declare class TokenBudget {
    private contextTokens;
    private samples;
    private updatedAt;
    /**
     * 记录一次模型调用的用量。
     *
     * 非有限值、非正数一律丢弃（**不猜、不修正**）：宁可不采样，
     * 也不让坏数据把预算算成一个看似合理的错值。
     */
    record(usage: UsageSample): void;
    /**
     * 本轮可用字符数：
     *   `min(hotMaxChars, max(0, 窗口 − 上一轮占用) × charsPerToken)`
     *
     * 冷启动（尚无任何样本）→ 直接返回 `hotMaxChars`（等价于旧行为，不因缺数据而缩水）。
     */
    budgetChars(options: BudgetOptions): number;
    snapshot(): BudgetSnapshot;
    /** 测试与重生用：清空账本回到冷启动态 */
    reset(): void;
}
