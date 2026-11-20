/**
 * 本地 BM25 检索：中文 2-gram、英文/数字分词，不依赖联网或向量服务。
 * 标题、标签、摘要和正文使用不同权重，并返回可解释的召回原因。
 */
import { MemoryContainer } from './container.js';
import type { MemoryScopeContext, MemorySearchHit } from './types.js';
/**
 * DSH 工具管线使用 lossless JSON 校验工具输出，不允许 undefined 字段。
 * 旧条目没有 scope_id/source 等新字段时，直接放进对象会让整个工具调用失败，
 * 因此构造返回对象时必须剔除缺失字段。
 *
 * 2026-10-06（S1 · P0-1b）：返回类型从 `Partial<T>` 改为 `T`。
 * 原因：`Partial<T>` 会把 `ok: boolean` 这类**必填**字段也变成可选，
 * 于是"包一层收口"反而过不了工具返回的类型检查——类型系统会把收口动作判成错误，
 * 结果就是**没人愿意用它**，四个写工具因此一直没收口。返回 `T` 表示
 * "键还在，只是值为 undefined 的那些键在运行时不存在"——这与声明里的
 * `version?: number` 这类可选字段是自洽的。
 */
export declare function withoutUndefined<T extends Record<string, unknown>>(obj: T): T;
/**
 * 检索 longterm，可选 archive。过期、被替代、尚未生效或作用域不匹配的条目不进入候选集。
 */
export declare function searchLongterm(container: MemoryContainer, query: string, opts?: {
    topK?: number;
    layerFilter?: Array<'longterm' | 'archive'>;
    scopeContext?: MemoryScopeContext;
    now?: Date;
    /**
     * 同义词扩展（P2）：默认开启。关掉后应回落到纯 BM25 水平——
     * 这个开关同时是「扩展到底有没有用」的实测手段（评测脚本按开/关各跑一遍）。
     */
    enableLexicon?: boolean;
    /** 每次查询最多附加几条扩展查询（上限，防止把一次检索放大成风暴） */
    maxExtraQueries?: number;
}): MemorySearchHit[];
