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
import { createHash } from 'node:crypto';
import { localDay } from './day-boundary.js';
/** 统一错误码（禁止散落魔法字符串） */
export const ERR = {
    WRITE_DISABLED: 'WRITE_DISABLED',
    ROUTE_TO_PROPOSE: 'ROUTE_TO_PROPOSE',
    MISSING_SOURCE: 'MISSING_SOURCE',
    ENTRY_NOT_FOUND: 'ENTRY_NOT_FOUND',
    PURGE_DISABLED: 'PURGE_DISABLED',
    PROTECTED_ENTRY: 'PROTECTED_ENTRY',
    INVALID_INPUT: 'INVALID_INPUT',
    /** P2：容器被另一个实例占用（单写入队列） */
    LOCK_BUSY: 'LOCK_BUSY',
    /** P2：记忆内容找不到用户原话依据（原文比对未通过）→ 改走 propose */
    NO_USER_QUOTE: 'NO_USER_QUOTE',
    /** 【并发修复】纠正一个已被替代的旧版本 ⇒ 拒写（同一底座只允许一个当前头） */
    VERSION_CONFLICT: 'VERSION_CONFLICT',
};
/** 带错误码的写入错误：工具层据此返回结构化失败，而不是抛栈给模型 */
export class WriteError extends Error {
    code;
    constructor(code, message) {
        super(`[${code}] ${message}`);
        this.name = 'WriteError';
        this.code = code;
    }
}
/** 幂等锚点：sha256(source_session \n source_message \n content).slice(0, 32) */
export function computeIdemKey(sourceSession, sourceMessage, content) {
    return createHash('sha256')
        .update(`${sourceSession}\n${sourceMessage}\n${content}`, 'utf-8')
        .digest('hex')
        .slice(0, 32);
}
/**
 * 来源强制（TechDesign §6.3）：source_session / source_message 缺任一即拒绝落库。
 * created_at / operator / operation 由插件内部填充，不在此校验。
 */
export function assertSource(record) {
    if (!record.source_session?.trim()) {
        throw new WriteError(ERR.MISSING_SOURCE, '缺少 source_session，拒绝落库');
    }
    if (!record.source_message?.trim()) {
        throw new WriteError(ERR.MISSING_SOURCE, '缺少 source_message，拒绝落库');
    }
}
/** 版本号：对无 version 字段的存量条目（v0.5.0 的 57 条）必须兜底，否则得 NaN */
export function nextVersion(current) {
    return (Number.isFinite(current) ? current : 1) + 1;
}
/** UTC ISO 时间戳（created_at / updated / deleted_at 统一口径） */
export function nowIso(now = new Date()) {
    return now.toISOString();
}
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
export function today(now = new Date()) {
    return localDay(now);
}
// 【S1 · P1-8 删除导出】`safeTitle(title, maxLength = 40)` 已移除（2026-10-06）。
//
// 它唯一的作用是把**标题**变成文件名片段（`${id}_${safeTitle(title)}.md`）。
// 而标题兜底取自正文前 40 字 —— 于是敏感事实会随标题进到**文件名**里，
// 删了正文也还留在磁盘上（审计 P1-8 的样本就是这样）。
// 现在文件名只用 id（见 container.addEntryFile / writer.moveEntryFile），
// 它随之零调用点。按本仓纪律「零调用点 = 一等缺陷，不是预留」，直接删掉，
// 而不是加进白名单写一句"以后可能用得上"。
/** 条目 id：`l54` / `p03` 这类短 id，按层给前缀，避免与既有 id 冲突由 caller 传入序号 */
export function buildEntryId(layer, seq) {
    const prefix = layer === 'pending' ? 'p' : layer === 'hot' ? 'h' : layer === 'longterm' ? 'l' : 'a';
    return `${prefix}${String(seq).padStart(2, '0')}`;
}
/** 从既有 id 集合里推出下一个可用序号（同前缀最大序号 + 1） */
export function nextSeq(existingIds, layer) {
    const prefix = layer === 'pending' ? 'p' : layer === 'hot' ? 'h' : layer === 'longterm' ? 'l' : 'a';
    let max = 0;
    for (const id of existingIds) {
        const match = id.match(new RegExp(`^${prefix}(\\d+)$`));
        if (match)
            max = Math.max(max, Number(match[1]));
    }
    return max + 1;
}
/** 墓碑字段：forget 的默认语义（不物理删除，保留可审计记录） */
export function tombstoneFields(operator, reason, now = new Date()) {
    return {
        status: 'expired',
        deleted_at: nowIso(now),
        deleted_by: operator,
        delete_reason: reason,
        updated: today(now),
    };
}
/** discard 字段：候选区丢弃（写墓碑 + 固定原因） */
export function discardFields(operator, now = new Date()) {
    return tombstoneFields(operator, 'discarded', now);
}
/** 转正留痕字段 */
export function confirmFields(operator, now = new Date()) {
    return {
        confirmed_at: nowIso(now),
        confirmed_by: operator,
        updated: today(now),
    };
}
/**
 * 层迁移的留痕字段（照 `confirmFields` 的样子，⛔ 不另造一套时间口径）。
 * 与 `confirmFields` 的区别：迁移**不改 status**（那是"转正"的语义，这里只是换个存放层），
 * 所以只写 `updated` 与 `operator` 两项留痕 —— 迁移是**审计链上的一件事**，必须留得下。
 */
