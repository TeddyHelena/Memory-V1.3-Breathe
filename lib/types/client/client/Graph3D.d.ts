/** 3D 旋转知识球：Canvas 手写渲染，零依赖。自转 + 拖拽旋转 + 滚轮缩放 + hover 高亮 + 点击选中。 */
import type { GraphLink, GraphNode } from './graph-types.ts';
export interface Graph3DProps {
    nodes: GraphNode[];
    links: GraphLink[];
    /** 搜索命中节点 id 集合（未命中节点变暗） */
    highlight?: ReadonlySet<string> | null;
    /** 当前选中的节点 id */
    selectedId?: string | null;
    onSelect: (id: string) => void;
}
export declare function Graph3D({ nodes, links, highlight, selectedId, onSelect }: Graph3DProps): React.JSX.Element;
