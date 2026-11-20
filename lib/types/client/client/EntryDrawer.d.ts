/**
 * 条目抽屉（`#drawer`）—— 逐项照 `01-Memory.html` 的 Agent 页实现
 *
 * ## 原型真值（⛔ 改之前回 `00_记忆系统/docs/V1.3C-Agent页-原型规格.md` 核对）
 * [结构]
 * #drawer
 *   .dhead   #d-id + #d-title + #d-badges + #d-close(×)
 *   .dbody   标题(input) / 摘要(input + i「检索靠它命中，写清『这条是关于什么的』」)
 *            标签(i「回车加一个；共享 ≥2 个标签的条目会在球上连线」) + #d-tags
 *            优先级(number + i「数字越大越靠前」)
 *            正文(i「唯一真源是文件里的这一段；索引是派生的」)
 *                 + #d-md-seg(.seg 预览|编辑) + #d-md-view(.mdbox) / textarea#d-f-content
 *   .ro      kv×6：编号 / 层 / 来源 / 状态 / 衰减 / 来源指针  ＋ .hintline
 *   .dfoot   #d-save 保存 · #d-revert 还原 · #d-state 未改动
 * [/结构]
 * 关键尺寸：`.dhead{padding:13px 18px;border-bottom:1px solid var(--line)}` ·
 * `.dbody{padding:16px 18px 20px}` · `label.f{font-size:12px;color:var(--text2);margin:15px 0 6px}` ·
 * 输入 `13.5px / background:var(--card2) / radius:9px / padding:10px 12px` ·
 * 只读区 `.ro{background:var(--card2);radius:10px;padding:12px 14px}` ·
 * `.kv{display:flex;gap:9px;font-size:12px;color:var(--text2);margin:3px 0}` + `b{color:var(--text);flex:0 0 66px}` ·
 * `.dfoot{padding:12px 18px;border-top:1px solid var(--line);display:flex;gap:9px;align-items:center}` ·
 * `.seg{display:inline-flex;background:var(--card2);radius:8px;padding:2px}` + `.on{background:var(--bg);font-weight:600;box-shadow:elev1}` ·
 * `.mdbox{background:var(--card2);radius:9px;padding:14px 16px;max-height:360px;overflow:auto;font-size:13px;line-height:1.75}`
 *
 * ## ⚠️ 一条安全纪律（原型注释里写着的）
 * 「**渲染前先整体转义**（见 MD.render），容器正文是数据不是 HTML」——
 * 记忆容器是**数据**，里面完全可能有 `<script>`。本文件先 `escapeHtml` 再拼装，
 * ⛔ 任何"直接把正文塞进 innerHTML / dangerouslySetInnerHTML"的写法都不许出现。
 */
import { type ReactNode } from 'react';
import type { MemoryEntryDetail } from './types-client.ts';
export interface EntryDrawerProps {
    id: string;
    getEntry: (id: string) => Promise<MemoryEntryDetail>;
    updateEntry: (id: string, patch: Partial<Pick<MemoryEntryDetail, 'title' | 'content' | 'tags' | 'priority' | 'summary'>>) => Promise<MemoryEntryDetail>;
    onClose: () => void;
    /** 保存成功后通知外面重载列表（真源在盘上，⛔ 不做乐观更新） */
    onChanged: () => void;
}
export declare function EntryDrawer({ id, getEntry, updateEntry, onClose, onChanged }: EntryDrawerProps): ReactNode;
