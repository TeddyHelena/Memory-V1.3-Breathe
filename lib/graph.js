/**
 * memory-container 关系图谱数据构建（知识球 / 平面图的统一数据源）
 *
 * 钩稽关系（耦合）从容器现有索引结构派生，不读条目文件：
 *   - tag 边：两个条目共享 ≥2 个标签才连线（强钩稽；共享 1 个是弱关联，
 *     全连会变成 100+ 条的噪声网——视觉糊且力导向无法收敛）。
 *     实现为「按标签对求共同成员交集」，代价 = 输出规模（v1.1 增量①）
 *   - group 边：archive_index / longterm_tags 分组内的条目互为钩稽
 *   - hot 边：hot_order 相邻条目成链
 *   - source 边：index.json 里没有 source 字段（source 在条目文件 frontmatter），
 *     所以不在这里提供——保持纯索引派生，零文件 IO
 *
 * 去重策略：节点对之间只保留一条边，多类型取优先级最高者
 * （hot > group > tag），避免同一对节点重复连线。
 */
import { freshForEntry } from './route/fresh.js';
/** 边类型优先级：数值越小越优先保留 */
const TYPE_RANK = { hot: 0, group: 1, tag: 2 };
/** 强关联阈值：共享标签数 ≥ 此值才连 tag 边 */
const STRONG_TAG_SHARED = 2;
/**
 * ── 规模兜底（2026-09-20 · v1.1 增量① 修订）─────────────────────
 *
 * 旧版把「性能截断」与「防爆」混在一起：单标签超 5000 对即跳过展开，
 * 代价是**丢边**（图上少一片钩稽，只在 limited 里留一行字）——验收不接受这个。
 *
 * 修订后的分工：
 *   - **tag 边**：算法换成「按标签对求共同成员交集」（见下方实现），代价降到
 *     输出规模。**不再按标签截断 —— 硬承诺不丢边**。
 *   - **group 边**：clique 展开的输出本身是 O(k²) 条边，这是**输出规模**问题，
 *     不是算法问题（交集/哈希都消不掉）。保留成员数兜底，超限跳过并如实上报。
 *   - **总边数防爆上限**：越过即停止展开（tag 边在 group 之后处理，故优先保留
 *     group 的真实输出……实际上先处理 group，见实现顺序），如实上报。
 *     这是防 OOM 的硬闸，不是性能妥协。
 */
const MAX_GROUP_MEMBERS = 1000;
/**
 * 总边数防爆上限（2026-09-20 收尾轮：**20 万 → 5 万**）。
 *
 * 依据是实测（密集块 700 条共享 (a,b)，见 `V1.1压测报告_20260920.md`）：
 *   20 万边 → 构建 +56.2MB / 序列化后 **+121.0MB** RSS、JSON **9.0MB**
 *    5 万边 → 构建 +14.0MB / 序列化后 **+30.3MB** RSS、JSON **2.3MB**
 * 对通常 ~250MB 的个人记忆插件，前者接近翻倍，后者是可接受的量级。
 *
 * 5 万仍远超真实使用：真实容器（68 条）只有 58 条边；5 万边约等于 300 个条目两两互连。
 * 触顶照旧写进 `limited` 如实上报 —— **上限不等于静默截断**。
 *
 * 已知未尽：5 万边时 JSON 仍有 2.3MB，对设置页不算友好。彻底解决要做**响应体积上限或分页**，
 * 需要前端配合（方向 B），不在本轮范围，如实标注。
 */
