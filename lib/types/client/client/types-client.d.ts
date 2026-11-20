/** client 侧共享 wire 类型（与 host API 对齐） */
/** 条目元信息（列表） */
export interface MemoryEntryMeta {
    id: string;
    layer: 'hot' | 'archive' | 'longterm' | 'pending';
    title: string;
    tags: string[];
    priority: number;
    updated: string;
    summary: string;
    file: string;
    scope: 'global' | 'workspace' | 'project';
    scope_id?: string;
    temporal_state: 'active' | 'stale' | 'future' | 'expired' | 'superseded';
    visible_in_current_scope: boolean;
    source?: string;
    source_line?: string;
    /** 生命周期标记（active/expired/superseded…）；候选丢弃后按它隐藏转正按钮 */
    status?: string;
    /** 衰减类型（core/recent/process）—— Agent 页每行的 chip 与"衰减："统计用 */
    decay_type?: string; /** 新鲜度 = 2^(-t/H)，H=30 天（宿主用 `fresh.ts` 算，客户端⛔ 不重算）*/
    fresh?: number;
}
/** 列表数据 */
export interface MemoryListData {
    schema: string;
    generated_at: string;
    entry_count: number;
    hot_order: string[];
    allowEdit: boolean;
    entries: MemoryEntryMeta[];
}
/** 条目详情 */
export interface MemoryEntryDetail {
    id: string;
    layer: 'hot' | 'archive' | 'longterm' | 'pending';
    title: string;
    tags: string[];
    priority: number;
    updated: string;
    summary: string;
    content: string;
    source?: string;
    source_line?: string;
    source_session?: string;
    source_message?: string;
    created_at?: string;
    scope?: 'global' | 'workspace' | 'project';
    scope_id?: string;
    valid_from?: string;
    valid_to?: string;
    expires?: string;
    status?: string;
    superseded_by?: string;
    supersedes?: string[];
}
/** 链镜头数据：真实 subject + 条目 session 映射 */
export interface MemoryChainData {
    subjects: Array<{
        id: string;
        name: string;
        kind: string;
        parent: string | null;
        session_id?: string;
        last_grown?: string;
        last_activated?: string;
    }>;
    entrySessions: Record<string, string>;
    tiers: Record<string, string>;
}
/** 注册侧数据访问器（host fetch 封装） */
export interface MemoryTabInjected {
    list: () => Promise<MemoryListData>;
    getEntry: (id: string) => Promise<MemoryEntryDetail>;
    updateEntry: (id: string, patch: Partial<Pick<MemoryEntryDetail, 'title' | 'content' | 'tags' | 'priority' | 'summary'>>) => Promise<MemoryEntryDetail>;
    /** 候选转正（V1.0）：POST /pending/:id/confirm */
    confirmPending: (id: string) => Promise<unknown>;
    /** 候选丢弃（V1.0）：POST /pending/:id/discard */
    discardPending: (id: string) => Promise<unknown>;
    graph: () => Promise<import('./graph-types.ts').MemoryGraph>;
    /** 真实 Breathe 档位（full/snapshot/outline/forgotten）；服务端未启用时为空对象 */
    tiers: () => Promise<Record<string, string>>;
    chain: () => Promise<MemoryChainData>;
}
/**
 * 【C-2】主面板的注入面：在设置页签的基础上**多三个写通道**（都走 host 侧既有原语）。
 * ⛔ 不加"删除"——架构是**自然衰减**，UI 不给删除入口（诉求书 §6.2 已定）。
 */
export interface MemoryPanelInjected extends MemoryTabInjected {
    /** POST /entry-relocate/:id —— 升 hot / 降归档（host 侧复用 writer.relocate） */
    relocate: (id: string, layer: 'hot' | 'longterm' | 'archive', reason?: string) => Promise<unknown>;
    /** POST /entry-supersede/:id —— 取代链（必须给"被谁取代"） */
    supersede: (id: string, by: string, reason?: string) => Promise<unknown>;
    /** POST /entry-expire/:id —— 标记过期（**expires 是唯一到期口径**） */
    expire: (id: string, expires: string) => Promise<unknown>;
    /** GET /onboarding —— 首启状态（版本号比对；读不到 ⇒ needed:false，⛔ 不弹） */
    onboarding: () => Promise<{
        needed: boolean;
        version: string | null;
        onboardedAt: string | null;
        reason: string;
    }>;
    /** GET /identity —— 身份档案（字段名与值） */
    identity: () => Promise<{
        schema: string;
        fields: Record<string, unknown>;
        updatedAt: string | null;
        droppedKeys: string[];
    }>;
    /** PUT /identity —— 存「认识一下」填的东西（白名单外的键会被 host 丢弃并留痕） */
    saveIdentity: (fields: Record<string, unknown>) => Promise<unknown>;
    /** POST /onboarding —— 记下"这一版走过了"（比版本号，⛔ 不是布尔） */
    markOnboarded: () => Promise<unknown>; /** 【B6】衰减扫描状态（面板那行"今天自动归档 M 条 · 撤销"）*/
    decayState: () => Promise<{
        lastAt: number | null;
        lastCount: number;
        batch: string;
        rolledBack: boolean;
    }>;
    /** 【B6】手动跑一次（force 可强制）*/
    decaySweep: (force?: boolean) => Promise<{
        ran: boolean;
        archived: string[];
        blocked: number;
        reason?: string;
    }>;
    /** 【B6】撤销最近一批自动降层 */
    decayRollback: () => Promise<{
        rolledBack: string[];
        count: number;
        batch?: string;
    }>;
}