export function relocateFields(operator) {
    // 【语义修正 · 2026-11-22 · Teddy 拍】搬层**不动** `updated`。
    //
    // `updated` 的含义是「**内容**最后一次被修改」，不是「这个文件最后一次被写过」。
    // 修前这里写 `updated: today()` ⇒ 每搬一次层（含自动衰减归档）旧条目就显示成"今天写的"：
    // 实测 11-22 的自动归档把 p10/p27/p30/l75 四条 10 月的老条目刷成了当天，
    // 面板上看起来像今天新写入的记忆 —— 用户第一眼就会读错。
    // 搬层改变的是**放在哪一层**（可投递性），内容一个字没动 ⇒ 不该伪造"刚改过"。
    // 谁搬的、什么时候搬的，由 `operator` + 审计行（.decay-audit.jsonl）记录，不靠 `updated` 背。
    return {
        operator,
    };
}
/** 写入前置校验：memory_type 必须合法，title 非空，content 非空 */
export function assertWritable(record) {
    if (!record.title?.trim())
        throw new WriteError(ERR.INVALID_INPUT, 'title 不能为空');
    if (!record.content?.trim())
        throw new WriteError(ERR.INVALID_INPUT, 'content 不能为空');
    if (!['experience', 'world', 'opinion'].includes(record.memory_type)) {
        throw new WriteError(ERR.INVALID_INPUT, `memory_type 非法: ${String(record.memory_type)}`);
    }
}
/**
 * 排他路由（软层，TechDesign §6.4）：
 * 本函数只做「结构性校验」，不做语义判断——P1 不实现语义分类器，无 LLM 参与。
 * 语义判断由工具契约 + 模型自觉承担；本函数存在的意义是把「operation 与目标层是否自洽」
 * 这类可机械判定的部分挡住，避免调用方绕过通道约束。
 *
 * 诚实标注：这不是物理硬约束，README 与注释不得把它写成「防污染硬闸门」。
 */
export function assertChannelConsistency(operation, targetLayer) {
    if (operation === 'propose' && targetLayer !== 'pending') {
        throw new WriteError(ERR.INVALID_INPUT, 'propose 只能写入 pending 层');
    }
    if ((operation === 'remember' || operation === 'update' || operation === 'forget') && targetLayer === 'pending') {
        throw new WriteError(ERR.INVALID_INPUT, `${operation} 不得写入 pending 层`);
    }
}
