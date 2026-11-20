/**
 * 记忆链（1:1 结构）：根「我」→ 系统 → 项目 → 环；左时间线、右环详情。
 * 数据来自真实 entries/tiers；系统按日期段映射（V1.1/V1.2/V1.3），不伪造合成 CHAIN。
 */
import { type ReactNode } from 'react';
import type { MemoryChainData, MemoryEntryMeta } from './types-client.ts';
export interface ChainLensProps {
    entries: MemoryEntryMeta[];
    hotOrder: string[];
    tiers: Record<string, string>;
    chain?: MemoryChainData | null;
    onOpen: (id: string) => void;
}
export declare function ChainLens({ entries, hotOrder, tiers, chain, onOpen }: ChainLensProps): ReactNode;
