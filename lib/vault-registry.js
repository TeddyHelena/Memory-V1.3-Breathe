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
import fs from 'node:fs';
/**
 * 解析登记表 markdown。
 *
 * 认的是这种行（表头与注释行会被跳过）：
 *   | `m-pg-01` | 02_方法论/人格图谱框架/0_框架总览.md | 2,667 | `methodology/framework` | 一句话 |
 *
 * 容错：反引号可省、字符数可空、列数以 5 为准但后两列可以缺。
 */
export function parseRegistryMarkdown(text) {
    const out = [];
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line.startsWith('|'))
            continue;
        const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
        if (cells.length < 3)
            continue;
        if (/^-+$/.test(cells[0].replace(/[:\s]/g, '')))
            continue; // 分隔行
        const strip = (s) => s.replace(/^`|`$/g, '').trim();
        const id = strip(cells[0] ?? '');
        const path = strip(cells[1] ?? '');
        // ⚠️ 路径校验踩过两次（2026-09-30），两次都**静默丢行**，所以这里把口径写死：
        //    ① 只认「以 .md 结尾」→ 档案按组登记（路径以「（N 篇）」收尾）整批被丢；
        //    ② 改成「含 / 且不含空格」→ 根目录那些 `README_知识库索引.md`
        //       （**不含 /**）与带空格的组路径（`…/（42 篇）`）又被误杀。
        //    最终口径：**以 .md 结尾，或含 /** —— 两条满足其一即认。
        if (!id || !path)
            continue;
        if (!path.endsWith('.md') && !path.includes('/'))
            continue;
        if (id === 'id')
            continue; // 表头
        const size = Number(String(cells[2] ?? '').replace(/[,\s]/g, '')) || 0;
        out.push({
            id,
            path,
            size,
            tags: strip(cells[3] ?? ''),
            note: (cells[4] ?? '').trim(),
            abs: '',
        });
    }
    return out;
}
/** 读登记表并补上绝对路径。表不存在 → 空数组 + problem，不抛。 */
export function loadVaultRegistry(registryFile, vaultRoot) {
    let text;
    try {
        if (!fs.existsSync(registryFile))
            return { entries: [], problem: `登记表不存在: ${registryFile}` };
        text = fs.readFileSync(registryFile, 'utf-8');
    }
    catch (error) {
        return { entries: [], problem: `登记表读取失败: ${String(error)}` };
    }
    const entries = parseRegistryMarkdown(text);
    const root = vaultRoot.replace(/\/+$/, '');
    for (const e of entries)
        e.abs = `${root}/${e.path}`;
    return { entries };
}
/**
 * 关键词打分（简版 BM25 风格：命中次数 / 长度归一）。
 *
 * 为什么不用容器那套 `search.ts`：那套吃的是容器 `MemoryContainer`（索引 + 条目文件），
 * 而登记表条目**不在容器里**。这里的文本只有 id / tags / note 三项，够用也够快。
 */
export function scoreRegistry(entries, query, topK) {
    const tokens = [...new Set(query.toLowerCase().split(/[\s,，、;；]+/).filter((t) => t.length > 0))];
    if (tokens.length === 0)
        return [];
    const scored = [];
    for (const e of entries) {
        const hay = `${e.id} ${e.tags} ${e.note} ${e.path}`.toLowerCase();
        let hits = 0;
        for (const t of tokens) {
            let idx = 0;
            while ((idx = hay.indexOf(t, idx)) >= 0) {
                hits++;
                idx += t.length;
            }
        }
        if (hits === 0)
            continue;
        scored.push({ ...e, score: hits / Math.max(1, Math.log10(hay.length + 10)) });
    }
    scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return scored.slice(0, topK);
}
