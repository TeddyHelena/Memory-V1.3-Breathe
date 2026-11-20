/**
 * 「认识一下」的状态（H1）—— 首启判定的**唯一真源**
 *
 * ## 为什么是"比版本号"不是布尔
 * 布尔分不出"重装"和"更新"，而过场白要**两者都再弹一次**。
 * 版本号直接用**产品版本**（`product.productVersion`，如 `MemoryV1.3-A.1`）——
 * 它本来就是"每批变更就动"的号，语义正好，⛔ 别再定义第二个。
 *
 * ## ⚠️ 四种情形必须分开（这是白屏事故的根因所在）
 * 需求原文 §5.5 写的是「**读不到 ⇒ 当作不需要弹**」。那条纪律的本意是**防止白屏**，
 * 但它把两件事说成了一件 —— 我在这里拆开：
 *
 * | 情形 | 判定 | 为什么 |
 * |---|---|---|
 * | **文件不存在** | `needed: true` | 这才是**真·首次安装**；按"读不到就不弹"处理的话，**向导永远不会出现** |
 * | **文件存在、版本不同** | `needed: true` | 更新/重装要再走一遍 |
 * | **文件存在、版本相同** | `needed: false` | 正常路径 |
 * | **文件在但读不动/解析不了** | `needed: false` + `reason` 留痕 | ⛔ 这才是那条硬纪律管的情形：**宁可少弹一次，也不许白屏** |
 *
 * ⛔ 后两种都**不许抛错给调用方**：UI 层拿不到明确答案时，只能选"不弹"。
 */
export interface OnboardingState {
    /** 该不该弹「认识一下」 */
    needed: boolean;
    /** 上次走过的版本（没有则 null） */
    version: string | null;
    /** 上次走过的时刻（ISO，没有则 null） */
    onboardedAt: string | null;
    /** 判定依据（可读出口：⛔ 不许让"为什么弹/不弹"无从查起） */
    reason: 'first-install' | 'version-changed' | 'same-version' | 'unreadable' | 'no-version';
}
/**
 * 读状态。**永不抛错** —— 读不动就返回"不弹"（白屏纪律）。
 * `currentVersion` 为空字符串时按"没有可比版本"处理（返回 `no-version`，不弹）。
 */
export declare function onboardingState(root: string, currentVersion: string): OnboardingState;
/**
 * 记下"走过了这一版"。**原子写**（tmp + rename）：写一半被 kill 不许留下半截 JSON。
 * 返回写入后的状态读数。
 */
export declare function markOnboarded(root: string, currentVersion: string, at?: Date): OnboardingState;
