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
export function usageFromSessionEvent(event) {
    if (typeof event !== 'object' || event === null)
        return null;
    const wrapper = event;
    if (wrapper.type !== 'assistant/message')
        return null;
    if (typeof wrapper.data !== 'object' || wrapper.data === null)
        return null;
    const usage = wrapper.data.usage;
    if (typeof usage !== 'object' || usage === null)
        return null;
    const u = usage;
    if (typeof u.inputTokens !== 'number' || typeof u.outputTokens !== 'number')
        return null;
    return {
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        ...(typeof u.totalTokens === 'number' ? { totalTokens: u.totalTokens } : {}),
    };
}
/**
 * 上下文占用账本 + 预算计算。
 *
 * 纯状态机，不做 IO、不读配置 —— 便于单测（见 `test/budget.test.mjs`）。
 */
export class TokenBudget {
    contextTokens = 0;
    samples = 0;
    updatedAt = null;
    /**
     * 记录一次模型调用的用量。
     *
     * 非有限值、非正数一律丢弃（**不猜、不修正**）：宁可不采样，
     * 也不让坏数据把预算算成一个看似合理的错值。
     */
    record(usage) {
        const total = usage.totalTokens ?? usage.inputTokens + usage.outputTokens;
        if (!Number.isFinite(total) || total <= 0)
            return;
        this.contextTokens = total;
        this.samples += 1;
        this.updatedAt = Date.now();
    }
    /**
     * 本轮可用字符数：
     *   `min(hotMaxChars, max(0, 窗口 − 上一轮占用) × charsPerToken)`
     *
     * 冷启动（尚无任何样本）→ 直接返回 `hotMaxChars`（等价于旧行为，不因缺数据而缩水）。
     */
    budgetChars(options) {
        if (this.samples === 0)
            return options.hotMaxChars;
        const floor = Math.max(0, Math.min(options.hotMinChars ?? 0, options.hotMaxChars));
        const remaining = Math.max(0, options.contextWindow - this.contextTokens);
        const byWindow = Math.floor(remaining * options.charsPerToken);
        return Math.max(floor, Math.min(options.hotMaxChars, byWindow));
    }
    snapshot() {
        return { contextTokens: this.contextTokens, samples: this.samples, updatedAt: this.updatedAt };
    }
    /** 测试与重生用：清空账本回到冷启动态 */
    reset() {
        this.contextTokens = 0;
        this.samples = 0;
        this.updatedAt = null;
    }
}
