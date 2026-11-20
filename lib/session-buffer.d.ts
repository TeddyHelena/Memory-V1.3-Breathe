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
/** 一条被缓冲的用户原话 */
export interface BufferedUserMessage {
    /** 事件序号（同会话内单调） */
    seq: number;
    /** 文本内容（已拼接文本块并截断） */
    text: string;
    /** 记录时间戳 */
    at: number;
}
export declare class SessionBuffer {
    private readonly bySession;
    private readonly lastSeqBySession;
    /**
     * 记录一条真人用户消息。非真人来源（plugin/model/tool）由调用方过滤后不应进来。
     */
    record(sessionId: string, seq: number, text: string, at?: number): void;
    /** 【P0-4】只记 seq（不存文本）——`source_message` 的唯一来源 */
    recordSeq(sessionId: string, seq: number): void;
    /** 【P0-4】最后一条真人消息的 seq（没有则 null） */
    latestSeq(sessionId: string): number | null;
    /** 最近一条真人消息 */
    latest(sessionId: string): BufferedUserMessage | null;
    /** 会话内的全部缓冲消息（新→旧） */
    recent(sessionId: string): BufferedUserMessage[];
    /** 会话结束/清理时丢弃（避免长驻内存） */
    drop(sessionId: string): void;
    /** 诊断用：当前缓冲的会话数与消息数 */
    stats(): {
        sessions: number;
        messages: number;
    };
}
/** 归一化：去空白/标点，只留汉字与字母数字，便于做包含判断 */
export declare function normalizeForMatch(text: string): string;
/**
 * 校验「记忆内容是否有用户原话依据」。
 *
 * 判据（机械、可复现，不含模型判断）：
 *   在给定窗口内的用户原话里，找是否存在一个长度 ≥ minQuote 的连续片段出现在 content 中。
 *   即：**写入的内容必须能指到用户真正说过的某一段话**。
 *
 * @returns 命中则返回被引用的原话片段，否则 null
 */
export declare function findQuote(content: string, messages: BufferedUserMessage[], minQuote?: number): {
    quote: string;
    seq: number;
} | null;
