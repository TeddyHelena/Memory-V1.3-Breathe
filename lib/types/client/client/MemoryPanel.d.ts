/**
 * 记忆主面板（`main` 座位）—— **参数照抄原型 `01-Memory.html` 的 Agent 页**
 *
 * ## 这一版为什么重写
 * 上一版我是"看着像"自己编的（栅格比例自定、圆角 10、卡片靠 `border:1px` 立起来…），
 * Teddy 一眼看出不对：「你好好看一下那个 html 里面关于 Agent 页面的具体参数包括风格」。
 * 现按原型**逐项对照**重做。真值（⛔ 改之前先回原型核对，别凭印象调）：
 *
 * | 项 | 原型真值 |
 * |---|---|
 * | 卡面怎么立起来 | **灰填充 + 阴影，不靠描边**（`--card` + `elev-panel = 0 0 0 .5px rgba(0,0,0,.10), 0 3px 8px rgba(0,0,0,.03), 0 0 16px rgba(0,0,0,.02)`） |
 * | 主区 `.app` | `display:flex; gap:14px; padding:0 26px 20px`（26px 与 DSH 主区对齐，⛔ 别再叠一层） |
 * | 左栏 `.left` | `flex:0 0 44%; max-width:560px; border-radius:16px; overflow:hidden` |
 * | 右栏 `.right` | `flex:1 1 auto; flex-direction:column; gap:14px` |
 * | 筛选卡 `.bar` | `padding:12px 14px; border-radius:16px` |
 * | 控件 | `font-size:12.5px; background:var(--card); border:none; border-radius:8px; padding:7px 10px`；focus `0 0 0 1.5px var(--brand)` |
 * | 列表行 `.item` | `border-top:1px solid var(--line)`（首行无）· hover `background:var(--hover)` · `.h{padding:12px 16px;gap:8px}` |
 * | 行内文字 | `.id` 等宽 11px `--text2` `min-width:30px`｜`.t` `13.5px/500` 省略号｜`.u` `margin-left:auto 11px` |
 * | 图例 `.legend` | `padding:8px 18px 14px; gap:13px; font-size:11.5px`；圆点 **9px 圆形**，空心 `1.4px solid currentColor` |
 * | 身份胶囊 `.who` | 绝对定位球卡左上 `left:14px top:12px`，`border-radius:999px`，`box-shadow:elev2` |
 * | 抽屉 | `.dhead{padding:13px 18px;border-bottom:1px solid var(--line)}` · `.dbody{padding:16px 18px 20px}` · 标签 12px`--text2` · 输入 13.5px `--card2` `radius:9px` · 只读区 `.ro{background:var(--card2);radius:10px;padding:12px 14px}` |
 *
 * ## 我加的那一块（C-3，原型没有）
 * **人格锚点区**放在**左栏球卡内部**（球下面、图例上面）：它属于"身份/人格"，与球同栏最自然；
 * 且**打开就能看见**（C-3 第 1 问的直接解药），不需要新增顶层区块去破坏原型结构。
 *
 * ## 三条纪律
 *   ① `h*` 只读（永不自动改）；② "热"取 **`hot_order` 名单**（不是 `layer==='hot'`，真身 11 vs 10）；
 *   ③ 读不到 ≠ 不在 —— 失败只降级对应卡片，⛔ 不白屏、⛔ 不弹向导。
 */
import { type ReactNode } from 'react';
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { MemoryPanelInjected } from './types-client.ts';
export type MemoryPanelProps = PropsLocale<'settings.memory'> & InjectFace<MemoryPanelInjected> & {
    size?: number;
    active?: boolean;
};
/** 带兜底的对外入口（宿主注册这个） */
export declare function MemoryPanelSafe(props: Parameters<typeof MemoryPanel>[0]): ReactNode;
export declare function MemoryPanel({ list, graph: graphApi, tiers: tiersApi, chain: chainApi, getEntry, updateEntry, relocate, expire, confirmPending, discardPending, supersede, onboarding, identity: identityApi, saveIdentity, markOnboarded, decayState, decaySweep, decayRollback }: MemoryPanelProps): ReactNode;