const MAX_TOTAL_LINKS = 50_000;
/** 构建图谱数据（纯派生，无文件 IO，可重复调用） */
export function buildMemoryGraph(container) {
    const index = container.getIndex();
    /**
     * 候选层（pending）不进图：关系图只画**已确认记忆**。
     *
     * 理由：候选是未经人工确认的推断，混进关系网会让「A 和 B 有关」看着像既成事实；
     * 候选有它自己的出口——设置页列表置顶 + 转正按钮（膨胀控制的前置）。
     * 2026-09-15 拍板：当天候选层塞进图里，client 侧层表没跟上，设置页整块白屏。
     * 节点与 nodeIds 同源过滤——只滤节点会让候选牵出悬挂边。
     */
    const graphEntries = index.entries.filter((e) => e.layer !== 'pending');
    const nodes = graphEntries.map((e) => ({
        // 【B3b】带 fresh ⇒ 球上才能画"半透明 陈旧"（与 `/list` 用**同一处** `freshForEntry`，⛔ 不许两份）
        fresh: freshForEntry(e.last_accessed, e.decay_type),
        id: e.id,
        layer: e.layer,
        status: e.status, // 见 GraphNode.status 的注释
        title: e.title,
        tags: e.tags,
        priority: e.priority,
        updated: e.updated,
        summary: e.summary,
    }));
    const nodeIds = new Set(graphEntries.map((e) => e.id));
    // 边集合：key = `${minId}->${maxId}`（无向）
    const linkMap = new Map();
    const addLink = (a, b, type) => {
        if (a === b)
            return;
        if (!nodeIds.has(a) || !nodeIds.has(b))
            return;
        const key = a < b ? `${a}->${b}` : `${b}->${a}`;
        const existing = linkMap.get(key);
        if (!existing || TYPE_RANK[type] < TYPE_RANK[existing.type]) {
            linkMap.set(key, { source: a < b ? a : b, target: a < b ? b : a, type });
        }
    };
    // ── hot 边：hot_order 相邻成链 ──
    const hotOrder = index.hot_order;
    for (let i = 0; i < hotOrder.length - 1; i++) {
        addLink(hotOrder[i], hotOrder[i + 1], 'hot');
    }
    // ── group 边：分组索引内的条目两两相连（带上限，见 MAX_GROUP_MEMBERS）──
    const limitedGroups = [];
    const groups = {
        ...(index.archive_index ?? {}),
        ...(index.longterm_tags ?? {}),
    };
    for (const [groupName, allMembers] of Object.entries(groups)) {
        if (allMembers.length > MAX_GROUP_MEMBERS) {
            limitedGroups.push(`${groupName}(${allMembers.length})`);
            continue;
        }
        const members = allMembers;
        for (let i = 0; i < members.length; i++) {
            for (let j = i + 1; j < members.length; j++) {
                addLink(members[i], members[j], 'group');
            }
        }
    }
    // ── tag 边：共享 ≥2 个标签的条目相连（强钩稽）──
    //
    // 算法（v1.1 增量①）：**按「标签对」求共同成员交集**，而不是「按标签枚举全部成员对」。
    //
    // 等价性（不丢边的依据）：A、B 共享 ≥2 个标签 ⟺ 存在某个标签对 (t1,t2) 使得
    // A、B 同属 `M(t1) ∩ M(t2)`。所以枚举「条目上出现过的所有标签对」的交集，
    // 能且只能得到全部合格的对 —— 不漏、不多。
    //
    // 为什么快：旧实现枚举 Σ_t C(k_t, 2)（k_t = 标签 t 的成员数），其中**绝大多数对
    // 只共享 1 个标签、最终被 `shared ≥ 2` 过滤掉**——纯浪费；实测 1000 条共享同一标签
    // 时要白枚举 50 万对（542ms）。
    // 新实现的代价 = Σ_标签对 C(|M(t1)∩M(t2)|, 2) ≈ **输出边数**（每对至少连一条边），
    // 已到最优：稠密数据下输出本身就那么大，任何算法都躲不掉（输出敏感的 clique）。
    const tagMembers = new Map();
    for (const entry of graphEntries) {
        for (const tag of new Set(entry.tags)) {
            let members = tagMembers.get(tag);
            if (!members) {
                members = new Set();
                tagMembers.set(tag, members);
            }
            members.add(entry.id);
        }
    }
    // 条目上出现过的标签对（去重：同一标签对只算一次交集）
    const tagPairs = new Set();
    for (const entry of graphEntries) {
        const tags = [...new Set(entry.tags)];
        if (tags.length < 2)
            continue;
        for (let i = 0; i < tags.length; i++) {
            for (let j = i + 1; j < tags.length; j++) {
                const t1 = tags[i];
                const t2 = tags[j];
                tagPairs.add(t1 < t2 ? `${t1}\u0000${t2}` : `${t2}\u0000${t1}`);
            }
        }
    }
    const limitedTags = [];
    const seenTagPairs = new Set();
    outer: for (const pairKey of tagPairs) {
        if (linkMap.size >= MAX_TOTAL_LINKS) {
            limitedTags.push(`tag边展开在防爆上限 ${MAX_TOTAL_LINKS} 处停止（剩余标签对未展开）`);
            break;
        }
        const sep = pairKey.indexOf('\u0000');
        const left = tagMembers.get(pairKey.slice(0, sep));
        const right = tagMembers.get(pairKey.slice(sep + 1));
        if (!left || !right)
            continue;
        // 交集：遍历小集合、在大集合里查 —— O(min(|left|, |right|))
        const [small, big] = left.size <= right.size ? [left, right] : [right, left];
        const shared = [];
        for (const id of small)
            if (big.has(id))
                shared.push(id);
        if (shared.length < STRONG_TAG_SHARED)
            continue;
        for (let i = 0; i < shared.length; i++) {
            for (let j = i + 1; j < shared.length; j++) {
                const a = shared[i];
                const b = shared[j];
                const key = a < b ? `${a}->${b}` : `${b}->${a}`;
                if (seenTagPairs.has(key))
                    continue; // 同一对可能被多个标签对捕获
                seenTagPairs.add(key);
                addLink(a, b, 'tag');
                // 上限必须在**内层**也查：单个稠密标签对即可一次产出几十万条边，
                // 只在外层查会冲穿上限（实测 700 条共享 (a,b) → 244,650 条边）。
                if (linkMap.size >= MAX_TOTAL_LINKS) {
                    limitedTags.push(`tag边展开在防爆上限 ${MAX_TOTAL_LINKS} 处停止（剩余标签对未展开）`);
                    break outer;
                }
            }
        }
    }
    const limited = [...limitedGroups, ...limitedTags];
    return {
        nodes,
        links: [...linkMap.values()],
        hot_order: hotOrder,
        // 同组/同标签关系**只保留相邻链**，不展开全连接。
        // 语义上仍是"钩稽"，但边数从 O(k²) 降到 O(k)；被取舍掉的是"所有对都连"的完备性。
        // **不静默**：哪个源被限制、原本多少成员，原样带出去供 UI/日志呈现。
        ...(limited.length > 0 ? { limited } : {}),
    };
}
