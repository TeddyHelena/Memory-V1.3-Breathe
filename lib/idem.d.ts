/**
 * idem.ts —— 幂等锚点、来源强制、版本号、墓碑字段生成（纯函数，无 I/O）
 *
 * 职责边界（TechDesign §2 硬约束）：
 *   本模块只把入参加工成字段值，不做任何读写；所有副作用由 writer.ts 执行。
 *
 * 口径（TechDesign §6.2，P1 已裁定）：
 *   idem_key 仅作为「去重锚点字段」落库，为后续流式记忆去重预留；
 *   **P1 不做「命中即拒绝」的查重拦截**，允许重复落库。
 */
import type { Operation, WriteRecord } from './types.js';
/** 统一错误码（禁止散落魔法字符串） */
export declare const ERR: {
    readonly WRITE_DISABLED: "WRITE_DISABLED";
    readonly ROUTE_TO_PROPOSE: "ROUTE_TO_PROPOSE";
    readonly MISSING_SOURCE: "MISSING_SOURCE";
    readonly ENTRY_NOT_FOUND: "ENTRY_NOT_FOUND";
    readonly PURGE_DISABLED: "PURGE_DISABLED";
    readonly PROTECTED_ENTRY: "PROTECTED_ENTRY";
    readonly INVALID_INPUT: "INVALID_INPUT";
    /** P2：容器被另一个实例占用（单写入队列） */
    readonly LOCK_BUSY: "LOCK_BUSY";
    /** P2：记忆内容找不到用户原话依据（原文比对未通过）→ 改走 propose */
    readonly NO_USER_QUOTE: "NO_USER_QUOTE";
    /** 【并发修复】纠正一个已被替代的旧版本 ⇒ 拒写（同一底座只允许一个当前头） */
    readonly VERSION_CONFLICT: "VERSION_CONFLICT";
};
export type ErrorCode = (typeof ERR)[keyof typeof ERR];
/** 带错误码的写入错误：工具层据此返回结构化失败，而不是抛栈给模型 */
export declare class WriteError extends Error {
    readonly code: ErrorCode;
    constructor(code: ErrorCode, message: string);
}
/** 幂等锚点：sha256(source_session \n source_message \n content).slice(0, 32) */
export declare function computeIdemKey(sourceSession: string, sourceMessage: string, content: string): string;
/**
 * 来源强制（TechDesign §6.3）：source_session / source_message 缺任一即拒绝落库。
 * created_at / operator / operation 由插件内部填充，不在此校验。
 */
export declare function assertSource(record: Pick<WriteRecord, 'source_session' | 'source_message'>): void;
/** 版本号：对无 version 字段的存量条目（v0.5.0 的 57 条）必须兜底，否则得 NaN */
export declare function nextVersion(current: number | undefined): number;
/** UTC ISO 时间戳（created_at / updated / deleted_at 统一口径） */
export declare function nowIso(now?: Date): string;
/** 日期（yyyy-mm-dd），index.json 的 updated 字段沿用它 */
/**
 * 「今天」的日期串 —— **当地日**（E 段 · 1.4，与 day-boundary 同源）。
 *
 * 修前是 `now.toISOString().slice(0,10)` = **UTC 日标签**：
 * 上海 10-09 23:30 会得到 `2026-10-09`，而上海 10-10 00:30 得到的**还是** ……
 * 不：UTC 切片下，上海 10-10 00:30 = UTC 10-09 16:30 ⇒ 标签仍是 `2026-10-09`，
 * 于是"本地 10-10 这一天"在标签上根本不存在 —— 用它当"每日一次"的键，
 * 那个本地日会被**静默跳过**，而另一天被跑两遍（可验证性审稿实测过）。
 */
export declare function today(now?: Date): string;
/** 条目 id：`l54` / `p03` 这类短 id，按层给前缀，避免与既有 id 冲突由 caller 传入序号 */
export declare function buildEntryId(layer: WriteRecord['layer'], seq: number): string;
/** 从既有 id 集合里推出下一个可用序号（同前缀最大序号 + 1） */
export declare function nextSeq(existingIds: string[], layer: WriteRecord['layer']): number;
/** 墓碑字段：forget 的默认语义（不物理删除，保留可审计记录） */
export declare function tombstoneFields(operator: string, reason: string, now?: Date): {
    status: "expired";
    deleted_at: string;
    deleted_by: string;
    delete_reason: string;
    updated: string;
};
/** discard 字段：候选区丢弃（写墓碑 + 固定原因） */
export declare function discardFields(operator: string, now?: Date): {
    status: "expired";
    deleted_at: string;
    deleted_by: string;
    delete_reason: string;
    updated: string;
};
/** 转正留痕字段 */
export declare function confirmFields(operator: string, now?: Date): {
    confirmed_at: string;
    confirmed_by: string;
    updated: string;
};
/**
 * 层迁移的留痕字段（照 `confirmFields` 的样子，⛔ 不另造一套时间口径）。
 * 与 `confirmFields` 的区别：迁移**不改 status**（那是"转正"的语义，这里只是换个存放层），
 * 所以只写 `updated` 与 `operator` 两项留痕 —— 迁移是**审计链上的一件事**，必须留得下。
 */
export declare function relocateFields(operator: string): {
    operator: string;
};
/** 写入前置校验：memory_type 必须合法，title 非空，content 非空 */
export declare function assertWritable(record: Pick<WriteRecord, 'title' | 'content' | 'memory_type'>): void;
/**
 * 排他路由（软层，TechDesign §6.4）：
 * 本函数只做「结构性校验」，不做语义判断——P1 不实现语义分类器，无 LLM 参与。
 * 语义判断由工具契约 + 模型自觉承担；本函数存在的意义是把「operation 与目标层是否自洽」
 * 这类可机械判定的部分挡住，避免调用方绕过通道约束。
 *
 * 诚实标注：这不是物理硬约束，README 与注释不得把它写成「防污染硬闸门」。
 */
export declare function assertChannelConsistency(operation: Operation, targetLayer: WriteRecord['layer']): void;
