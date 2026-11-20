/**
 * 【P7 · 2026-10-19】链级计划 → 日扫计划（单生产者适配）。
 * ⛔ 只在 `chainJudge=true` 时使用；缺省路径仍走 `planDecaySweep`。
 */
import type { ChainPlan } from './chain.js';
import type { DecayPlan } from './decay.js';
export declare function chainPlanToDecayPlan(plan: ChainPlan): DecayPlan;
