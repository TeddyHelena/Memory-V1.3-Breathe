/**
 * session-buffer.ts —— 会话原话缓冲区（V1.0 / P2）
 *
 * 为什么需要它：写入路径的「用户明说」判据原本只能靠模型自觉（软层）。
 * 但插件可以通过 `ctx.on('session/event')` 拿到 `user/message` 事件——data 就是 UserMessage，
 * 其中 `source.kind === 'user'` 表示**真人输入**（plugin 是插件注入、model 是模型产出）。
 * 有了原话，就能对写入内容做「是否真的有用户原话依据」的机械比对，把软层拧硬。
 *
 * 容量：每会话最多保留最近 N 条真人消息、每条截断 M 字符。只存内存，不落盘——
 * 原话属于会话上下文，不该因为「为了校验写入」而被持久化（那等于把记忆库变成监听库）。
 */
/** 每条消息保留的最大字符数（超长截断，只用于比对） */
const MAX_TEXT_CHARS = 2000;
/** 每个会话保留的最近消息条数 */
const MAX_MESSAGES_PER_SESSION = 30;
export class SessionBuffer {
    bySession = new Map();
    lastSeqBySession = new Map();
    /**
     * 记录一条真人用户消息。非真人来源（plugin/model/tool）由调用方过滤后不应进来。
     */
    record(sessionId, seq, text, at = Date.now()) {
        const trimmed = text.trim();
        if (!trimmed)
            return;
        const list = this.bySession.get(sessionId) ?? [];
        list.push({ seq, text: trimmed.slice(0, MAX_TEXT_CHARS), at });
        if (list.length > MAX_MESSAGES_PER_SESSION) {
            list.splice(0, list.length - MAX_MESSAGES_PER_SESSION);
        }
        this.bySession.set(sessionId, list);
    }
    /** 【P0-4】只记 seq（不存文本）——`source_message` 的唯一来源 */
    recordSeq(sessionId, seq) {
        if (!sessionId || !Number.isFinite(seq))
            return;
        const prev = this.lastSeqBySession.get(sessionId);
        if (prev === undefined || seq >= prev)
            this.lastSeqBySession.set(sessionId, seq);
    }
    /** 【P0-4】最后一条真人消息的 seq（没有则 null） */
    latestSeq(sessionId) {
        return this.lastSeqBySession.get(sessionId) ?? null;
    }
    /** 最近一条真人消息 */
    latest(sessionId) {
        return this.bySession.get(sessionId)?.at(-1) ?? null;
    }
    /** 会话内的全部缓冲消息（新→旧） */
    recent(sessionId) {
        return [...(this.bySession.get(sessionId) ?? [])].reverse();
    }
    /** 会话结束/清理时丢弃（避免长驻内存） */
    drop(sessionId) {
        this.bySession.delete(sessionId);
    }
    /** 诊断用：当前缓冲的会话数与消息数 */
    stats() {
        let messages = 0;
        for (const list of this.bySession.values())
            messages += list.length;
        return { sessions: this.bySession.size, messages };
    }
}
/** 归一化：去空白/标点，只留汉字与字母数字，便于做包含判断 */
export function normalizeForMatch(text) {
    return text
        .replace(/[\s\u3000]+/g, '')
        .replace(/[，。！？、；：""''（）【】《》…·~!?,.;:"'()<>[\]{}/\-—–_*#>`]/g, '')
        .toLowerCase();
}
/**
 * 在 source 中找一段长度 ≥ minQuote 且出现在 target 里的窗口。
 *
 * **为什么写这么绕（2026-09-15 修）**：原实现是
 * `for (size = max; size >= minQuote; size--) { for (i...) if (target.includes(source.slice(i, i+size))) return }`
 * ——**最长窗口优先、逐长度递减**。命中时很快，但**不命中时代价是 O(n³)**：
 * 每个长度都要把 source 的所有窗口切出来、再在 target 里搜一遍。
 * 实测最坏路径：30 条 × 2000 字互不重叠 → **28.3 秒**（`test/probes/p5-quote.mjs`），
 * 对一个同步工具调用来说等于挂死。
 *
 * 现在：对每个起点做**二分**求「最长可匹配窗口」。
 *   单调性成立：若长度 L 的窗口是 target 的子串，则任何更短的前缀也是。
 *   所以每个起点只需 O(log n) 次 `includes`，语义与原来**完全一致**
 *   （仍然是「存在长度 ≥ minQuote 的公共片段」），只是找得快。
 */
function hasCommonWindow(source, target, minQuote) {
    const maxSize = Math.min(source.length, target.length);
    if (maxSize < minQuote)
        return false;
    // 快速路径：整条原话出现在内容里（最常见情形，一次 includes 搞定）
    if (target.includes(source))
        return true;
    for (let i = 0; i + minQuote <= source.length; i++) {
        // 下界都不在 → 这个起点直接放弃，省掉二分
        if (!target.includes(source.slice(i, i + minQuote)))
            continue;
        let lo = minQuote;
        let hi = Math.min(source.length - i, maxSize);
        while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            if (target.includes(source.slice(i, i + mid)))
                lo = mid;
            else
                hi = mid - 1;
        }
        if (lo >= minQuote)
            return true;
    }
    return false;
}
/**
 * 校验「记忆内容是否有用户原话依据」。
 *
 * 判据（机械、可复现，不含模型判断）：
 *   在给定窗口内的用户原话里，找是否存在一个长度 ≥ minQuote 的连续片段出现在 content 中。
 *   即：**写入的内容必须能指到用户真正说过的某一段话**。
 *
 * @returns 命中则返回被引用的原话片段，否则 null
 */
export function findQuote(content, messages, minQuote = 6) {
    const target = normalizeForMatch(content);
    if (!target)
        return null;
    for (const message of messages) {
        const source = normalizeForMatch(message.text);
        if (!source)
            continue;
        // 整句都在：直接命中
        if (source.length >= minQuote && target.includes(source)) {
            return { quote: message.text, seq: message.seq };
        }
        if (hasCommonWindow(source, target, minQuote)) {
            return { quote: message.text, seq: message.seq };
        }
    }
    return null;
}
