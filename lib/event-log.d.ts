export type EventKind = 'mention' | 'activation' | 'render' | 'tier-change' | 'publication' | 'candidates' | 'chain-shadow' | 'orphan-report';
export declare const EVENT_KINDS: readonly EventKind[];
/** 追加一条事件；⛔ 永不抛（观测口，不拖垮主流程） */
export declare function appendEvent(root: string, kind: EventKind, payload: Record<string, unknown>, logger?: {
    error: (m: string) => void;
}): boolean;
/** 读一类事件（诊断/自检用；坏行跳过） */
export declare function readEvents(root: string, kind: EventKind): Array<Record<string, unknown>>;
/** 自检：哪些类还没有任何记录（空数组 = 全有；用于 P1 退出判据） */
export declare function missingEventKinds(root: string): EventKind[];
