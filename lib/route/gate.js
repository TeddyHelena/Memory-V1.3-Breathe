/**
 * gate.ts —— V1.2 硬门禁（契约清单 §五）
 *
 * ── 校验对象只有一层：联想涌现 ────────────────────────────────────
 * identity_card 与 directed 命中**信任召回**：
 *   - 身份卡是"先验常识"（这人是谁），不参与相关性裁判
 *   - directed 已经过 BM25 相关性筛选，再用关键词相似度复核一遍没有增量信息
 * 只有 emergent 是"引擎自己联想的"——它没有 query 相关性背书，必须过审。
 *
 * ── 两种阈值的分工（曾经混在一起，现在拆开写死）──────────────────
 *   - **硬门禁用绝对阈值**：关键词相似度是一个明确可比的分（0~1），
 *     用绝对线判定"过/不过"语义清晰。
 *   - **分级门禁（gate_in）用相对分位数**：打到分排序层用候选集内部的分位数
 *     切"进 main / 进候选区"。
 * 混用的后果是「阈值随候选集浮动」——同一 query 多召回两条就换了门槛。
 *
 * ── 未过线不等于丢弃 ──────────────────────────────────────────────
 * 未过线 → `gatePass = false` + 进候选区（降权 0.4）。
 * **但降权只在 score_cand 上，不影响 score_in**——所以"禁入 main"这件事
 * 必须由 budget.allocate 显式判 `gatePass`，不能指望降权把分数压下去。
 * TechDesign 初稿正是只做了降权（`score_cand *= 0.4`），而 allocate 按
 * `score_in` 排序——未过线的条目照样能进 main。
 */
import { tokenizeLoose } from './recall.js';
/** 关键词相似度：两边 token 集合的 Jaccard 系数（0~1，本地零依赖） */
function keywordSimilarity(a, b) {
    const setA = tokenizeLoose(a);
    const setB = tokenizeLoose(b);
    if (setA.size === 0 || setB.size === 0)
        return 0;
    let inter = 0;
    for (const t of setA)
        if (setB.has(t))
            inter += 1;
    const union = setA.size + setB.size - inter;
    return union === 0 ? 0 : inter / union;
}
/**
 * 规则白名单：这几类条目**跳过关键词校验**直接放行。
 *
 * 为什么需要：身份/约定/偏好类条目天然不携带 query 关键词——用户的偏好
 * "不用敬语、短句直给"在任何 query 下相似度都接近 0，但它恰恰是最该被想起的。
 * 拿关键词阈值去卡它，等于系统性地过滤掉最重要的那类记忆。
 */
const WHITELIST_TITLE_PATTERNS = [/^助手/, /纪律/, /偏好/, /约定/, /规则/, /底线/];
function isWhitelisted(entry) {
    const title = entry.title ?? '';
    if (WHITELIST_TITLE_PATTERNS.some((re) => re.test(title)))
        return true;
    return (entry.tags ?? []).some((t) => t === 'identity' || t === 'rule' || t === 'preference');
}
/** 未过线降权系数（契约 §3.4） */
const GATE_PENALTY = 0.4;
export function validate(entries, query, config) {
    let passed = 0;
    let failed = 0;
    const out = [];
    for (const s of entries) {
        const trust = s.origin !== 'emergent' || isWhitelisted(s.meta);
        if (trust) {
            s.gatePass = true;
            passed += 1;
            out.push(s);
            continue;
        }
        const sim = keywordSimilarity(`${s.meta.summary ?? ''} ${(s.meta.tags ?? []).join(' ')}`, query);
        if (sim >= config.gate_threshold_abs) {
            s.gatePass = true;
            passed += 1;
        }
        else {
            s.gatePass = false;
            // 降权只影响候选分：main 的闸门由 allocate 显式判 gatePass，不靠分数
            s.score_cand *= GATE_PENALTY;
            failed += 1;
        }
        out.push(s);
    }
    return { entries: out, passed, failed };
}
