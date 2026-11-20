/**
 * vault-registry.ts —— 读「库登记表」，把库文件并进检索（2026-09-30）
 *
 * ── 为什么需要这一层 ──────────────────────────────────────────────
 * 库里有很多文件**不该进容器**（占的字符太多、也不需要每轮被想起），
 * 但**必须能被找到**。设计稿定的做法是：库侧一份登记表，插件读它。
 *
 * 为什么放库里不放容器：
 *   ① 档案是大宗（近千个文件），不该让它的元数据挂在容器里；
 *   ② 改这张表**不需要重启**（容器数据要重启，库文件不要）。
 *
 * ── 边界（明写，不用"暂不支持"含糊）──────────────────────────────
 * 本模块**只读**，不写任何文件；登记表不存在时静默返回空（不报错、不影响主检索）。
 * 库文件的内容**不注入系统提示词**——它只参与检索，取全文要走 `memory_load`。
 */
/** 登记表里的一行 */
export interface RegistryEntry {
    id: string;
    /** 相对 vault 根的路径 */
    path: string;
    /** 表里记的字符数（仅供展示，不参与打分） */
    size: number;
    /** 两个维度的标签，如 `methodology/framework` */
    tags: string;
    /** 一句话 */
    note: string;
    /** 由 path 拆出的绝对路径 */
    abs: string;
}
export interface RegistryLoadResult {
    entries: RegistryEntry[];
    /** 读表失败或没表时的原因（供排障，不抛） */
    problem?: string;
}
/**
 * 解析登记表 markdown。
 *
 * 认的是这种行（表头与注释行会被跳过）：
 *   | `m-pg-01` | 02_方法论/人格图谱框架/0_框架总览.md | 2,667 | `methodology/framework` | 一句话 |
 *
 * 容错：反引号可省、字符数可空、列数以 5 为准但后两列可以缺。
 */
export declare function parseRegistryMarkdown(text: string): RegistryEntry[];
/** 读登记表并补上绝对路径。表不存在 → 空数组 + problem，不抛。 */
export declare function loadVaultRegistry(registryFile: string, vaultRoot: string): RegistryLoadResult;
/**
 * 关键词打分（简版 BM25 风格：命中次数 / 长度归一）。
 *
 * 为什么不用容器那套 `search.ts`：那套吃的是容器 `MemoryContainer`（索引 + 条目文件），
 * 而登记表条目**不在容器里**。这里的文本只有 id / tags / note 三项，够用也够快。
 */
export declare function scoreRegistry(entries: readonly RegistryEntry[], query: string, topK: number): Array<RegistryEntry & {
    score: number;
}>;
