/**
 * 本地 BM25 检索：中文 2-gram、英文/数字分词，不依赖联网或向量服务。
 * 标题、标签、摘要和正文使用不同权重，并返回可解释的召回原因。
 */

import { MemoryContainer } from './container.js'
import { expandQuery } from './lexicon.js'
import { isCurrentMemory, isInScope, memoryScope, temporalState, temporalWeight } from './policy.js'
import type { EntryFrontmatter, Layer, MemoryScopeContext, MemorySearchHit } from './types.js'

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
export function withoutUndefined<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key] = value
  }
  return out as T
}

const STOPWORDS = new Set([
  '的', '了', '和', '与', '在', '是', '我', '你', '他', '她', '它',
  '我们', '你们', '他们', '这个', '那个', '一个', '什么', '怎么', '如何',
])

/** 导出供基准测试和后续本地向量混排复用。 */
function tokenize(text: string): string[] {
  const words: string[] = []
  const en = text.match(/[a-zA-Z0-9]+/g)
  if (en) words.push(...en.map((word) => word.toLowerCase()))
  const cn = text.replace(/[a-zA-Z0-9_\-\s，。！？、；：“”‘’（）《》【】,.!?;:'"()<>[\]{}|/\\\n\r\t]/g, '')
  for (let i = 0; i < cn.length - 1; i++) {
    const gram = cn.slice(i, i + 2)
    if (!STOPWORDS.has(gram)) words.push(gram)
  }
  return words
}

interface SearchDocument {
  meta: ReturnType<MemoryContainer['getIndex']>['entries'][number]
  frontmatter: EntryFrontmatter
  /** 加权词频表与加权长度（由 weightedFrequency 统一算；检索打分只用它） */
  weights: { freq: Map<string, number>; length: number }
  content: string
  state: ReturnType<typeof temporalState>
  fields: {
    title: Set<string>
    tags: Set<string>
    summary: Set<string>
    content: Set<string>
  }
}

function repeat(tokens: string[], weight: number): string[] {
  return Array.from({ length: weight }, () => tokens).flat()
}

function buildDocument(
  meta: SearchDocument['meta'],
  frontmatter: EntryFrontmatter,
  content: string,
  state: SearchDocument['state'],
  /** 缓存命中的词频（来自 container.entryTokenStats）——给了就不再重新分词 */
  cachedWeights?: { freq: Map<string, number>; length: number },
): SearchDocument {
  const doc: SearchDocument = {
    meta,
    frontmatter,
    content,
    state,
    weights: cachedWeights ?? weightedFrequency(
      tokenize(meta.title), tokenize(meta.tags.join(' ')), tokenize(meta.summary), tokenize(content),
    ),
  } as SearchDocument
  // ── fields 惰性求值（2026-09-15 性能修正）───────────────────────
  // 实测：2000 条语料里，buildDocument 给**每一条**算 4 个字段的分词，
  // 而 fields 只被 recallReasons 使用——那是对**返回的 topK 条（≤20）**调用的。
  // 等于 99% 的分词算完就扔。改成 getter：只有真要输出解释时才分词。
  Object.defineProperty(doc, 'fields', {
    enumerable: true,
    configurable: true,
    get() {
      const title = tokenize(meta.title)
      const tags = tokenize(meta.tags.join(' '))
      const summary = tokenize(meta.summary)
      const body = tokenize(content)
      const value = {
        title: new Set(title),
        tags: new Set(tags),
        summary: new Set(summary),
        content: new Set(body),
      }
      Object.defineProperty(doc, 'fields', { value, enumerable: true, configurable: true })
      return value
    },
  })
  return doc
}

/** 加权词频：一次性算出「加权词频表」与「加权总长度」。权重规则唯一定义在此。 */
function weightedFrequency(
  title: string[], tags: string[], summary: string[], body: string[],
): { freq: Map<string, number>; length: number } {
  const freq = new Map<string, number>()
  const bump = (tokens: string[], weight: number): number => {
    for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + weight)
    return tokens.length * weight
  }
  const length = bump(title, 4) + bump(tags, 3) + bump(summary, 2) + bump(body, 1)
  return { freq, length }
}

/**
 * 【S2 · S2-D】喂给 `container.entryTokenStats` 的分词回调。
 *
 * 定义在模块级（不是每次调用现造一个闭包）：`entryTokenStats` 的缓存键是 (id, mtime)，
 * 回调本身不参与缓存，但稳定的函数引用能让"这条缓存是给谁的"一目了然。
 */
function TOKEN_COUNT(
  content: string,
  meta: { title: string; tags: string[]; summary: string },
): { freq: Map<string, number>; length: number } {
  return weightedFrequency(tokenize(meta.title), tokenize(meta.tags.join(' ')), tokenize(meta.summary), tokenize(content))
}

function frequency(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1)
  return counts
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function makeSnippet(content: string, queryTokens: string[], maxLen = 120): string {
  const pattern = queryTokens.map(escapeRegExp).filter(Boolean).join('|')
  const idx = pattern ? content.search(new RegExp(pattern, 'i')) : -1
  if (idx < 0) return content.slice(0, maxLen)
  const start = Math.max(0, idx - 30)
  return (start > 0 ? '…' : '') + content.slice(start, start + maxLen) +
    (start + maxLen < content.length ? '…' : '')
}

function recallReasons(doc: SearchDocument, queryTokens: string[]): string[] {
  const matches = (tokens: Set<string>) => queryTokens.filter((token) => tokens.has(token))
  const reasons: string[] = []
  const title = matches(doc.fields.title)
  const tags = matches(doc.fields.tags)
  const summary = matches(doc.fields.summary)
  const content = matches(doc.fields.content)
  if (title.length) reasons.push(`标题命中：${title.slice(0, 3).join('、')}`)
  if (tags.length) reasons.push(`标签命中：${tags.slice(0, 3).join('、')}`)
  if (summary.length) reasons.push(`摘要命中：${summary.slice(0, 3).join('、')}`)
  if (content.length) reasons.push(`正文命中：${content.slice(0, 3).join('、')}`)
  if (doc.state === 'stale') reasons.push('状态为 stale，已降低排序权重')
  if (doc.frontmatter.conflict_state === 'pending') reasons.push('存在待处理冲突，已降低排序权重')
  return reasons
}

/**
 * 检索 longterm，可选 archive。过期、被替代、尚未生效或作用域不匹配的条目不进入候选集。
 */
export function searchLongterm(
  container: MemoryContainer,
  query: string,
  opts: {
    topK?: number
    layerFilter?: Array<'longterm' | 'archive'>
    scopeContext?: MemoryScopeContext
    now?: Date
    /**
     * 同义词扩展（P2）：默认开启。关掉后应回落到纯 BM25 水平——
     * 这个开关同时是「扩展到底有没有用」的实测手段（评测脚本按开/关各跑一遍）。
     */
    enableLexicon?: boolean
    /** 每次查询最多附加几条扩展查询（上限，防止把一次检索放大成风暴） */
    maxExtraQueries?: number
  } = {},
): MemorySearchHit[] {
  const topK = Math.max(1, Math.min(50, Math.floor(opts.topK ?? 5)))

  // ── 语料只构建一次，base 与全部扩展查询共用（v1.1 增量③ 修复）──────────
  // 原实现把「构建文档集 + 统计全量 df」放在**每个查询**里重做一遍，
  // 而同义扩展会把一次检索放大成最多 5 次 → 2000 条端到端实测 219.93ms（验收线 200ms）。
  // 这两件事都与查询无关：文档集只依赖索引与过滤条件，df 只依赖文档集。
  const corpus = buildSearchCorpus(container, opts)
  const base = scoreFromCorpus(corpus, [...new Set(tokenize(query))], query, topK)
  if (opts.enableLexicon === false) return base

  const extras = expandQuery(query, Math.max(0, opts.maxExtraQueries ?? 4))
  if (extras.length === 0) return base

  // 合并：同一条目取最高分；snippet/reasons 取分数更高的那次查询的版本
  const merged = new Map<string, MemorySearchHit>()
  for (const hit of base) merged.set(hit.id, hit)
  for (const extra of extras) {
    const tokens = [...new Set(tokenize(extra))]
    if (tokens.length === 0) continue
    for (const hit of scoreFromCorpus(corpus, tokens, extra, topK)) {
      const previous = merged.get(hit.id)
      if (!previous || hit.score > previous.score) merged.set(hit.id, hit)
    }
  }
  const out = [...merged.values()]
  out.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
  return out.slice(0, topK)
}

/**
 * 一次构建、多查询复用的检索语料（v1.1 增量③）。
 *
 * 各字段都**与查询无关**：
 *   - `documents`：由索引 + 过滤条件（层级 / 作用域 / 时效）决定；
 *   - `posting`：全量倒排，同时充当 df 表（df = 列表长度）；
 *   - `averageLength`：BM25 长度归一化用的加权平均文档长度。
 * 所以按查询重建它们是纯浪费 —— 这正是 2000 条端到端 219.93ms 的来源。
 */
interface SearchCorpus {
  documents: SearchDocument[]
  posting: Map<string, SearchDocument[]>
  averageLength: number
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
const CORPUS_CACHE = new WeakMap<MemoryContainer, {
  key: string
  corpus: SearchCorpus
  /**
   * 参与构建的条目：id → { 文档, **容器侧文档对象**, 时态 }。
   * `src` 用来判"这条的内容换没换"——容器语料里内容没变就是**同一个对象**（见 container.corpus 的增量路径），
   * 于是"对象同一个 + 时态同一个"⇒ 这份 SearchDocument 可以原样复用，不必重分词、不必重建它的倒排项。
   */
  parts: Map<string, { doc: SearchDocument; src: object; state: string }>
}>()

function searchCorpusKey(
  container: MemoryContainer,
  layers: Layer[],
  scopeContext: MemoryScopeContext | undefined,
  now: Date | undefined,
): string {
  const docs = container.corpus()
  const parts: string[] = [container.corpusVersion(), layers.join(',')]
  for (const meta of container.getIndex().entries) {
    if (!layers.includes(meta.layer)) continue
    const doc = docs.get(meta.id)
    if (!doc || !isInScope(doc.frontmatter, scopeContext)) continue
    parts.push(`${meta.id}:${temporalState(doc.frontmatter, now)}`)
  }
  return parts.join('|')
}

function buildSearchCorpus(
  container: MemoryContainer,
  opts: {
    layerFilter?: Array<'longterm' | 'archive'>
    scopeContext?: MemoryScopeContext
    now?: Date
  },
): SearchCorpus {
  const layers: Layer[] = opts.layerFilter ?? ['longterm']
  const key = searchCorpusKey(container, layers, opts.scopeContext, opts.now)
  const hit = CORPUS_CACHE.get(container)
  if (hit && hit.key === key) return hit.corpus
  const built = buildSearchCorpusIncremental(container, opts, hit, key)
  CORPUS_CACHE.set(container, built)
  return built.corpus
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
function buildSearchCorpusIncremental(
  container: MemoryContainer,
  opts: {
    layerFilter?: Array<'longterm' | 'archive'>
    scopeContext?: MemoryScopeContext
    now?: Date
  },
  prev: { key: string; corpus: SearchCorpus; parts: Map<string, { doc: SearchDocument; src: object; state: string }> } | undefined,
  key: string,
): { key: string; corpus: SearchCorpus; parts: Map<string, { doc: SearchDocument; src: object; state: string }> } {
  const layers: Layer[] = opts.layerFilter ?? ['longterm']
  const docs = container.corpus()
  const parts = new Map<string, { doc: SearchDocument; src: object; state: string }>()
  const documents: SearchDocument[] = []
  const stale: SearchDocument[] = []   // 需要从倒排里摘掉的旧文档（内容变了或不再入语料）
  const fresh: SearchDocument[] = []   // 需要加进倒排的文档（新增或内容变了）

  const seen = new Set<string>()
  for (const meta of container.getIndex().entries) {
    if (!layers.includes(meta.layer)) continue
    // 用 `corpus()` 而不是 `readEntry()`：前者对没变的条目返回**同一个对象**，这正是复用判据。
    const file = docs.get(meta.id)
    if (!file || !isInScope(file.frontmatter, opts.scopeContext)) continue
    const state = temporalState(file.frontmatter, opts.now)
    if (!isCurrentMemory(state)) continue
    seen.add(meta.id)

    const old = prev?.parts.get(meta.id)
    if (old && old.src === file && old.state === state) {
      parts.set(meta.id, old)
      documents.push(old.doc)
      continue
    }
    const cachedWeights = container.entryTokenStats(meta.id, TOKEN_COUNT) ?? undefined
    const doc = buildDocument(meta, file.frontmatter, file.content, state, cachedWeights)
    parts.set(meta.id, { doc, src: file as unknown as object, state })
    documents.push(doc)
    fresh.push(doc)
    if (old) stale.push(old.doc)
  }
  // 上一版里、这一版不再入语料的（被删/改层/过期/出 scope）
  if (prev) for (const [id, p] of prev.parts) if (!seen.has(id)) stale.push(p.doc)

  let posting: Map<string, SearchDocument[]>
  if (prev && prev.corpus.posting.size > 0) {
    posting = new Map(prev.corpus.posting)
    for (const doc of stale) {
      for (const token of doc.weights.freq.keys()) {
        const list = posting.get(token)
        if (!list) continue
        const next = list.filter((d) => d !== doc)
        if (next.length) posting.set(token, next)
        else posting.delete(token)
      }
    }
    for (const doc of fresh) {
      for (const token of doc.weights.freq.keys()) {
        const list = posting.get(token)
        // ⛔ 别原地 push：桶数组可能与上一版缓存共享（`new Map` 只复制 Map，不复制数组）
        if (list) posting.set(token, [...list, doc])
        else posting.set(token, [doc])
      }
    }
  } else {
    posting = new Map<string, SearchDocument[]>()
    for (const doc of documents) {
      for (const token of doc.weights.freq.keys()) {
        const list = posting.get(token)
        if (list) list.push(doc)
        else posting.set(token, [doc])
      }
    }
  }

  const averageLength =
    documents.length === 0
      ? 0
      : documents.reduce((sum, doc) => sum + doc.weights.length, 0) / documents.length

  return { key, corpus: { documents, posting, averageLength }, parts }
}

/**
 * 从零重建（`prev` 缺省即全量）。**测试与等价性判据用它当"标准答案"**
 * （S2-D③：增量结果必须与它逐字一致）。
 */
function buildSearchCorpusUncached(
  container: MemoryContainer,
  opts: {
    layerFilter?: Array<'longterm' | 'archive'>
    scopeContext?: MemoryScopeContext
    now?: Date
  },
): SearchCorpus {
  const layers: Layer[] = opts.layerFilter ?? ['longterm']
  return buildSearchCorpusIncremental(container, opts, undefined, searchCorpusKey(container, layers, opts.scopeContext, opts.now)).corpus
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
function scoreFromCorpus(
  corpus: SearchCorpus,
  queryTokens: string[],
  query: string,
  topK: number,
): MemorySearchHit[] {
  if (queryTokens.length === 0) return []
  const { documents, posting, averageLength } = corpus
  if (documents.length === 0) return []

  const candidates = new Set<SearchDocument>()
  for (const token of queryTokens) {
    const list = posting.get(token)
    if (!list) continue
    for (const doc of list) candidates.add(doc)
  }

  const k1 = 1.5
  const b = 0.75
  const hits: MemorySearchHit[] = []
  for (const doc of candidates) {
    // 词频表来自缓存（container.entryTokenStats），**不再每次重新分词**
    const counts = doc.weights.freq
    let score = 0
    for (const token of queryTokens) {
      const tf = counts.get(token) ?? 0
      if (tf === 0) continue
      const df = posting.get(token)?.length ?? 0
      const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5))
      const lengthNorm = k1 * (1 - b + b * doc.weights.length / Math.max(1, averageLength))
      score += idf * (tf * (k1 + 1)) / (tf + lengthNorm)
    }
    score *= temporalWeight(doc.state)
    if (doc.frontmatter.conflict_state === 'pending') score *= 0.3
    if (score <= 0) continue
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
    }) as MemorySearchHit)
  }
  hits.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
  return hits.slice(0, topK)
}
