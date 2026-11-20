/**
 * contract/layer.ts —— 层间语义显式化（优化方案 §7）
 *
 * ── 治的是什么病 ────────────────────────────────────────────────
 * 「候选集」这个词在不同层指的东西不一样，而**没有任何地方写下过它指的是哪个集合**。
 *
 * V1.2 实录（真踩过）：`budget.allocate` 用"候选集最高分"算 `gate_in` 分位数门槛，
 * 但引入硬门禁之后，它看到的仍是**全量召回**。于是一条**已被门禁拒掉**的 99 分联想候选
 * 把门槛抬到 0.5×99 ≈ 49.5，而真正该进 main 的 0.5 分条目反被挡在门外 —— **main 变空数组**。
 *
 * 注意：**两条规则各自都是对的**（"分位数取候选集最高分"对，"门禁把不合格条目挡住"也对）。
 * 错的是"候选集"在两层的指代不同，而这个约定没写在任何地方。
 *
 * ── 本模块给两个东西 ────────────────────────────────────────────
 *   ① 集合命名与基准声明：`SetName` + `QuantileSpec.baseSet`（**相对量必须带基准**）
 *   ② 层间 trace 校验：集合由代码产出 + 运行时指纹比对（不是手写字符串对齐）
 *
 * ── 关于 ② 为什么不能用字符串对齐 ────────────────────────────────
 * 上游设计 v0.1 用 `PIPELINE` 的手写 in/out 字符串 + "这层 in == 上层 out"断言。
 * **那只能抓打错字**：把 `gatePassed` 的过滤条件真改了（集合构成变了），字符串没变，
 * 断言照样过。所以这里改为：集合对象由层 `publish`，用**指纹**校验，定义变了指纹就变。
 */
/** 流水线层名（`ASSEMBLE` 之后的消费方不入链——它只是读，不产出新集合） */
export type LayerName = 'RECALL' | 'SCORE' | 'GATE' | 'BUDGET';
/** 集合名（无歧义命名，禁用"候选集"这种一词多义的词） */
export type SetName = 'callAll' | 'scored' | 'gatePassed' | 'candZone' | 'main';
export interface LayerScheme {
    layer: LayerName;
    in: SetName;
    out: SetName;
    note: string;
}
export interface QLBaseRecord {
    layer: LayerName;
    baseSet: SetName;
    fraction: number;
    size: number;
    value: number | null;
}
export interface SetRecord {
    layer: LayerName;
    name: SetName;
    size: number;
    fingerprint: string;
}
/**
 * 一轮路由的层间 trace：谁产出了什么集合、谁在哪个集合上算了相对量。
 *
 * 生命周期：**一轮一个**（`route()` 内部创建），不跨轮复用——
 * 跨轮复用会让"上一轮的集合"被当成"本轮的"，那正是本模块要防的错。
 */
export declare class LayerTrace {
    readonly sets: SetRecord[];
    readonly qlBases: QLBaseRecord[];
    /** 顺序常量，供校验时判断"基准集合是否已在本链中产出" */
    private order;
    publish(layer: LayerName, name: SetName, set: readonly unknown[]): void;
    recordQL(rec: QLBaseRecord): void;
    /**
     * 校验：声明与事实是否一致。
     *
     * 抓三类：
     *   ① 层间断裂：某层实际产出的集合，与上一层声明要交给它的集合**指纹不一样**
     *      （字符串对齐抓不到这个——定义改了字符串不变）
     *   ② 未 publish 就消费：某层在 trace 里没有产出记录，却在上面算了相对量
     *   ③ 基准集合越层：相对量的基准必须是**本链中已经产出过的**集合，不许凭空引用
     */
    check(): {
        ok: true;
    } | {
        ok: false;
        code: string;
        detail: string;
    };
}
export interface QuantileSpec<S> {
    /**
     * ★ 基准集合声明——**必填**。
     * 没有它，分位数函数不知道该在哪个集合上取；本模块的存在就是为了不让这件事"靠小心"。
     */
    baseSet: SetName;
    fraction: number;
    field: (x: S) => number;
}
/**
 * 在指定基准集合上取分位数。
 *
 * **两条硬规则**：
 *   ① 空集合 → 返回 `null`（**不抬门槛**）。V1.2 那次的另一半教训就在这里：
 *      空集若按 `top=0` 算出 0 门槛，等于"什么都放行"；而实践里空集应当**不放行**，
 *      由调用方显式处理。返回 null 把决定权交回调用方，函数本身不替它猜。
 *   ② 绝不静默回退到别的集合。基准错了要**报错**，不是"算了就用全量吧"。
 */
export declare function quantileOver<S>(items: readonly S[], spec: QuantileSpec<S>): number | null;
