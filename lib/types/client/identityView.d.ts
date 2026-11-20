/**
 * 身份「看板 / 选图」的纯函数层（可在 Node 里按行为验，不依赖 React）。
 *
 * 现状（本轮开工前的真实行为）：
 *   · 向导里没有头像入口 ⇒ `avatarPatchFromDataUrl` 这个能力**不存在**，桩返回 null；
 *   · 预览卡只认本次答案 `ans`，**不回落**到已存档案。
 * 判据先红，再由实现转绿。
 */
/** 选图结果 → 落库补丁（空 = 未选/不合格，调用方不应写库）。 */
export declare function avatarPatchFromDataUrl(dataUrl: string): {
    avatar: string;
} | null;
/** 预览卡的「名字 / 头像」取值。【桩：当前只认 ans】 */
export declare function resolveIdentityPreview(ans: Record<string, unknown> | undefined, identity: Record<string, unknown> | undefined): {
    name?: string;
    avatar?: string;
};
