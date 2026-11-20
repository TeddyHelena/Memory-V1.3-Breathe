export declare function sha256Text(text: string): string;
export declare function noteInjection(sessionId: string | undefined, text: string): void;
export interface LlmUsageReceipt {
    request_id: string;
    at: string;
    kind: 'usage';
    input_tokens: number | null;
    output_tokens: number | null;
    cache_read_tokens: number | null;
    cache_write_tokens: number | null;
    kind_note?: string;
}
export interface LlmReceipt {
    request_id: string;
    at: string;
    session_id: string | null;
    purpose: string | null;
    provider: string;
    model: string;
    agent_input_hash: string;
    input_chars: number;
    input_tokens: number | null;
    injection_hash: string | null;
    injection_hash_match: boolean | null;
    injection_present: boolean | null;
    expected_injection_chars: number | null;
    actual_injection_chars: number | null;
    actual_injection_hash: string | null;
    injection_snapshot: string | null;
}
/** 记录一条最终请求收据；返回收据，不抛。 */
export declare function recordLlmReceipt(root: string, options: unknown): LlmReceipt | null;
/** 记录 provider 最终 usage；inputTokens 是未缓存输入，cache 字段分列。 */
export declare function recordLlmUsage(root: string, requestId: string, usage: unknown): LlmUsageReceipt | null;
