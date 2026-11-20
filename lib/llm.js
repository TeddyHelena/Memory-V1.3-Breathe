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
import { randomUUID } from 'node:crypto';
/** 插件标识，写进消息 source 供宿主审计 */
const PLUGIN_ID = 'dsh-memory-container';
function pickModelName(model) {
    const name = model.id ?? model.model ?? model.name;
    return typeof name === 'string' && name.length > 0 ? name : null;
}
/**
 * 建一个压缩器。
 *
 * `llm` 允许传 undefined —— 插件宿主未挂载 LLM 服务时，压缩能力整体不可用，
 * 但**不能让插件起不来**：解析失败返回 null、调用抛错，由上层决定降级。
 */
export function createCompressor(llm, config, logger) {
    /** undefined = 尚未解析；null = 已解析为不可用（避免每次都重探） */
    let resolved;
    let warned = false;
    let lastReason;
    const warnOnce = (message) => {
        lastReason = message;
        if (warned)
            return;
        warned = true;
        logger.warn(message);
    };
    const resolve = async () => {
        if (resolved !== undefined)
            return resolved;
        if (!llm) {
            resolved = null;
            warnOnce('压缩接入点不可用：宿主未提供 LLM 服务（ctx.llm），compressModel 相关配置将被忽略');
            return resolved;
        }
        const hint = (config.providerHint ?? 'deepseek').toLowerCase();
        try {
            let provider = config.provider?.trim() ?? '';
            if (provider.length === 0) {
                const providers = llm.listProviders();
                const hit = providers.find((p) => p.id.toLowerCase().includes(hint)) ??
                    providers.find((p) => p.name.toLowerCase().includes(hint));
                if (!hit) {
                    resolved = null;
                    warnOnce(`压缩接入点不可用：未找到匹配「${hint}」的 provider（可用：${providers.map((p) => p.id).join(', ') || '无'}）。` +
                        '可在配置里显式指定 compressProvider / compressModel。');
                    return resolved;
                }
                provider = hit.id;
            }
            let model = config.model?.trim() ?? '';
            if (model.length === 0) {
                const models = await llm.listModels(provider);
                const first = models.map(pickModelName).find((name) => name !== null) ?? null;
                if (!first) {
                    resolved = null;
                    warnOnce(`压缩接入点不可用：provider「${provider}」没有可用模型，请显式配置 compressModel`);
                    return resolved;
                }
                model = first;
            }
            resolved = { provider, model };
            logger.info(`压缩接入点已就绪：provider=${provider} model=${model}`);
            return resolved;
        }
        catch (error) {
            resolved = null;
            warnOnce(`压缩接入点探测失败（${String(error)}）——压缩能力不可用，不影响其它功能`);
            return resolved;
        }
    };
    return {
        resolve,
        state() {
            if (resolved)
                return { available: true, provider: resolved.provider, model: resolved.model };
            return { available: false, ...(lastReason === undefined ? {} : { reason: lastReason }) };
        },
        async compress(input) {
            const target = await resolve();
            if (!target || !llm)
                throw new Error('compress unavailable: no resolved provider/model');
            const message = {
                id: randomUUID(),
                role: 'user',
                content: [{ type: 'text', text: input.text }],
                source: { kind: 'plugin', plugin: PLUGIN_ID },
            };
            let out = '';
            let reasoning = '';
            const chunkStats = {};
            let finish;
            for await (const chunk of llm.stream({
                provider: target.provider,
                model: input.model && input.model.length > 0 ? input.model : target.model,
                messages: [message],
                system: input.instruction,
                ...((input.maxTokens ?? config.maxTokens) === undefined
                    ? {}
                    : { maxTokens: input.maxTokens ?? config.maxTokens }),
                purpose: 'compaction',
                ...(input.signal === undefined ? {} : { signal: input.signal }),
            })) {
                chunkStats[chunk.type] = (chunkStats[chunk.type] ?? 0) + 1;
                if (chunk.type === 'text-delta' && typeof chunk.text === 'string')
                    out += chunk.text;
                else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string')
                    reasoning += chunk.text;
                else if (chunk.type === 'finish') {
                    const r = chunk.reason;
                    finish = typeof r === 'object' && r !== null && 'kind' in r
                        ? String(r.kind)
                        : String(r ?? 'unknown');
                }
            }
            const text = out.trim();
            if (text.length === 0) {
                // 失败必须**说清为什么**：只报「没有输出」会让人以为是调用没发生。
                // 真实踩过的坑：4.08 秒的调用确实发生了，但输出全进了 reasoning 通道
                // （或 max-tokens 被思考吃光），text-delta 一个都没有 —— 与「没调用」表现相同。
                const hint = reasoning.length > 0
                    ? `输出全在 reasoning 通道（${reasoning.length} 字符，前 80 字：「${reasoning.slice(0, 80)}」）——` +
                        '应改用非推理模型，或提高 maxTokens 给正式输出留额度'
                    : '模型未产出任何内容';
                throw new Error(`compress produced no text output — chunks=${JSON.stringify(chunkStats)} ` +
                    `finish=${finish ?? 'none'} reasoningChars=${reasoning.length}；${hint}`);
            }
            return text;
        },
    };
}
