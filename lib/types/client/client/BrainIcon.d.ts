/**
 * 「大脑」图标 —— **两个变体，用途不同，⛔ 别混用**
 *
 * ## 为什么是两个
 * Teddy 2026-10-10 实测反馈：侧边栏那个记忆图标"和上面两个（插件/订阅）好像有一个微小的差别，
 * 不像原生的"。原因：`preview.html` 那份大脑是**实心填充**（`fill` + `fill-rule="nonzero"`），
 * 而宿主侧边栏原生图标是**描边风格**（Tabler outline，细线）⇒ 实心那条显得又粗又重。
 *
 * UI 规格书 §3.2 自己写着：侧边栏条目图标 = **Tabler Icons（MIT）· 描边风格 · 24×24 viewBox** ✓
 * 所以：
 *
 * | 变体 | 造型 | 用在哪 |
 * |---|---|---|
 * | **`BrainIcon`（描边）** | Tabler `brain` outline（MIT，24×24，`stroke-width:2`，圆头圆角） | **侧边栏条目**、任何与宿主图标并排的位置 |
 * | **`BrainMarkIcon`（实心）** | Teddy 的 `preview.html`「大脑图标 · 矢量化复现」定稿（照抄，512×512） | 面板内的身份位/空态等**独立出现**的地方（那时实心更像"标记"） |
 *
 * ⛔ 两条都不许"顺手重画"：描边那条来自 Tabler（MIT），实心那条来自 Teddy 的定稿。
 */
export interface BrainIconProps {
    /** 宿主给的尺寸（px） */
    size?: number;
    /** 无障碍名（默认「记忆」） */
    title?: string;
}
/**
 * **描边版**（Tabler outline · MIT）—— 侧边栏等"和宿主图标并排"的位置用它。
 * 形状逐字来自 `@tabler/icons` 的 `icons/outline/brain.svg`（v3.31.0），⛔ 未作几何改动。
 */
export declare function BrainIcon({ size, title }: BrainIconProps): import("react").JSX.Element;
/**
 * **实心版**（Teddy 定稿）—— 独立出现的位置用它（面板身份位、空态等）。
 * 颜色按定稿文档的说明从 `#A1A0A7` 换成 `currentColor`（"想让它跟随文字颜色…即可"）。
 */
export declare function BrainMarkIcon({ size, title }: BrainIconProps): import("react").JSX.Element;
