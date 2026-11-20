/**
 * lexicon.ts —— 同义词/别名扩展层（V1.0 / P2）
 *
 * 要解决的问题：BM25 是词面匹配。用户换个说法问（"聊天记录怎么长期保存" vs 标题里的"归档"），
 * 词面不重叠就漏召。评测集里同义改写那一组的漏召率就是这项能力的刻度。
 *
 * 设计取舍：
 *   - **不引入向量检索**：本地零依赖、可解释是底线；先做确定性的别名映射，效果不够再谈 embedding。
 *   - **可开关**：`enableLexicon` 默认开，但真伪可验——关掉后指标应回落到无扩展水平。
 *   - **双向等价**：扩展是 "A 也要搜 B"，因为词典是人工维护的等价关系。
 *   - **代价可控**：每次查询最多扩展 `maxExtraQueries` 条附加查询，命中按 id 去重取最高分。
 *   - **不猜**：词典里没有的关系宁可漏，不做模糊推断（那是幻觉的入口）。
 */

/** 同义/别名表：键是用户可能说的词，值是容器里实际可能用的词（双向等价） */
const SYNONYM_GROUPS: string[][] = [
  // —— 记忆系统本体 ——
  ['记忆', '记忆库', '记忆容器', 'memory', '长期记忆', '脑海'],
  ['写入', '保存', '记录', '存下来', '落库', '记住'],
  ['检索', '搜索', '查找', '查询', '召回', '找出来'],
  ['删除', '忘掉', '忘记', '清除', '抹掉', '被遗忘权'],
  ['纠正', '改正', '修正', '改掉', '更新'],
  ['候选', '候选区', '待确认', '草稿箱'],
  ['版本', '版本化', '历史版本', '旧版'],
  ['过期', '失效', '作废', '过期信息', '时间状态'],
  ['来源', '出处', '依据', '溯源'],
  ['假设', '推断', '猜测', '臆测', '推的'],
  ['事实', '客观事实', '查到的'],
  ['偏好', '习惯', '喜好', '口味'],

  // —— 工程动作 ——
  ['迁移', '搬到', '搬家', '挪到', '换地方', '转移', '改变路径'],
  ['归档', '存档', '长期保存', '留档', '存档起来'],
  ['备份', '副本', '存档备份'],
  ['即时生效', '立刻生效', '马上生效', '实时生效', '立即读到'],
  ['上下文', 'context', '提示词长度', 'token', '预算', '上下文预算'],
  ['插件', '扩展', 'extension', '模块'],
  ['重启', '重新启动', 'reload'],
  ['配置', '设置', 'config', '参数'],

  // —— 能力对话 ——
  ['看图', '识图', '图片内容', '图片里', '读图', '截图识别'],
  ['语音', '朗读', '语音合成', '念出来', '转写', '录音转文字'],
  ['画图', '出图', '制图', '建模', '三维模型', '图纸', 'CAD', '打印'],
  ['聊天记录', '对话记录', '会话记录', '历史对话', '对话档案'],
  ['目录', '文件夹', '路径', '工作目录', '工作区'],
  ['窗口', '界面', '面板', 'UI'],
]

/** 词 → 同组其它词（含自身） */
const SYNONYM_MAP = new Map<string, string[]>()
for (const group of SYNONYM_GROUPS) {
  for (const word of group) {
    const existing = SYNONYM_MAP.get(word) ?? []
    SYNONYM_MAP.set(word, [...new Set([...existing, ...group.filter((w) => w !== word)])])
  }
}

/**
 * 从查询里抽取「词」：
 *   - 连续汉字块整体保留（用于整块命中）
 *   - 同时切出其中的 2 字与 3 字子串（中文短语常以 2-3 字为义素）
 *   - 英文数字按词取
 */
function candidateTerms(query: string): string[] {
  const cleaned = query.replace(/[，。！？、；：""''（）【】《》\s]+/g, ' ').trim()
  const chunks = cleaned.match(/[\u4e00-\u9fa5]+/g) ?? []
  const latin = cleaned.match(/[A-Za-z][A-Za-z0-9-]{1,}/g) ?? []
  const terms = new Set<string>(latin)
  for (const chunk of chunks) {
    // ① 整块就是词典词（≤4 字且能直接命中）→ 只用它，不再切子串。
    //    不这样做的后果真实出现过：「语音朗读」切出「朗读」，与组内"念出来"替换得到
    //    「念出来朗读…」，同时与自身替换得到「朗读朗读…」——垃圾扩展挤掉有效名额。
    if (chunk.length <= 4 && SYNONYM_MAP.has(chunk)) {
      terms.add(chunk)
      continue
    }
    // ② 先扫「≤4 字且在词典里」的 n-gram（长词优先，避免被短词切碎）
    for (let size = Math.min(4, chunk.length); size >= 2; size--) {
      for (let i = 0; i + size <= chunk.length; i++) {
        const candidate = chunk.slice(i, i + size)
        if (SYNONYM_MAP.has(candidate)) terms.add(candidate)
      }
    }
    // ③ 整块本身也纳入（长块可能直接命中词典或作为原词参与替换）
    terms.add(chunk)
  }
  return [...terms]
}

/**
 * 把查询扩展成「附加查询」列表：对命中的同义词，用组内其它词替换原词生成新查询。
 * 返回的列表不含原查询；数量上限由调用方控制。
 */
export function expandQuery(query: string, maxExtraQueries = 4): string[] {
  const extras: string[] = []
  const seen = new Set<string>([query])
  for (const term of candidateTerms(query)) {
    const synonyms = SYNONYM_MAP.get(term)
    if (!synonyms) continue
    for (const synonym of synonyms) {
      // 跳过重叠替换：把「工作目录」换成「工作区」会得到「工作工作区」，
      // 把「语音朗读」换成「朗读」会得到「朗读朗读」——这类垃圾扩展不占名额。
      if (synonym.includes(term) || term.includes(synonym)) continue
      const rewritten = query.split(term).join(synonym)
      if (rewritten === query || seen.has(rewritten) || rewritten.trim().length < 2) continue
      seen.add(rewritten)
      extras.push(rewritten)
      if (extras.length >= maxExtraQueries) return extras
    }
  }
  return extras
}
