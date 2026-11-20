/**
 * 「认识一下」向导（`#ob-view`）—— 第 3 轮
 *
 * ## 两卡布局（原型截图 02/03）
 * ```
 * [左卡 预览]  它正在变成什么样 · 头像(可跳过) · 名字 · 关系 · 一句话底线 · 说明两行
 * [右卡 问题]  10 段进度条 ·「第 N 步 / 共 10 步 · <标题>」· 大标题 + 副标题 · 问题组
 *              底部：上一步 ·「两处必填 · 一处可空」· 下一步（未填则禁用）
 * ```
 * 背景有渐变光斑（blobs），卡片浮在其上。
 *
 * ## ⚠️ 内容来源与"待补"（⛔ 不编）
 * 步骤标题/副标题摘自原型 HTML（`s1`–`s10`）；
 * 选项从原型 **JS 里抽出来的只有一部分**（s6 共事 6 项、s7 底线 5 项、s8 四轴 8 项）。
 * **s2 位置 / s4 性子 / s5 认知 三组选项我在 JS 里还没抽全** ⇒ 这里如实标 `待补`，
 * ⛔ 绝不自己编一套题目（编出来的东西会看起来"完成度很高"，那是糊弄）。
 *
 * ## 交互的两个硬约束（原型 §1.3 + 作者 的裁决）
 *   ① **面板内覆盖层，⛔ 不做成"必须先过的启动页"**（作者：直接进 Agent 页就行）；
 *   ② 首启判定走 `/onboarding`（**读不到 ⇒ 不弹**，⛔ 不白屏）。
 */
import { type ReactNode } from 'react';
export interface OnboardingWizardProps {
    /** 走完/跳过后的回调（外面据此重载并提供"记下版本"） */
    onDone: (patch: Record<string, unknown>) => void;
    onSkip: () => void;
    /** 已存身份档案（预览回落用；可空） */
    identity?: Record<string, unknown>;
    /** 当前产品版本（写进 `.onboarded` 的那个号） */
    version: string;
}
export declare function OnboardingWizard({ onDone, onSkip, identity }: OnboardingWizardProps): ReactNode;
