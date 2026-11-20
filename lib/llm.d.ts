/**
 * 轻量 LLM 接入点 —— 供 v1.0 需求②（语义重排 / 记忆压缩）使用
 *
 * ── 依赖边界（重要，决定这里为什么"手写"而不是"引用"）─────────────────
 * 本插件 `package.json` **没有** `@deepseek-ai/dsh-llm` 依赖，本机 `npm` 也不可用，
 * 所以这里不 import 它的 `createUserMessage` / `BlockAssembler`，
 * 只用**结构化类型**描述需要的能力，消息按该包 `createMessage()` 的运行时形状手写。
 *
 * ── 形状依据（逐条对照 DSH checkout 源码核过，不是猜的）────────────────
 *   - `Message = { id; role: 'system'|'user'|'assistant'; content: ContentBlock[]; source: MessageSource }`
 *   - `createMessage()` 内部就是 `{ id: brandString(randomUUID()), ...input }` —— id 是可 brand 的字符串
 *   - `MessageSourceMap.plugin = { kind: 'plugin'; plugin: string } & ContextFormed`，
 *     而 `ContextFormed` 的首个变体是 `{ form?: never }` —— **允许省略 form**
 *   - 调用：`for await (const chunk of ctx.llm.stream(options))`，
 *     文本取 `chunk.type === 'text-delta'` 的 `text`
 *     （官方 `compaction-basic` 用 `BlockAssembler` 收；这里只要文本，直接拼接）
 *   - `GenerateOptions` 必填 `provider` / `model` / `messages`；
 *     `purpose: 'compaction'` 是官方给辅助模型调用的分类（本条即 aux call）
 */
export interface LlmProviderLike {
    id: string;
    name: string;
}
export interface LlmModelLike {
    id?: string;
    model?: string;
    name?: string;
}
export interface LlmStreamChunkLike {
    type: string;
    text?: string;
    /** 仅 `finish` chunk 有：停止原因（'stop' | 'tool-calls' | 'max-tokens' | ...） */
    reason?: unknown;
}
/** 本插件用到的 `ctx.llm` 最小能力面（结构化类型，不依赖 dsh-llm 的类型包） */
export interface LlmLike {
    listProviders(): LlmProviderLike[];
    listModels(provider: string): Promise<LlmModelLike[]>;
    stream(options: {
        provider: string;
        model: string;
        messages: unknown[];
        system?: string;
        maxTokens?: number;
        purpose?: string;
        signal?: AbortSignal;
    }): AsyncIterable<LlmStreamChunkLike>;
}
export interface CompressorConfig {
    /** 显式指定 provider 路由 id（如 `deepseek-official`）。空 = 自动探测 */
    provider?: string;
    /** 显式指定 model。空 = 取该 provider 的第一个可用模型 */
    model?: string;
    /** 压缩调用输出上限（token） */
    maxTokens?: number;
    /** 自动探测时匹配 provider 的关键字（默认 `deepseek`） */
    providerHint?: string;
}
export interface CompressInput {
    /** 待压缩原文 */
    text: string;
    /** 压缩指令（作为 system 传） */
    instruction: string;
    signal?: AbortSignal;
    /**
     * 覆盖配置里的 `maxTokens`（**排障用**，不改变默认配置）。
     * 存在的理由：推理模型的思考也吃 maxTokens，额度不足时正式输出会被挤没；
     * 有了覆盖就能在**不重启**的前提下试不同额度与模型，而不是改一次配置跑一轮。
     */
    maxTokens?: number;
    /** 覆盖模型（排障用）。传空串 = 用已解析的默认模型 */
    model?: string;
}
export interface CompressorState {
    available: boolean;
    provider?: string;
    model?: string;
    /** 不可用原因（供自检端点/排障读；不触发任何探测） */
    reason?: string;
}
export interface Compressor {
    /** 解析实际生效的 provider/model；不可用时返回 null（此时已记录一次告警） */
    resolve(): Promise<{
        provider: string;
        model: string;
    } | null>;
    /** **同步**读诊断状态。存在的理由：null 只能说明"不可用"，说不清为什么 —— 排障时需要原因 */
    state(): CompressorState;
    /** 一次性压缩调用；失败一律抛出，由调用方决定回退策略（本模块不吞错） */
    compress(input: CompressInput): Promise<string>;
}
interface LoggerLike {
    info(message: string): void;
    warn(message: string): void;
}
/**
 * 建一个压缩器。
 *
 * `llm` 允许传 undefined —— 插件宿主未挂载 LLM 服务时，压缩能力整体不可用，
 * 但**不能让插件起不来**：解析失败返回 null、调用抛错，由上层决定降级。
 */
export declare function createCompressor(llm: LlmLike | undefined, config: CompressorConfig, logger: LoggerLike): Compressor;
export {};
