/**
 * ingest.ts —— V1.2 写入管道（契约清单 §五 / TechDesign §6.1）
 *
 * ── 这一层存在的唯一理由 ──────────────────────────────────────────
 * 衰减引擎（V1.3）读取 `last_accessed` 与 `decay_type`。若写入路径不落这两个字段，
 * **每一条新记忆都是「没有 last_accessed 的野生条目」**——存量回填的问题会在每条新
 * 数据上重演一遍。所以打标与初始化必须在**写入那一刻**发生，而不是等 V1.3 补。
 *
 * ── 模块边界（刻意的） ────────────────────────────────────────────
 * 本模块**只做纯函数**：不读盘、不写盘、不碰容器。调用方（writer.ts）拿到结果后
 * 自己组装 frontmatter 并落盘。这样做的收益：① 单测不需要容器 fixture；
 * ② 不引入 writer → ingest → container → writer 的循环依赖；
 * ③ 「打标规则」成为可独立审计的一段逻辑，而不是散在写事务里。
 *
 * ── 与既有字段的关系 ──────────────────────────────────────────────
 * `decay_type`（core/recent/process）与 `memory_type`（experience/world/opinion）
 * **正交**，两者并存、互不覆盖。见 types.ts 的命名说明。
 */
import { createHash } from 'node:crypto';
import { sameScope } from './policy.js';
/** ingest 抛出的错误：写入方据此区分「参数问题」与「系统问题」 */
export class IngestError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'IngestError';
        this.code = code;
    }
}
const VALID_DECAY = ['core', 'recent', 'process'];
function isDecayType(value) {
    return typeof value === 'string' && VALID_DECAY.includes(value);
}
/**
 * 衰减类型打标。
 *
 * **规则（V1.2 契约 §五）**：
 * - `propose`（候选区，未经人工确认）→ `process`：幂律快衰，符合「可能是噪声」的定位
 * - `update` 且旧版本有 decay_type → **继承**（纠正不该改变一条记忆的衰减性质）
 * - 其余（remember）→ `recent`；`core` **只能显式指定**，不自动晋升
 *
 * **为什么不自动判 core**：core 语义是「几乎不衰」，自动判定等于让引擎自己决定
 * 什么记忆永不遗忘——那需要真实使用数据支撑，V1.2 没有。宁可保守：默认 recent，
 * 由调用方显式抬升（或 V1.3 的 lifecycle 依据 access_count 晋升）。
 *
 * 显式值非法 → 抛错拒绝写入（对齐 frontmatter 门禁：不猜、不修正）。
 */
export function classifyDecayType(input) {
    if (input.operation === 'relocate' || input.operation === 'confirm' || input.operation === 'discard') {
        throw new IngestError('MEM_TYPE_INVALID', `非内容类操作不该重分类衰减类型: ${input.operation}（它不改正文，只换存放层/状态）`);
    }
    if (input.explicit !== undefined && input.explicit !== '') {
        if (!isDecayType(input.explicit)) {
            throw new IngestError('MEM_TYPE_INVALID', `decay_type 非法: ${String(input.explicit)}（可选 core | recent | process）`);
        }
        return input.explicit;
    }
    if (input.operation === 'update' && input.inherited)
        return input.inherited;
    if (input.operation === 'propose')
        return 'process';
    // ⛔ **默认值暂时维持 recent**（Teddy 已拍要改 process，但改下去会让 3 条测试红 —— 见下）。
    // 阻塞原因（真耦合，不是测试写错）：判重键 `dupTitleKey(标题, decay_type)` **把 decay_type 算进去了**
    //   ⇒ 改默认 = 改判重行为（同一标题的两条可能从"判重"变成"不判重"）。
    // 这是**静默行为变更**，必须先想清楚再改；已记入 `docs/RELEASE-BLOCKERS.md` 的 B10。
    // 备好的改法：把这里换成 `return 'process'`，并按新口径更新 test/writer-ingest-wiring + backfill-decay。
    // 【Teddy 2026-10-10 拍】默认 **process（快衰）**：
    // "我们的其实大部分的信息其实都属于是快衰信息，最起码是要进入到这个里面的"。
    // ✅ 前置已就位：① `fresh.ts` 的 HALF_LIFE_BY_DECAY 让类型**真的**影响衰减速度；
    //                ② 判重键已改成**只看标题** ⇒ 改默认**不再**偷偷改判重行为（这是先前撤回的原因）。
    return 'process';
}
/**
 * 新条目的衰减字段初值。
 *
 * `last_accessed` 取**写入时刻**（不是零值）：新鲜度的语义是「最近一次被唤起」，
 * 而写下这条记忆本身就是一次唤起。置零会让新条目一出生就被判为陈旧。
 */
export function initDecayFields(decayType, nowIso) {
    return { decay_type: decayType, last_accessed: nowIso, access_count: 0, lifecycle: 'active' };
}
/**
 * 唤起重置（decay.touch 的纯函数内核）。
 *
 * V1.2 只承诺两件事：`last_accessed` 有地方落、`access_count` 能涨。
 * **不承诺曲线**——t 的计算、λ 的取值、ε 地板全部是 V1.3 的事（契约 §二）。
 */
