/**
 * 本地 BM25 检索：中文 2-gram、英文/数字分词，不依赖联网或向量服务。
 * 标题、标签、摘要和正文使用不同权重，并返回可解释的召回原因。
 */
import { expandQuery } from './lexicon.js';
import { isCurrentMemory, isInScope, memoryScope, temporalState, temporalWeight } from './policy.js';
/**
 * DSH 工具管线使用 lossless JSON 校验工具输出，不允许 undefined 字段。
 * 旧条目没有 scope_id/source 等新字段时，直接放进对象会让整个工具调用失败，
 * 因此构造返回对象时必须剔除缺失字段。
 *
 * 2026-10-06（S1 · P0-1b）：返回类型从 `Partial<T>` 改为 `T`。
 * 原因：`Partial<T>` 会把 `ok: boolean` 这类**必填**字段也变成可选，
 * 于是"包一层收口"反而过不了工具返回的类型检查——类型系统会把收口动作判成错误，
 * 结果就是**没人愿意用它**，四个写工具因此一直没收口。返回 `T` 表示
 * "键还在，只是值为 undefined 的那些键在运行时不存在"——这与声明里的
 * `version?: number` 这类可选字段是自洽的。
 */
export function withoutUndefined(obj) {
    const out = {};
    for (const [key, value] of Object.entries(obj)) {
        if (value !== undefined)
            out[key] = value;
    }
    return out;
}
const STOPWORDS = new Set([
    '的', '了', '和', '与', '在', '是', '我', '你', '他', '她', '它',
    '我们', '你们', '他们', '这个', '那个', '一个', '什么', '怎么', '如何',
]);
/** 导出供基准测试和后续本地向量混排复用。 */
function tokenize(text) {
    const words = [];
    const en = text.match(/[a-zA-Z0-9]+/g);
    if (en)
        words.push(...en.map((word) => word.toLowerCase()));
    const cn = text.replace(/[a-zA-Z0-9_\-\s，。！？、；：“”‘’（）《》【】,.!?;:'"()<>[\]{}|/\\\n\r\t]/g, '');
    for (let i = 0; i < cn.length - 1; i++) {
        const gram = cn.slice(i, i + 2);
        if (!STOPWORDS.has(gram))
            words.push(gram);
    }
    return words;
}
function repeat(tokens, weight) {
    return Array.from({ length: weight }, () => tokens).flat();
}
function buildDocument(meta, frontmatter, content, state, 
/** 缓存命中的词频（来自 container.entryTokenStats）——给了就不再重新分词 */
cachedWeights) {
    const doc = {
        meta,
        frontmatter,
        content,
        state,
        weights: cachedWeights ?? weightedFrequency(tokenize(meta.title), tokenize(meta.tags.join(' ')), tokenize(meta.summary), tokenize(content)),
    };
    // ── fields 惰性求值（2026-09-15 性能修正）───────────────────────
    // 实测：2000 条语料里，buildDocument 给**每一条**算 4 个字段的分词，
    // 而 fields 只被 recallReasons 使用——那是对**返回的 topK 条（≤20）**调用的。
    // 等于 99% 的分词算完就扔。改成 getter：只有真要输出解释时才分词。
    Object.defineProperty(doc, 'fields', {
        enumerable: true,
        configurable: true,
        get() {
            const title = tokenize(meta.title);
            const tags = tokenize(meta.tags.join(' '));
            const summary = tokenize(meta.summary);
            const body = tokenize(content);
            const value = {
                title: new Set(title),
                tags: new Set(tags),
                summary: new Set(summary),
                content: new Set(body),
            };
            Object.defineProperty(doc, 'fields', { value, enumerable: true, configurable: true });
            return value;
        },
    });
    return doc;
}
/** 加权词频：一次性算出「加权词频表」与「加权总长度」。权重规则唯一定义在此。 */
function weightedFrequency(title, tags, summary, body) {
    const freq = new Map();
    const bump = (tokens, weight) => {
        for (const t of tokens)
            freq.set(t, (freq.get(t) ?? 0) + weight);
        return tokens.length * weight;
    };
    const length = bump(title, 4) + bump(tags, 3) + bump(summary, 2) + bump(body, 1);
    return { freq, length };
}
/**
 * 【S2 · S2-D】喂给 `container.entryTokenStats` 的分词回调。
 *
 * 定义在模块级（不是每次调用现造一个闭包）：`entryTokenStats` 的缓存键是 (id, mtime)，
 * 回调本身不参与缓存，但稳定的函数引用能让"这条缓存是给谁的"一目了然。
 */
function TOKEN_COUNT(content, meta) {
    return weightedFrequency(tokenize(meta.title), tokenize(meta.tags.join(' ')), tokenize(meta.summary), tokenize(content));
}
function frequency(tokens) {
    const counts = new Map();
    for (const token of tokens)
        counts.set(token, (counts.get(token) ?? 0) + 1);
    return counts;
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function makeSnippet(content, queryTokens, maxLen = 120) {
    const pattern = queryTokens.map(escapeRegExp).filter(Boolean).join('|');
    const idx = pattern ? content.search(new RegExp(pattern, 'i')) : -1;
    if (idx < 0)
        return content.slice(0, maxLen);
    const start = Math.max(0, idx - 30);
    return (start > 0 ? '…' : '') + content.slice(start, start + maxLen) +
        (start + maxLen < content.length ? '…' : '');
}
function recallReasons(doc, queryTokens) {
    const matches = (tokens) => queryTokens.filter((token) => tokens.has(token));
    const reasons = [];
    const title = matches(doc.fields.title);
    const tags = matches(doc.fields.tags);
    const summary = matches(doc.fields.summary);
    const content = matches(doc.fields.content);
    if (title.length)
        reasons.push(`标题命中：${title.slice(0, 3).join('、')}`);
    if (tags.length)
        reasons.push(`标签命中：${tags.slice(0, 3).join('、')}`);
    if (summary.length)
        reasons.push(`摘要命中：${summary.slice(0, 3).join('、')}`);
    if (content.length)
        reasons.push(`正文命中：${content.slice(0, 3).join('、')}`);
    if (doc.state === 'stale')
        reasons.push('状态为 stale，已降低排序权重');
    if (doc.frontmatter.conflict_state === 'pending')
        reasons.push('存在待处理冲突，已降低排序权重');
    return reasons;
}
/**
 * 检索 longterm，可选 archive。过期、被替代、尚未生效或作用域不匹配的条目不进入候选集。
 */
export function searchLongterm(container, query, opts = {}) {
    const topK = Math.max(1, Math.min(50, Math.floor(opts.topK ?? 5)));
    // ── 语料只构建一次，base 与全部扩展查询共用（v1.1 增量③ 修复）──────────
    // 原实现把「构建文档集 + 统计全量 df」放在**每个查询**里重做一遍，
    // 而同义扩展会把一次检索放大成最多 5 次 → 2000 条端到端实测 219.93ms（验收线 200ms）。
    // 这两件事都与查询无关：文档集只依赖索引与过滤条件，df 只依赖文档集。
    const corpus = buildSearchCorpus(container, opts);
    const base = scoreFromCorpus(corpus, [...new Set(tokenize(query))], query, topK);
    if (opts.enableLexicon === false)
        return base;
    const extras = expandQuery(query, Math.max(0, opts.maxExtraQueries ?? 4));
    if (extras.length === 0)
        return base;
    // 合并：同一条目取最高分；snippet/reasons 取分数更高的那次查询的版本
    const merged = new Map();
    for (const hit of base)
        merged.set(hit.id, hit);
    for (const extra of extras) {
        const tokens = [...new Set(tokenize(extra))];
        if (tokens.length === 0)
            continue;
        for (const hit of scoreFromCorpus(corpus, tokens, extra, topK)) {
            const previous = merged.get(hit.id);
            if (!previous || hit.score > previous.score)
                merged.set(hit.id, hit);
        }
    }
    const out = [...merged.values()];
    out.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
    return out.slice(0, topK);
}
/**
 * 【S2 · S2-D】检索语料缓存。
 *
 * 原实现**每次查询**都把整份倒排重建一遍（实测 @2000 真实长度语料：稳定态检索 p50 **126ms**，
 * 其中绝大部分是重建倒排 + 逐条 buildDocument）。判定实验（`docs/写入路径判定实验_20261008.md`）
 * 已把"整片失效 + 全量重建"这一个形态在**写路径**上钉死；读路径是同一个病根。
 *
 * 失效判据（三条一起进 key，缺一条就会给出陈旧结果）：
 *   ① `container.corpusVersion()` —— 语料内容/索引版本（写一条、外部改动都会让它变）
 *   ② 层过滤 —— 不同 `layerFilter` 不许互相串缓存
 *   ③ **时态签名** —— 逐条 `temporalState`（过期/未生效/被替代的条目本来就不进语料）。
 *      ⛔ 不许拿 `now` 直接当 key：那样每次调用都 miss，等于没缓存；
 *      也不许不算它：那会在条目刚好过期的那一刻返回一条本不该出现的记忆。
 * 代价：每次查询仍要 O(n) 算时态签名（纯内存、无 IO）——相对省下的重建开销是划算的。
 */
const CORPUS_CACHE = new WeakMap();
function searchCorpusKey(container, layers, scopeContext, now) {
    const docs = container.corpus();
    const parts = [container.corpusVersion(), layers.join(',')];
    for (const meta of container.getIndex().entries) {
        if (!layers.includes(meta.layer))
            continue;
        const doc = docs.get(meta.id);
        if (!doc || !isInScope(doc.frontmatter, scopeContext))
            continue;
        parts.push(`${meta.id}:${temporalState(doc.frontmatter, now)}`);
    }
    return parts.join('|');
}
function buildSearchCorpus(container, opts) {
    const layers = opts.layerFilter ?? ['longterm'];
    const key = searchCorpusKey(container, layers, opts.scopeContext, opts.now);
    const hit = CORPUS_CACHE.get(container);
    if (hit && hit.key === key)
        return hit.corpus;
    const built = buildSearchCorpusIncremental(container, opts, hit, key);
    CORPUS_CACHE.set(container, built);
    return built.corpus;
}
/**
 * 真正的构建：**能增量就增量**（写一条之后那次检索，不该付全量重建的钱）。
 *
 * 判据（安全性靠这三条一起守）：
 *   ① 复用条件 = **容器文档对象同一个**（内容没换）**且时态同一个**；
 *   ② 语料集合变化（新增/移除/改层/不再满足 scope）走增删倒排项，不推倒重来；
 *   ③ 拿不准时（没有上一版、或改动面太大）退回全量重建——**正确性优先**。
 * 自测里有一条"增量结果必须与从零重建逐字一致"的等价性判据（`s2-scoped.test.mjs` S2-D③）。
 */
function buildSearchCorpusIncremental(container, opts, prev, key) {
    const layers = opts.layerFilter ?? ['longterm'];
    const docs = container.corpus();
    const parts = new Map();
    const documents = [];
    const stale = []; // 需要从倒排里摘掉的旧文档（内容变了或不再入语料）
    const fresh = []; // 需要加进倒排的文档（新增或内容变了）
    const seen = new Set();
    for (const meta of container.getIndex().entries) {
        if (!layers.includes(meta.layer))
            continue;
        // 用 `corpus()` 而不是 `readEntry()`：前者对没变的条目返回**同一个对象**，这正是复用判据。
        const file = docs.get(meta.id);
        if (!file || !isInScope(file.frontmatter, opts.scopeContext))
            continue;
        const state = temporalState(file.frontmatter, opts.now);
        if (!isCurrentMemory(state))
            continue;
        seen.add(meta.id);
        const old = prev?.parts.get(meta.id);
        if (old && old.src === file && old.state === state) {
            parts.set(meta.id, old);
            documents.push(old.doc);
            continue;
        }
        const cachedWeights = container.entryTokenStats(meta.id, TOKEN_COUNT) ?? undefined;
        const doc = buildDocument(meta, file.frontmatter, file.content, state, cachedWeights);
        parts.set(meta.id, { doc, src: file, state });
        documents.push(doc);
        fresh.push(doc);
        if (old)
            stale.push(old.doc);
    }
    // 上一版里、这一版不再入语料的（被删/改层/过期/出 scope）
    if (prev)
        for (const [id, p] of prev.parts)
            if (!seen.has(id))
                stale.push(p.doc);
    let posting;
    if (prev && prev.corpus.posting.size > 0) {
        posting = new Map(prev.corpus.posting);
        for (const doc of stale) {
            for (const token of doc.weights.freq.keys()) {
                const list = posting.get(token);
                if (!list)
                    continue;
                const next = list.filter((d) => d !== doc);
                if (next.length)
                    posting.set(token, next);
                else
                    posting.delete(token);
            }
        }
        for (const doc of fresh) {
            for (const token of doc.weights.freq.keys()) {
                const list = posting.get(token);
                // ⛔ 别原地 push：桶数组可能与上一版缓存共享（`new Map` 只复制 Map，不复制数组）
                if (list)
                    posting.set(token, [...list, doc]);
                else
                    posting.set(token, [doc]);
            }
        }
    }
    else {
        posting = new Map();
        for (const doc of documents) {
            for (const token of doc.weights.freq.keys()) {
                const list = posting.get(token);
                if (list)
                    list.push(doc);
                else
                    posting.set(token, [doc]);
            }
        }
    }
    const averageLength = documents.length === 0
        ? 0
        : documents.reduce((sum, doc) => sum + doc.weights.length, 0) / documents.length;
    return { key, corpus: { documents, posting, averageLength }, parts };
}
/**
 * 从零重建（`prev` 缺省即全量）。**测试与等价性判据用它当"标准答案"**
 * （S2-D③：增量结果必须与它逐字一致）。
 */
function buildSearchCorpusUncached(container, opts) {
    const layers = opts.layerFilter ?? ['longterm'];
    return buildSearchCorpusIncremental(container, opts, undefined, searchCorpusKey(container, layers, opts.scopeContext, opts.now)).corpus;
}
/**
 * BM25 打分内核：在已构建的语料上，对给定 token 集打分。与查询扩展解耦，便于单独测「纯 BM25」水平。
 *
 * **等价性依据**（相对改造前的 `searchWithTokens`）：
 *   - df：原实现遍历所有文档统计 `docFrequencies`（含该词的**文档数**），
 *     与本实现 `posting.get(token).length` 逐项相等；
 *   - 候选：原实现只给「含查询词」的文档打分，而含词数为 0 的文档 BM25 必为 0
 *     （下方 `if (tf === 0) continue` 的等价形式），故候选集一致；
 *   - 公式、排序、截断完全照搬。
 */
function scoreFromCorpus(corpus, queryTokens, query, topK) {
    if (queryTokens.length === 0)
        return [];
    const { documents, posting, averageLength } = corpus;
    if (documents.length === 0)
        return [];
    const candidates = new Set();
    for (const token of queryTokens) {
        const list = posting.get(token);
        if (!list)
            continue;
        for (const doc of list)
            candidates.add(doc);
    }
    const k1 = 1.5;
    const b = 0.75;
    const hits = [];
    for (const doc of candidates) {
        // 词频表来自缓存（container.entryTokenStats），**不再每次重新分词**
        const counts = doc.weights.freq;
        let score = 0;
        for (const token of queryTokens) {
            const tf = counts.get(token) ?? 0;
            if (tf === 0)
                continue;
            const df = posting.get(token)?.length ?? 0;
            const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
            const lengthNorm = k1 * (1 - b + b * doc.weights.length / Math.max(1, averageLength));
            score += idf * (tf * (k1 + 1)) / (tf + lengthNorm);
        }
        score *= temporalWeight(doc.state);
        if (doc.frontmatter.conflict_state === 'pending')
            score *= 0.3;
        if (score <= 0)
            continue;
        hits.push(withoutUndefined({
            id: doc.meta.id,
            layer: doc.meta.layer,
            title: doc.meta.title,
            tags: doc.meta.tags,
            score: Number(score.toFixed(4)),
            snippet: makeSnippet(doc.content, queryTokens),
            file: doc.meta.file,
            reasons: recallReasons(doc, queryTokens),
            scope: memoryScope(doc.frontmatter),
            scope_id: doc.frontmatter.scope_id,
            temporal_state: doc.state,
            source: doc.frontmatter.source || undefined,
            source_line: doc.frontmatter.source_line,
            source_session: doc.frontmatter.source_session,
            source_message: doc.frontmatter.source_message,
        }));
    }
    hits.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
    return hits.slice(0, topK);
}
