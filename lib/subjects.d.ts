export type SubjectKind = 'root' | 'system' | 'project' | 'conversation';
export interface SubjectRecord {
    id: string;
    name: string;
    aliases: string[];
    kind: SubjectKind;
    parent: string | null;
    session_id?: string;
    transcript_ref?: string;
    created_at: string;
    last_grown: string;
    last_activated: string;
}
export interface SubjectStoreOptions {
    /** 写失败/锁失败要能看见（默认静默，供脚本/测试用） */
    log?: {
        error: (message: string) => void;
        warn?: (message: string) => void;
    };
}
/** 切口首句 → 临时名字（只记录；正式命名由后续人工/模型补） */
export declare function provisionalName(text: string): string;
export declare class SubjectStore {
    private readonly root;
    private readonly dir;
    private readonly indexFile;
    private readonly byId;
    private readonly bySession;
    /** 本实例删过的 id：save 合并磁盘时必须跳过（防复活） */
    private readonly removed;
    private readonly log;
    constructor(root: string, options?: SubjectStoreOptions);
    private load;
    /** 【B6】从 subjects/*.md 的 frontmatter 重建索引（解析坏的文件跳过并告警） */
    private rebuildFromFiles;
    /**
     * 把 `subjects/*.md` 里存在、但索引没有的记录补回内存（只补缺，不改已有字段）。
     * ⛔ 已 remove 的 id 跳过（防复活）；返回补回条数。
     */
    private reconcileFromFiles;
    private seed;
    private writeFile;
    /**
     * 落盘。**锁内**重读合并再写（s4 实测：只“写前重读”不互斥，4 进程仍丢 4/24）。
     * 锁失败不写（内存与 md 都还在，下次重试/重启 reconcile 兜底），并报 error，不静默。
     */
    private save;
    /** 切口：会话首条真人消息 ⇒ 建会话 subject（只建一次） */
    openConversation(sessionId: string, text: string): string | null;
    /**
     * 【P3】认亲：在文本里找 subject 名字/别名（**不传递闭包**，只做一跳）。
     * · 同名多命中 ⇒ 按 `last_activated` 最近者胜（同名最近活跃裁决）；
     * · root/system 不参与（“我”“记忆系统”出现在几乎每句话里，不是认亲信号）。
     */
    scan(text: string, mainId?: string | null, excludeId?: string | null): Array<{
        id: string;
        name: string;
        matched: string;
        primary: boolean;
    }>;
    /** 【P3】更新活跃时间（人工提及才刷新；P3 只记 mention，不驱动判定） */
    touchActivated(id: string, at?: string): void;
    /** 回填用：设置 last_grown/last_activated 并落盘（不碰名字/父链） */
    setLastGrown(id: string, iso: string): boolean;
    mainSubjectOf(sessionId: string): string | null;
    /** 删除（冒烟/误建清理；⛔ 不用于正常遗忘——那由 §13 的公示制走） */
    remove(id: string): boolean;
    get(id: string): SubjectRecord | undefined;
    list(): SubjectRecord[];
    /**
     * 自检：索引 sha 对上 + **会话 md 与索引一致**。
     * 【并发修复 · 2026-10-19】修前只比内存↔索引 ⇒ 索引丢 4 个会话仍 ok:true（s4 实测假绿）。
     */
    selfCheck(): {
        ok: boolean;
        count: number;
        sha256: string;
        mdOrphans: number;
        note?: string;
    };
}
/** 【P3】疑问式判定：疑问式算 1 次提及（不是 2 次） */
export declare function isQuestionForm(text: string): boolean;
