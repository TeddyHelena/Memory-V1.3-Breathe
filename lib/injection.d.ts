/**
 * injection.ts —— 注入契约层（Injection Contract）
 *
 * 这一层管的是**一件以前没人管的事**：往提示词里塞东西的那个动作本身。
 *
 * ── 为什么需要它（事故记录，不是设计偏好）────────────────────────────
 * 2026-09-23/24 落地的 V1.2 路由骨架，按契约冻结清单 §十一 第 6 步应当
 * **「main 走用户轮次注入」**，实现却挂进了系统提示词的一段 section（order=50）。
 *
 * 代价（09-27 实测）：宿主对「系统提示词变了」只有两种应对——
 * 整份 replace（缓存从首字节失效、整段上下文全价）或 append 一整份副本。
 * 36 轮 182 次调用里被追加 43 份副本，每份 19,980 字符；上下文最终 760,628 token，
 * 其中约 53% 是同一份提示词的重复；每轮固定漏计 8,007~12,771 token。
 *
 * 根因不是代码写错，是**这一层没有主人**：order 由调用方随手给，位置由谁负责没人写。
 * 于是「靠后的 order 不进缓存前缀」这种话被当成规则用了。它是假的——
 * **order 决定「还能命中多少前缀」，决定不了「要不要再付一份」。**
 *
 * ── 两条地基（本模块的立足点）──────────────────────────────────────
 * **① 缓存单元 = 整条系统提示词（含全部 section，按字节比较）。**
 *     section / order / 位置都不改变这个单元。动态内容放进去，就只能在
 *     「每轮付一整份副本」和「每轮付整段上下文」之间选——没有第三种。
 *
 * **② 每段内容必须声明它改的是哪个缓存单元、是否每轮变化。**
 *    这个声明就是本模块的 CHANNEL_CONTRACT。**没声明的内容不许注入。**
 *
 * ── 本模块不做的事 ────────────────────────────────────────────────
 * 不接管注入动作本身（各段仍由 index.ts 注册），只做**契约声明 + 运行时记账 +
 * 违反契约时报错**。先观测，不自作主张——等记账跑出数据，再谈要不要自动化。
 */
/**
 * 稳定性分类 —— 决定「这段内容允不允许变」。
 *
 * - `coldStart`：本会话内**必须字节不变**。变了就是 bug，必须报出来。
 * - `stable`：只在显式失效（写入置脏等）时才变。变化合法，但必须**登记原因**。
 * - `volatile`：允许每轮变。它必须走自替换通道，不得进可缓存前缀。
 */
export type StabilityClass = 'coldStart' | 'stable' | 'volatile';
/** 投递通道 —— 决定「这段内容按什么单位计费」。 */
export type Channel = 'systemPrompt' | 'runtimeContext';
export interface ChannelContract {
    /** 稳定名，与宿主注册时用的 name 一致 */
    readonly name: string;
    /** 投递通道 */
    readonly channel: Channel;
    /** 稳定性分类 */
    readonly stability: StabilityClass;
    /**
     * **必填**：批准的变化触发条件。空数组 = 不允许任何变化。
     * 运行期观测到变化时，必须能指到这里的一条；指不到就是契约违反。
     */
    readonly changeTriggers: readonly string[];
    /** 这段内容在文本上改的是哪个缓存单元。给读代码的人看的一句话。 */
    readonly mutatesCacheUnit: string;
    /** 宿主注册用的 order（仅供对照，**不是**成本控制手段） */
    readonly order: number;
    /** 这段不注入时的后果（供排障时判断优先级） */
    readonly onMissing: string;
    /** 落地备注（可选）：写"什么时候注册""最容易改错哪一步"这类只在排障时有用的话 */
    readonly note?: string;
}
/**
 * memory 插件的注入契约。**新增任何注入段，先在这里登记，再去注册。**
 */
export declare const CHANNEL_CONTRACT: readonly ChannelContract[];
/**
 * 判据一：**缓存单元 = 整条系统提示词。**
 *
 * 这句话写成函数，是为了让「按 section 算账」这种错法在代码评审里一眼可见：
 * 任何按 section 折算成本的推理，都要先经过这里 —— 而这里只认整条。
 */
export declare function cacheUnit(): {
    unit: 'systemMessage';
    note: string;
};
/**
 * 判据二（验收用）：**任何新增注入内容必须回答两个问题。**
 *
 * 出处：`V1.2契约冻结清单_20260923.md` D2 判据追加条款。
 * 未通过本检查的注入段，不得进入验收。
 */
export interface InjectionDeclaration {
    /** 它改的是哪个缓存单元？ */
    readonly cacheUnit: string;
    /** 它是否每轮变化？ */
    readonly changesEveryTurn: boolean;
}
export declare function validateDeclaration(decl: Partial<InjectionDeclaration>): string[];
/** 契约表自检：每一条都必须能通过判据二。 */
export declare function auditContract(contracts?: readonly ChannelContract[]): string[];
export interface ChannelObservation {
    /** 本次装配该段的字符数 */
    readonly chars: number;
    /**
     * 变化是否已登记原因。volatile 段恒为 true（它变是职责）。
     * 稳定段变化时若为 false，记一条契约违反。
     */
    readonly expected: boolean;
}
export interface LedgerSnapshot {
    /** 每条段：观测次数 / 变化次数 / 违规变化次数 / 最近字符数 */
    readonly channels: Record<string, {
        observations: number;
        changes: number;
        violations: number;
        lastChars: number;
    }>;
    readonly violations: string[];
}
/**
 * 装配记账本。
 *
 * **它不解装配，只记账。** 每条段每次装配调一次 `observe()`；
 * 稳定段在没有登记原因的情况下变了字节数 → 记一条违规。
 *
 * 为什么记「长度变了」而不是「内容变了」：长度是 O(1) 可得的，
 * 而长度不变、内容变了这种情况对本判据没有意义
 * （缓存单元按字节比较，长度相同内容不同一样失效——但那种情形在这个插件里不存在：
 *  voice/hot 两段的内容来源都是确定的文件渲染，长度是内容的函数）。
 * **这是一条明写的边界，不是省略。**
 */
export declare class AssemblyLedger {
    private readonly state;
    private readonly violations;
    observe(name: string, obs: ChannelObservation): void;
    snapshot(): LedgerSnapshot;
    reset(): void;
}
