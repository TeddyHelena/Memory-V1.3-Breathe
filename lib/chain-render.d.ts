import type { MemoryContainer } from './container.js';
import type { SubjectStore } from './subjects.js';
import type { InjectionLedger } from './injection-ledger.js';
import { type ChainPlan } from './chain.js';
import type { TierMode } from './persona.js';
export declare function tierModeOf(tier: ChainPlan['tiers'][number]['tier']): TierMode;
export interface TierOverridesResult {
    map: Map<string, TierMode>;
    plan: ChainPlan;
    today: number;
    activeDays: number;
}
/**
 * 计算档位覆盖（读容器 + 活跃日账本；⚠️ 会读 147+ 个条目文件，**调用方必须按天缓存**）。
 */
export declare function computeTierOverrides(container: MemoryContainer, subjects: SubjectStore, ledger: InjectionLedger, H: number, theta: number, opts?: {
    rendering?: boolean;
    limit?: number;
}): TierOverridesResult;
/**
 * 【P6 门禁 · 2026-10-26】`chainRender=true` 的启动前置：
 * 必须有已冻结的 `chain-render-baseline.json`（7 个活跃日、chars.p50>0）。
 * ⛔ 没有基线就退回旧渲染（fail-closed），不许“先开再补基线”。
 */
export declare function chainRenderBaselineOk(root: string): {
    ok: boolean;
    reason: string;
};
