/** 图谱 wire 类型（与 host 侧 /graph 对齐） */
/** 层类型（client 侧内联，避免跨 rootDir 引用）；pending=候选层，与 host types.ts 对齐 */
export type Layer = 'hot' | 'archive' | 'longterm' | 'pending';
/** 图中一个节点（条目） */
export interface GraphNode {
    id: string;
    layer: Layer;
    /** 生命周期状态（expired/superseded ⇒ 画**空心**；缺省按 active） */
    status?: string;
    /** 【B3b】新鲜度（宿主按 `freshForEntry` 算，⛔ 客户端不重算）*/
    fresh?: number;
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
    type: 'hot' | 'group' | 'tag';
}
/** 图谱数据 */
export interface MemoryGraph {
    nodes: GraphNode[];
    links: GraphLink[];
    hot_order: string[];
}
