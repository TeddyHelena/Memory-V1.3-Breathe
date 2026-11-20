/** memory-container settings tab (browser half): 知识球 / 关系图 / 列表三视图 + 编辑。 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import { type MemoryTabLocaleKey } from './locales.ts';
export type { MemoryPanelProps } from './MemoryPanel.tsx';
export type { MemoryPanelIconProps } from './MemoryPanelIcon.tsx';
export type { MemoryEntryDetail, MemoryEntryMeta, MemoryListData, MemoryPanelInjected } from './types-client.ts';
export type { MemoryGraph, GraphNode, GraphLink } from './graph-types.ts';
export type { MemoryTabLocaleKey } from './locales.ts';
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        /** Memory container settings tab copy. */
        'settings.memory': MemoryTabLocaleKey;
    }
}
/** Dictionary namespace owned by this plugin. */
export declare const NS = "settings.memory";
/** Services required by the Settings registration. */
export declare const inject: string[];
/**
 * 【2026-10-14】HTTP 出口**整体搬到 `./api-surface.ts`**（那里能在 node 里跑 ⇒ 能测**真接线**）。
 * 起因：对抗验证 E 发现 `decayState/decaySweep/decayRollback` **二次解包** `r.data`
 * （而 `apiFetch` 已经剥过壳）⇒ 恒取兜底零值 ⇒ **衰减那行 UI 与撤销按钮从来没工作过**。
 * ⛔ 这个 bug 在沙箱里看不见 —— 沙箱注入的是**桩**，桩绕过了 `apiFetch`。
 *    ⇒ 判"接线对不对"必须用**真 HTTP + 真注入面**（见 `test/client-wiring.test.mjs`）。
 */
/** Contribute the Memory tab to the Plugins settings section. */
export declare function apply(ctx: ClientContext): void;
