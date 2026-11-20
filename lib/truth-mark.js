/**
 * truth-mark.ts —— 按 id 取档时的**真值标记**（2026-10-08 · post-Scoped 增量）
 *
 * 为什么必须有它：`memory_load` 是库里最常见的指路方式（"版本口径见 l67"），
 * 而 `update` 走版本化 —— 旧版被标 `superseded` 后**仍然可以按 id 取到**。
 * 修复前渲染只打「id + 标题 + 正文」，于是**过期条目读起来跟现行的一模一样**：
 * 实测 `memory_load l67` 会原样吐出"现役是 MemoryV1.2-Sealed"，一个字都不提它已被 l68 取代。
 * 那不是编造，是**"过期但可信"** —— 比编造更难防，因为读起来比编造更像真的。
 *
 * 判据（只标记、不拦截）：
 *   · 非 active 时在**正文之前**打一行状态，让人先看见状态再读内容；
 *   · ⛔ 不隐藏内容（审计要能读旧版）；⛔ 不改检索排序（检索本来就过滤 superseded）。
 */
export function truthMark(value) {
    const st = value.temporal_state;
    if (!st || st === 'active' || st === 'vault')
        return '';
    const by = value.superseded_by ? `（已被 \`${value.superseded_by}\` 取代）` : '';
    const tail = value.superseded_by
        ? `——⛔ 不是现行结论；引用前先读 \`${value.superseded_by}\``
        : '——⛔ 不是现行结论，引用前请先确认它有没有后继版本';
    return `\n⚠️ **本条状态：${st}**${by}${tail}`;
}
