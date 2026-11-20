/**
 * 「唤醒」转场的**视觉层**（节奏在 `src/wake.ts`，特效数学在 `src/wake-fx.ts`，两者都是纯逻辑、有测试）。
 *
 * 规格：`docs/wake-transition-spec.md`。这一层只负责**画**，不负责**何时**。
 * ⛔ 时长一律走 CSS 变量 / 内联 ms（值来自 `TL`），⛔ 不在这里写死秒数。
 *
 * ## 特效层（2026-10-14 补）
 * 修前 `flight` 只是"轻微上浮 + 放大"的 **CSS 近似**，**没有画布**
 * （截图证据：四个 phase 全 `hasCanvas=false`）。现在按 spec 补齐：
 * - `handoff`：**画布从 DOM 手里接过这个字** —— 量出 DOM 字形的 rect 与字体，按同样参数画到画布上，
 *   再把 DOM 那层隐掉（⛔ 顺序不能反：先量后隐，否则量到的是 0×0）
 * - `flight`：字形炸成药粒子，按 `wake-fx` 标定出的弹簧飞向落点（`WAKE_LANDING`）
 * - `settle`：落定后按 `settleBump` **晃一下**
 *
 * ## 两条硬约束
 * ① **节奏层不挂 rAF**（spec §二 第 1 条）—— rAF **只在本文件**（特效层），且与节奏解耦：
 *    节奏由 `runWake` 的 setTimeout 决定，这里只负责"当前相位把画面画成什么样"。
 * ② **异常路径走同一个 cleanup**（spec §五 第 6 点）⇒ 本文件只有**一个** `cleanup()`，
 *    skip / 相位结束 / 组件卸载 / 出错**全走它**，⛔ 不许两套清理逻辑。
 */
import { type ReactNode } from 'react';
export type WakePhase = 'solid' | 'handoff' | 'flight' | 'settle' | 'slide';
export interface WakeOverlayProps {
    phase: WakePhase;
    /** 点一下 = 跳过（规格第 7 点：监听由调用方**延后一拍**挂，避免把"开始"那次点击当成跳过）*/
    onSkip: () => void;
    /**
     * **调参口（可选）**：只给开发页/对照表用，⛔ 生产调用方不传 ⇒ 走下面的常量，行为一字不变。
     * 存在的原因：`spread` / 粒子数这类是**审美参数**，光靠描述定不了，得摆出来给人挑。
     */
    fx?: {
        spread?: number;
        particles?: number;
    };
}
export declare function WakeOverlay({ phase, onSkip, fx }: WakeOverlayProps): ReactNode;
