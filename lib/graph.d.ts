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
import type { MemoryContainer } from './container.js';
import type { Layer } from './types.js';
/** 图中一个节点（条目） */
export interface GraphNode {
    id: string;
    layer: Layer;
    /** 生命周期状态 —— 客户端据此画"**失效=空心**"（原型图例：实心 活跃 · 半透明 陈旧 · 空心 失效） */
    status?: string;
    title: string;
    tags: string[];
    priority: number;
    updated: string;
    summary: string;
}
/** 图中一条边（钩稽关系） */
export interface GraphLink {
    source: string;
    target: string;
    /** 关系类型：hot=热链, group=分组, tag=强共享标签(≥2) */
    type: 'hot' | 'group' | 'tag';
}
/** 图谱数据（GET /api/memory/graph 的返回体） */
export interface MemoryGraph {
    nodes: GraphNode[];
    links: GraphLink[];
    hot_order: string[];
    /**
     * 被规模安全阀限制的膨胀源（超限即不展开，如实上报）。
     * 形如 `['tagx(1200成员/719400对)']`。**存在即说明图不完整**——UI 应据此提示。
     */
    limited?: string[];
}
/** 构建图谱数据（纯派生，无文件 IO，可重复调用） */
export declare function buildMemoryGraph(container: MemoryContainer): MemoryGraph;
