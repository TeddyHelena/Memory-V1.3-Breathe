/**
 * 列表的一行（`#list .item`）—— 逐项照原型 `01-Memory.html`
 *
 * ## 三种交互（原型里是分开的，⛔ 别混）
 *   ① **点行** → **行内展开**（`.item.open .detail`）：解释三行 + 正文预览 + 动作按钮行；
 *   ② **点「编辑」** → 开**抽屉**（`#drawer`，见 `EntryDrawer.tsx`）；
 *   ③ 行 hover → 「编辑」按钮显形（展开时常显）。
 *   ⚠️ 我第一版只做了"点行开抽屉" —— 少了一整套交互（第 1 轮对照 A1）。
 *
 * ## 行内展开里有什么（第 1 轮对照 A2/A3/A4）
 *   · **元信息三行**：`来源指针` / `这条从哪来` / `读取效果`
 *     —— 这三行是**可解释性**：用户能看出"它为什么会被检索到 / 为什么不会"；
 *   · **正文预览** `.mdbox`（比抽屉矮一档，max-height 260）；
 *   · **动作按钮行**：标记过期 / 取代 / 升 hot / 降归档
 *     —— 原型上写着「需要新写通道 · 未开工」，**我们现在四个通道都有了**（C-0），所以直接兑现。
 *
 * ## chip 行（A5）
 *   状态（活跃=绿）· 衰减（核心/常规/快衰/未标）· 来源 · **全部标签** —— 原型里每行都有一整行。
 */
import { type ReactNode } from 'react';
import type { MemoryEntryDetail, MemoryEntryMeta, MemoryPanelInjected } from './types-client.ts';
export interface EntryRowProps {
    entry: MemoryEntryMeta;
    /** Breathe 真实档位（服务端未启用时 undefined ⇒ 不显示） */
    tier?: string;
    /** 是否展开（行内） */
    open: boolean;
    onToggle: () => void;
    /** 点「编辑」→ 开抽屉 */
    onEdit: () => void;
    getEntry: (id: string) => Promise<MemoryEntryDetail>;
    relocate: MemoryPanelInjected['relocate'];
    expire: MemoryPanelInjected['expire'];
    /** 【对账抓到的缺口】候选层：转正 / 丢掉 —— 通道一直有，但组件里从没有调用点 */
    confirmPending: MemoryPanelInjected['confirmPending'];
    discardPending: MemoryPanelInjected['discardPending'];
    /** 【同】取代：原来按钮是 disabled（要挑"被谁取代"）⇒ 等于没入口；现在给就地输入 */
    supersede: MemoryPanelInjected['supersede'];
    /** 动完通知外面重载 */
    onChanged: (note: string) => void;
}
export declare function EntryRow({ entry, tier, open, onToggle, onEdit, getEntry, relocate, expire, confirmPending, discardPending, supersede, onChanged }: EntryRowProps): ReactNode;