export function touchFields(fm, nowIso) {
    const prev = Number.isFinite(Number(fm.access_count)) ? Number(fm.access_count) : 0;
    return { last_accessed: nowIso, access_count: prev + 1 };
}
/**
 * 内容指纹：用于"撞内容"判重。
 *
 * 归一化：**先把数值整段护住** → 去所有空白 + 去常见中英标点 + 大小写折叠 → 还原数值。
 * 归一化后的哈希，只支持**精确**判重。
 *
 * 【S2 · P1-6 修复】为什么必须护住数值：
 *   原实现的删除集里含 `-` 与 `.`，于是 `余额为 -5000 元` 与 `余额为 5000 元`
 *   归一化后**逐字相同** → 判重误命中 → 后一条被"吸收"（不新建、只加 `access_count`）
 *   —— **一条相反的事实被吞掉**，且不可逆。同理 `利率 1.5` 与 `利率 15` 撞车。
 *   修法取**最小改动**：删除集一个字符都不动，只把"数值"先抽成占位符、归一化末尾再还原
 *   ⇒ 除数值相关的撞车外，**判重行为与修复前逐字一致**（钉子：仅标点差异那条必须仍然命中）。
 *
 * 数值口径：允许正负号 / 千分位 / 小数点；**千分位归一**（`1,000` ＝ `1000` 属同一数值）。
 * 已知取舍：日期式 `2026-10-08` 会被切成三个数值（`2026` / `-10` / `-08`）⇒
 *   `2026-10-08` 与 `20261008` 不再撞车。方向是**少合并**（保守侧），刻意认下。
 */
export function contentFingerprint(text) {
    const src = String(text ?? '').replace(/\u0000/g, ''); // 防占位符被外部伪造
    const nums = [];
    const guarded = src.replace(/[-+]?\d[\d,]*(?:\.\d+)?/g, (m) => {
        nums.push(m.replace(/,/g, ''));
        return `\u0000${nums.length - 1}\u0000`;
    });
    const norm = guarded
        .replace(/\s+/g, '')
        .replace(/[。，、；：！？…—～·「」『』（）《》【】"'`.,;:!?()<>[\]{}|\/\\-]/g, '')
        .toLowerCase()
        .replace(/\u0000(\d+)\u0000/g, (_, i) => `\u0000${nums[Number(i)]}\u0000`);
    return createHash('sha256').update(norm, 'utf-8').digest('hex').slice(0, 32);
}
export function findDuplicate(incoming, existing, 
/** 本次写入自己的作用域；缺省 global（与 `writer.buildRecord` 的缺省一致） */
selfScope = { scope: 'global' }) {
    const fp = contentFingerprint(incoming.content);
    const title = String(incoming.title ?? '').trim();
    // 一趟扫完：同 scope 命中即刻返回；跨 scope 命中的只记第一条，留作提示
    let otherScope = null;
    for (const e of existing) {
        if (!e.content || (e.fp ?? contentFingerprint(e.content)) !== fp)
            continue;
        if (sameScope(e, selfScope))
            return { hit: e, via: 'content' };
        if (!otherScope)
            otherScope = e;
    }
    if (otherScope)
        return { hit: otherScope, via: 'content_other_scope' };
    // 标题撞车只在**同 scope** 内提示：不同项目重名是常态（"每周复盘"），提示了全是噪音
    if (title) {
        for (const e of existing) {
            if (!sameScope(e, selfScope))
                continue;
            if (String(e.title ?? '').trim() === title && e.decay_type === incoming.decayType) {
                return { hit: e, via: 'title' };
            }
        }
    }
    return null;
}
/**
 * 【L3-A1 · 2026-10-15 · Teddy 拍**删**】`pickPool` 已删（原 14 行，见下）。
 *
 * 删的三条依据（齐了才敢删）：
 *   ① **零引用** —— 全仓只有它自己 + 死导出白名单（连测试都没用）
 *   ② **白名单自述的承诺到期** —— 原文：*"落池判定需要 `hotCap`，而该参数**没有任何标定来源**；
 *      V1.2 不引入拍脑袋的容量阈值去决定「文件落在哪一层」。**留待 V1.3 标定后接入，或届时删除**"*
 *      ⇒ **V1.3 已发布且过门禁** ⇒ 承诺到期
 *   ③ **活的落层不需要它** —— 新条目一律 `layer: 'longterm'`（`writer.ts` 硬编码），
 *      hot 层由**人工策展**维护（`hot_order`），层间移动走**显式** `writer.relocate(id, targetLayer)`
 *
 * ⇒ ⭐ **落层没有"判定"，是「硬编码 longterm + 人工策展 hot + 显式 relocate」** ——
 *   这就是 L0 全程图上**红项 ②**（"`pickPool` 零引用 ⇒ 层的归属不明"）的答案。
 * ⇒ ⛔ 若将来要做"自动落池"，**先标定 `hotCap` 的来源**（容量上限从哪来），⛔ 不许拍脑袋。
 */
