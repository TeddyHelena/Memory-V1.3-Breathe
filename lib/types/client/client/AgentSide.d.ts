/**
 * Agent 镜头右栏（1:1 原型 01-Memory.html）：我的记忆 / 还能读到多少 / 状态 / 层 /
 * 每层平均完整度 / 最近写入。全部读真实 entries + tiers；不造假数据。
 */
import type { ReactNode } from 'react';
import type { MemoryEntryMeta } from './types-client.ts';
export interface AgentSideProps {
    entries: MemoryEntryMeta[];
    hotOrder: string[];
    tiers: Record<string, string>;
    linkCount: number;
    decay: {
        lastCount: number;
        rolledBack: boolean;
    } | null;
    onRollback: () => void;
    onOpen: (id: string) => void;
}
export declare function AgentSide({ entries, hotOrder, tiers, linkCount, decay, onRollback, onOpen }: AgentSideProps): ReactNode;
