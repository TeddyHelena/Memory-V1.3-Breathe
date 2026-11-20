/**
 * memory-container HTTP API（设置页「记忆」标签的数据通道）
 *
 * 设计原则（沿用插件既有调度逻辑）：
 *   - 无框架依赖：webServer 是标准 Node http handler，纯手写路由
 *   - fail-fast：解析/读写失败返回结构化错误，不静默吞
 *   - 写路径显式开关：PUT/POST 只在 config.allowEdit=true 时注册，默认只读
 *   - 原子写：所有落盘走 container 的 atomicWrite（tmp + rename）
 *
 * 路由（前缀 config.apiPrefix，默认 /api/memory）：
 *   GET  /list          → 分层列出条目元信息（含 hot_order）
 *   GET  /graph         → 关系图谱数据（节点 + 钩稽边，知识球/平面图的数据源）
 *   GET  /entry/:id     → 单条完整内容（frontmatter + 正文）
 *   PUT  /entry/:id     → 编辑单条（title/content/tags/priority/summary）
 *                        （仅 allowEdit=true 时注册）
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { MemoryContainer } from './container.js';
import type { MemoryScopeContext } from './types.js';
import type { MemoryWriter } from './writer.js';
import { type ChainStore } from './chains.js';
/**
 * 构建 memory 数据 API 的 webServer handler。
 * 返回 { handler, routes }：routes 供日志诊断；handler 供 webServer.register。
 */
export declare function createMemoryApi(container: MemoryContainer, opts: {
    prefix: string;
    allowEdit: boolean;
    /**
     * ⭐【2026-10-17】每条被投递过几次（来自 InjectionLedger）。
     * 只读端点 `/decay-state`、`/decay-why` 与手动 `/decay-sweep` 必须与启动路径**同一口径**，
     * 否则界面上的"计划动几条"与真身扫描的结论会不一致（两个真源）。
     */
    deliveredCounts?: () => ReadonlyMap<string, number>;
    /** 【P7】单生产者：chainJudge=true 时手动扫描也用链级计划（缺省 undefined ⇒ 旧行为） */
    chainPlan?: () => import('./decay.js').DecayPlan | undefined;
    /** UI 链镜头：条目档位（缺省 undefined ⇒ 不注册 /tiers） */
    tiers?: () => Record<string, string>;
    /** UI 探针：点击/状态事件落点（缺省 undefined ⇒ 不注册 /ui-probe） */
    uiProbe?: (event: unknown) => void;
    /** exact UI HTML（缺省 undefined ⇒ 不注册 /ui） */
    uiHtml?: () => string;
    /** 认识一下抽卡：服务端模型/模板生成（缺省 undefined ⇒ 不注册 /onboarding/suggest） */
    suggest?: (body: {
        useHistory?: boolean;
        count?: number;
    }) => Promise<unknown>;
    /** 写操作：pin/unpin（缺省 undefined ⇒ 不注册 /pin） */
    pin?: (id: string, pinned: boolean) => unknown;
    /** UI 链镜头：真实 subject 表（缺省 undefined ⇒ 不注册 /chain） */
    subjects?: () => Array<{
        id: string;
        name: string;
        kind: string;
        parent: string | null;
        session_id?: string;
        last_grown?: string;
        last_activated?: string;
    }>;
    /** Breathe 手动记忆链注册表（独立于条目写锁） */
    chainStore?: ChainStore;
    /**
     * 【P1-4 修复 · 2026-10-19】手动扫描的「状态写失败」出口，与启动/tick 同一个出口。
     * 修前手动路不传 ⇒ 闸门没推进、界面回 200 全绿，只有盘上的状态知道它失败了。
     */
    onStateWriteFail?: (e: unknown) => void;
    /** 【P2-6 修复】设置后 /decay-sweep 直接返回「不执行」原因，**不跑 runSweep**（不碰闸门）。 */
    sweepDisabledReason?: string;
    scopeContext?: MemoryScopeContext;
    /**
     * 写入器（V1.0）：提供候选确认/丢弃两条人工转正路径。
     * 不传则不注册 /pending 路由（保持 v0.5 只读语义）。
     */
    writer?: MemoryWriter;
    /**
     * 【C-0 · H1】产品版本号 —— 「认识一下」首启判定拿它比对（⛔ 不许再定义第二个号）。
     */
    productVersion?: string;
    /**
     * 【C-0 · H1/H2】容器根 —— `.onboarded` 与 `identity/profile.json` 的落点。
     * 不传则不注册 /onboarding 与 /identity（保持只读语义）。
     */
    containerRoot?: string;
    /**
     * 共享 token（安全专项 §三-5）：请求须带 `x-memory-token`，否则 401。
     * 空字符串 = 不启用（本地开发/排障用）。token 由插件启动时生成并注入页面。
     */
    token?: string;
    /**
     * 是否校验 Host / Origin 头（安全专项 §三-5 · 防 CSRF 与 DNS rebinding）。
     * 默认 true：只接受 loopback 主机名与 loopback Origin。
     */
    guardHost?: boolean;
    /**
     * 排障自检数据（V1.1 增量② 配套）：动态预算采样状态 + 压缩接入点解析结果。
     * **只读，不触发任何 LLM 调用**。不传则不注册 /selftest 路由。
     */
    introspect?: () => unknown | Promise<unknown>;
    /**
     * 显式触发一次**真实**压缩调用（V1.1 增量② 配套·排障用）。
     * 会产生一次真实 LLM 请求，故只在显式 POST 时执行；不传则不注册该路由。
     */
    compressProbe?: (overrides?: {
        maxTokens?: number;
        model?: string;
        /** 待压文本（评测用）；缺省走探针内置样本，保持既有行为不变 */
        text?: string;
        /** 压缩指令（评测用）；缺省走探针内置指令 */
        instruction?: string;
    }) => Promise<{
        inputChars: number;
        outputChars: number;
        output: string;
        latencyMs?: number;
        model?: string;
        maxTokens?: number;
    }>;
}): {
    handler: (req: IncomingMessage, res: ServerResponse) => void;
    routes: {
        method: string;
        path: string;
        handler: (req: IncomingMessage, res: ServerResponse, rest: string) => Promise<void> | void;
    }[];
    allowEdit: boolean;
};
