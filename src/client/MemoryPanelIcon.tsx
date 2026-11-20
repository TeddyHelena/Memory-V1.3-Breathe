/**
 * 侧边栏条目图标（`sidebar.panellist` 的插槽内容）。
 *
 * ## 造型：**描边大脑**（Tabler outline）——⛔ 不是实心版
 * 实测反馈（Teddy 2026-10-10）：实心大脑跟上面两个原生图标（插件/订阅，都是描边）**不像一套**。
 * 规格书 §3.2 也写明侧边栏图标 = Tabler · 描边风格 · 24×24 ⇒ 这里用 `BrainIcon`（描边），
 * 实心版 `BrainMarkIcon` 留给"独立出现"的位置。
 * 记忆入口的矢量图由 Teddy 定稿在 `preview.html`「大脑图标 · 矢量化复现」里，
 * 形状照抄 → `BrainIcon.tsx`。⛔ 我第一版自己画了个球 —— **那是错的替换**，已删；
 * 并立了守卫（`test/c2-panel-guards.test.mjs` ⑨）挡住"再画一个"。
 *
 * ## ⛔ 三条硬约定（来自 UI 诉求书 §三，都是踩出来的）
 *   ① **只出图标内容** —— 按钮本身、选中态背景、label 都由宿主画；
 *   ② **颜色一律 `currentColor`** —— 跟随主题与选中态；⛔ 不自造强调色（品牌色是近黑）；
 *   ③ 尺寸**由宿主给**（`size`），⛔ 不写死宽高 —— 侧边栏折叠/展开、不同 DPI 都靠它。
 */

import { BrainIcon } from './BrainIcon.tsx'

export interface MemoryPanelIconProps {
  /** 宿主给的尺寸（px）；缺省给一个安全值，别依赖它一定传 */
  size?: number
  /** 是否处于选中态（宿主给；大脑是单色矢量，选中态背景由宿主画，这里只透传） */
  active?: boolean
}

export function MemoryPanelIcon({ size = 18 }: MemoryPanelIconProps) {
  return <BrainIcon size={size} title='记忆' />
}
