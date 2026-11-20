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

import { randomUUID } from 'node:crypto'

/** 插件标识，写进消息 source 供宿主审计 */
const PLUGIN_ID = 'dsh-memory-container'

export interface LlmProviderLike {
  id: string
  name: string
}

export interface LlmModelLike {
  id?: string
  model?: string
  name?: string
}

export interface LlmStreamChunkLike {
  type: string
  text?: string
  /** 仅 `finish` chunk 有：停止原因（'stop' | 'tool-calls' | 'max-tokens' | ...） */
  reason?: unknown
}

/** 本插件用到的 `ctx.llm` 最小能力面（结构化类型，不依赖 dsh-llm 的类型包） */
export interface LlmLike {
  listProviders(): LlmProviderLike[]
  listModels(provider: string): Promise<LlmModelLike[]>
  stream(options: {
    provider: string
    model: string
    messages: unknown[]
    system?: string
    maxTokens?: number
    purpose?: string
    signal?: AbortSignal
  }): AsyncIterable<LlmStreamChunkLike>
}

export interface CompressorConfig {
  /** 显式指定 provider 路由 id（如 `deepseek-official`）。空 = 自动探测 */
  provider?: string
  /** 显式指定 model。空 = 取该 provider 的第一个可用模型 */
  model?: string
  /** 压缩调用输出上限（token） */
  maxTokens?: number
  /** 自动探测时匹配 provider 的关键字（默认 `deepseek`） */
  providerHint?: string
}

export interface CompressInput {
  /** 待压缩原文 */
  text: string
  /** 压缩指令（作为 system 传） */
  instruction: string
  signal?: AbortSignal
  /**
   * 覆盖配置里的 `maxTokens`（**排障用**，不改变默认配置）。
   * 存在的理由：推理模型的思考也吃 maxTokens，额度不足时正式输出会被挤没；
   * 有了覆盖就能在**不重启**的前提下试不同额度与模型，而不是改一次配置跑一轮。
   */
  maxTokens?: number
  /** 覆盖模型（排障用）。传空串 = 用已解析的默认模型 */
  model?: string
}

export interface CompressorState {
  available: boolean
  provider?: string
  model?: string
  /** 不可用原因（供自检端点/排障读；不触发任何探测） */
  reason?: string
}

export interface Compressor {
  /** 解析实际生效的 provider/model；不可用时返回 null（此时已记录一次告警） */
  resolve(): Promise<{ provider: string; model: string } | null>
  /** **同步**读诊断状态。存在的理由：null 只能说明"不可用"，说不清为什么 —— 排障时需要原因 */
  state(): CompressorState
  /** 一次性压缩调用；失败一律抛出，由调用方决定回退策略（本模块不吞错） */
  compress(input: CompressInput): Promise<string>
}

interface LoggerLike {
  info(message: string): void
  warn(message: string): void
}

function pickModelName(model: LlmModelLike): string | null {
  const name = model.id ?? model.model ?? model.name
  return typeof name === 'string' && name.length > 0 ? name : null
}

/**
 * 建一个压缩器。
 *
 * `llm` 允许传 undefined —— 插件宿主未挂载 LLM 服务时，压缩能力整体不可用，
 * 但**不能让插件起不来**：解析失败返回 null、调用抛错，由上层决定降级。
 */
export function createCompressor(
  llm: LlmLike | undefined,
  config: CompressorConfig,
  logger: LoggerLike,
): Compressor {
  /** undefined = 尚未解析；null = 已解析为不可用（避免每次都重探） */
  let resolved: { provider: string; model: string } | null | undefined
  let warned = false
  let lastReason: string | undefined

  const warnOnce = (message: string): void => {
    lastReason = message
    if (warned) return
    warned = true
    logger.warn(message)
  }

  const resolve = async (): Promise<{ provider: string; model: string } | null> => {
    if (resolved !== undefined) return resolved

    if (!llm) {
      resolved = null
      warnOnce('压缩接入点不可用：宿主未提供 LLM 服务（ctx.llm），compressModel 相关配置将被忽略')
      return resolved
    }

    const hint = (config.providerHint ?? 'deepseek').toLowerCase()
    try {
      let provider = config.provider?.trim() ?? ''
      if (provider.length === 0) {
        const providers = llm.listProviders()
        const hit =
          providers.find((p) => p.id.toLowerCase().includes(hint)) ??
          providers.find((p) => p.name.toLowerCase().includes(hint))
        if (!hit) {
          resolved = null
          warnOnce(
            `压缩接入点不可用：未找到匹配「${hint}」的 provider（可用：${providers.map((p) => p.id).join(', ') || '无'}）。` +
              '可在配置里显式指定 compressProvider / compressModel。',
          )
          return resolved
        }
        provider = hit.id
      }

      let model = config.model?.trim() ?? ''
      if (model.length === 0) {
        const models = await llm.listModels(provider)
        const first = models.map(pickModelName).find((name) => name !== null) ?? null
        if (!first) {
          resolved = null
          warnOnce(`压缩接入点不可用：provider「${provider}」没有可用模型，请显式配置 compressModel`)
          return resolved
        }
        model = first
      }

      resolved = { provider, model }
      logger.info(`压缩接入点已就绪：provider=${provider} model=${model}`)
      return resolved
    } catch (error) {
      resolved = null
      warnOnce(`压缩接入点探测失败（${String(error)}）——压缩能力不可用，不影响其它功能`)
      return resolved
    }
  }

  return {
    resolve,
    state(): CompressorState {
      if (resolved) return { available: true, provider: resolved.provider, model: resolved.model }
      return { available: false, ...(lastReason === undefined ? {} : { reason: lastReason }) }
    },
    async compress(input: CompressInput): Promise<string> {
      const target = await resolve()
      if (!target || !llm) throw new Error('compress unavailable: no resolved provider/model')

      const message = {
        id: randomUUID(),
        role: 'user' as const,
        content: [{ type: 'text' as const, text: input.text }],
        source: { kind: 'plugin' as const, plugin: PLUGIN_ID },
      }

      let out = ''
      let reasoning = ''
      const chunkStats: Record<string, number> = {}
      let finish: string | undefined
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
        chunkStats[chunk.type] = (chunkStats[chunk.type] ?? 0) + 1
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
        else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') reasoning += chunk.text
        else if (chunk.type === 'finish') {
          const r = chunk.reason
          finish = typeof r === 'object' && r !== null && 'kind' in r
            ? String((r as { kind: unknown }).kind)
            : String(r ?? 'unknown')
        }
      }

      const text = out.trim()
      if (text.length === 0) {
        // 失败必须**说清为什么**：只报「没有输出」会让人以为是调用没发生。
        // 真实踩过的坑：4.08 秒的调用确实发生了，但输出全进了 reasoning 通道
        // （或 max-tokens 被思考吃光），text-delta 一个都没有 —— 与「没调用」表现相同。
        const hint = reasoning.length > 0
          ? `输出全在 reasoning 通道（${reasoning.length} 字符，前 80 字：「${reasoning.slice(0, 80)}」）——` +
            '应改用非推理模型，或提高 maxTokens 给正式输出留额度'
          : '模型未产出任何内容'
        throw new Error(
          `compress produced no text output — chunks=${JSON.stringify(chunkStats)} ` +
          `finish=${finish ?? 'none'} reasoningChars=${reasoning.length}；${hint}`,
        )
      }
      return text
    },
  }
}
