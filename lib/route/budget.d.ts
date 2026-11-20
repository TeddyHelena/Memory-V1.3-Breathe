/**
 * budget.ts —— V1.2 预算守护（契约清单 §四）
 *
 * ── 三个必须先说清的口径（TechDesign 初稿在这三处都不清）──────────
 * ① **货币是字符，不是条数**。V1.1 的动态预算（`budget.ts` 的 `TokenBudget`）
 *    算出来的是字符额度；这里若再引一套"条数上限"，两套货币打架时无法预测
 *    实际注入。所以：条数只用于**保底额度**，总量完全由字符把控。
 * ② **按 `summary.length` 计数，因为注入的就是 summary**。
 *    初稿按 summary 计、注入全文时，16k 的"硬上限"实际能顶到 2~3 倍——
 *    安全阀变成心理安慰。计数口径与注入口径必须同一个字段。
 * ③ **保底条目也计入 `mainChars`**，但豁免"超预算就拒收"。
 *    否则保底与预算是两条互不相干的规则，合起来能突破任何上限。
 */
import type { RouteConfig, ScoredEntry } from './types.js';
import { type LayerTrace } from '../contract/layer.js';
export interface AllocationResult {
    main: ScoredEntry[];
    candidates: ScoredEntry[];
    /** 审计信息（回执与自检端点用） */
    info: {
        mainChars: number;
        hardCap: number;
        guaranteedUsed: number;
        guaranteedQuota: number;
        /** 因预算不足转入候选区的条数 */
        overflowed: number;
        /** 因**条数硬上限**转入候选区的条数（与 overflowed 分开计：两者的修法不同） */
        capBlocked: number;
        /** 因未过硬门禁被挡在 main 之外的条数 */
        gateBlocked: number;
        /** 每个未进 main 的条目：hot-resident/gate/max-entries/gate-in/budget-chars */
        dropReasons: Record<string, string>;
        /** 因已常驻（hot_order）被挡出动态段的条数（D1 去重投递） */
        dedupedBlocked: number;
        /**
         * gate_in 的基准集合声明与实际取到的门槛值。
         *
         * `baseSet` 恒为 `'gatePassed'`（**不是** 'callAll'）；`value === null` 表示
         * 基准集合为空 → **不抬门槛、main 为空**。
         * 这两个字段存在的理由：让"相对量用了哪个基准"变成**可审计的运行期事实**，
         * 而不是注释里的一句承诺。
         */
        gateIn: {
            baseSet: 'gatePassed';
            fraction: number;
            value: number | null;
            eligible: number;
        };
    };
}
/**
 * 分配：排序 → 硬门禁分流 → 保底 → 字符预算。
 *
 * 顺序不可交换：**先分流再算预算**，否则未过门禁的条目会先占掉字符额度，
 * 把有资格的条目挤进候选区（这是"预算被污染"的典型形态）。
 */
export declare function allocate(entries: ScoredEntry[], config: RouteConfig, trace?: LayerTrace, opts?: {
    exclude?: (e: ScoredEntry) => boolean;
}): AllocationResult;
