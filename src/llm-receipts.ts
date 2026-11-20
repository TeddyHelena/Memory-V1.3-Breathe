/**
 * L3 实际输入收据。
 *
 * 目的：在模型请求的最终发送边界记录“Agent 真正收到了什么”的哈希，
 * 与 L2 注入快照的哈希分开保存，禁止用前者冒充后者。
 *
 * 只写哈希与计数，不落完整 prompt；文件失败绝不影响模型请求。
 */
import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

const LLM_RECEIPTS_FILE = 'llm-receipts.jsonl'

type UnknownRecord = Record<string, unknown>

function routeBlock(text: string): string | null {
  const lines = text.split('\n')
  let i = -1
  for (let k = 0; k < lines.length; k++) if (lines[k].includes('【本轮唤起】')) i = k
  if (i < 0) return null
  const out = [lines[i]]
  for (let j = i + 1; j < lines.length; j++) {
    if (/^-/.test(lines[j])) { out.push(lines[j]); continue }
    if (!lines[j].trim()) continue
    break
  }
  return out.join('\n')
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 最近一次 L2 注入内容（按 session 保存，供 receipt 关联）。 */
const lastInjection = new Map<string, { hash: string; text: string; at: number }>()

export function noteInjection(sessionId: string | undefined, text: string): void {
  const key = sessionId || 'unknown'
  const block = routeBlock(text) ?? text
  lastInjection.set(key, { hash: sha256Text(block), text: block, at: Date.now() })
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']'
  const obj = value as Record<string, unknown>
  return '{' + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ':' + stable(obj[k])).join(',') + '}'
}

function textOfMessages(messages: unknown): string {
  if (!Array.isArray(messages)) return ''
  return messages.map((m) => {
    const r = m as UnknownRecord
    if (typeof r.content === 'string') return r.content
    if (Array.isArray(r.content)) return r.content.map((c) => {
      const b = c as UnknownRecord
      return typeof b.text === 'string' ? b.text : ''
    }).join('')
    return ''
  }).join('\n')
}

/** 从实际请求里找 L2 的【本轮唤起】段；只用于一致性核对，不替代 L2 hash。 */
function findInjectionInMessages(messages: unknown): string | null {
  const text = textOfMessages(messages)
  return routeBlock(text)
}

export interface LlmUsageReceipt {
  request_id: string
  at: string
  kind: 'usage'
  input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  cache_write_tokens: number | null
  kind_note?: string
}

export interface LlmReceipt {
  request_id: string
  at: string
  session_id: string | null
  purpose: string | null
  provider: string
  model: string
  agent_input_hash: string
  input_chars: number
  input_tokens: number | null
  injection_hash: string | null
  injection_hash_match: boolean | null
  injection_present: boolean | null
  expected_injection_chars: number | null
  actual_injection_chars: number | null
  actual_injection_hash: string | null
  injection_snapshot: string | null
}

/** 记录一条最终请求收据；返回收据，不抛。 */
export function recordLlmReceipt(root: string, options: unknown): LlmReceipt | null {
  try {
    const o = (options ?? {}) as UnknownRecord
    const sessionId = typeof o.sessionId === 'string' ? o.sessionId : null
    const injection = lastInjection.get(sessionId || 'unknown')
    const actual = findInjectionInMessages(o.messages)
    // 规范：agent_input_hash 覆盖实际发送边界（provider/model/messages/system/tools）
    const canonical = stable({
      provider: o.provider,
      model: o.model,
      messages: o.messages,
      system: o.system,
      tools: o.tools,
    })
    const receipt: LlmReceipt = {
      request_id: randomUUID(),
      at: new Date().toISOString(),
      session_id: sessionId,
      purpose: typeof o.purpose === 'string' ? o.purpose : null,
      provider: String(o.provider ?? ''),
      model: String(o.model ?? ''),
      agent_input_hash: sha256Text(canonical),
      input_chars: canonical.length,
      input_tokens: null,
      injection_hash: injection?.hash ?? null,
      injection_hash_match: injection ? (actual ? sha256Text(actual) === injection.hash : false) : null,
      injection_present: actual !== null,
      expected_injection_chars: injection?.text.length ?? null,
      actual_injection_chars: actual?.length ?? null,
      actual_injection_hash: actual ? sha256Text(actual) : null,
      injection_snapshot: injection ? 'last-route-render' : null,
    }
    fs.appendFileSync(path.join(root, LLM_RECEIPTS_FILE), JSON.stringify(receipt) + '\n', 'utf8')
    return receipt
  } catch {
    return null
  }
}

/** 记录 provider 最终 usage；inputTokens 是未缓存输入，cache 字段分列。 */
export function recordLlmUsage(root: string, requestId: string, usage: unknown): LlmUsageReceipt | null {
  try {
    const u = (usage ?? {}) as Record<string, unknown>
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
    const r: LlmUsageReceipt = {
      request_id: requestId,
      at: new Date().toISOString(),
      kind: 'usage',
      input_tokens: num(u.inputTokens),
      output_tokens: num(u.outputTokens),
      cache_read_tokens: num(u.cacheReadTokens),
      cache_write_tokens: num(u.cacheWriteTokens),
    }
    const file = path.join(root, LLM_RECEIPTS_FILE)
    // 同一 request_id 的重复 usage：相同则丢弃；冲突则显式记冲突，不静默累加。
    try {
      if (fs.existsSync(file)) {
        for (const line of fs.readFileSync(file, 'utf8').trim().split('\n')) {
          if (!line) continue
          const prev = JSON.parse(line) as Partial<LlmUsageReceipt>
          if (prev.kind === 'usage' && prev.request_id === requestId) {
            const same = ['input_tokens','output_tokens','cache_read_tokens','cache_write_tokens']
              .every((k) => (prev as any)[k] === (r as any)[k])
            if (same) return null
            const conflict = { ...r, kind: 'usage_conflict', kind_note: 'duplicate usage with different values', previous: prev }
            fs.appendFileSync(file, JSON.stringify(conflict) + '\n', 'utf8')
            return r
          }
        }
      }
    } catch { /* 去重失败不阻断记录 */ }
    fs.appendFileSync(file, JSON.stringify(r) + '\n', 'utf8')
    return r
  } catch { return null }
}
