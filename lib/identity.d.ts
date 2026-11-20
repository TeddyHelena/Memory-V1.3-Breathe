/**
 * 身份档案（H2）—— 「认识一下」十步里填的那点东西的**落点**
 *
 * ## 为什么放容器里（`<containerRoot>/identity/profile.json`）
 * `voice.md` 就住在**容器根**（已核实）。身份和声音是同一类东西：
 *   · 换机器要能跟着走 ⇒ 跟容器走，别散在插件目录或浏览器里；
 *   · 重装/换容器 ⇒ 一起没，正是我们要的语义；
 *   · ⛔ **不许**放 localStorage（沙箱 iframe 里直接抛异常，需求 §5.3 已定死）。
 *
 * ## 三条纪律
 *   ① **原子写**（tmp + rename）—— 写一半被 kill 不许留半截 JSON；
 *   ② **字段在白名单里**（`IDENTITY_FIELDS`）—— 与条目契约同源的做法：
 *      ⛔ 不许"谁来都能塞个字段"，否则又是"两处要同步"的老病；
 *   ③ **读不到不抛错**：返回空档案（UI 显示占位），⛔ 不许因为一个档案把面板搞白。
 */
/**
 * 允许的身份字段（白名单）——**它同时是契约**：
 *   · 写入时白名单外的键**直接丢弃并留痕**（不静默接受）；
 *   · 新增字段要改这里（一处），⛔ 不许各处自己塞。
 */
export declare const IDENTITY_FIELDS: readonly ["name", "callName", "notCallName", "gender", "relation", "avatar", "role", "tone", "traits", "thinking", "teamwork1", "teamwork2", "teamwork3", "redlines", "axisIE", "axisNS", "axisTF", "axisJP", "selfGrow"];
export type IdentityField = (typeof IDENTITY_FIELDS)[number];
export interface IdentityProfile {
    schema: string;
    /** 只会有白名单里的键 */
    fields: Partial<Record<IdentityField, unknown>>;
    updatedAt: string | null;
    /** 被丢弃的键（留痕：⛔ 不许静默丢） */
    droppedKeys: string[];
}
/** 读档案。**永不抛错**：读不到/解析不了 ⇒ 返回空档案（UI 显示占位）。 */
export declare function readIdentity(root: string): IdentityProfile;
/** 写档案（原子）。白名单外的键**丢弃并留痕**，返回值里能看见丢了哪些。 */
export declare function writeIdentity(root: string, patch: Record<string, unknown>, at?: Date): IdentityProfile;
