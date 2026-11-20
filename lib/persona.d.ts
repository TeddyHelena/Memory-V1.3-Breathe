/**
 * persona 注入：把 hot 条目编译成注入文本。
 * Harness persona 支持模板变量，hot 记忆注入方式 = 模板变量注入。
 * 骨架先产出纯文本，接入点由 index.ts 决定挂到哪个变量。
 */
import { MemoryContainer } from './container.js';
import type { MemoryScopeContext } from './types.js';
/**
 * 内置默认声音（voice.md 缺失时的兜底，同样强制，只是不可编辑）。
 *
 * 说明：声音层是**使用者的个人配置**，不是插件内置人格。真实内容由容器根目录的
 * `voice.md` 提供（可编辑）；这里是文件缺失时的中性兜底，只示范**结构与能力**：
 *   ① 身份与语气规则（使用者可整段替换成自己的助手人格）
 *   ② 底线
 *   ③ 时间感知行为——需要知道现在几点时**调用 `current_time` 工具**，再按下面分档判断。
 *      时间不进系统提示词：进了就会每分钟作废整个缓存前缀。
 */
export declare const DEFAULT_VOICE = "# \u58F0\u97F3\u5C42\uFF08\u5185\u7F6E\u9ED8\u8BA4\uFF09\n\n> \u6B63\u5728\u4F7F\u7528\u63D2\u4EF6\u5185\u7F6E\u9ED8\u8BA4\u58F0\u97F3\uFF08\u5BB9\u5668\u6839\u76EE\u5F55\u7F3A\u5C11 voice.md\uFF09\u3002\n> \u628A voice.md \u653E\u5230\u5BB9\u5668\u6839\u76EE\u5F55\u5373\u53EF\u8986\u76D6\uFF0C\u65E0\u9700\u6539\u4EE3\u7801\u6216\u91CD\u542F\u2014\u2014\u58F0\u97F3\u5C42\u6BCF\u4E2A\u6A21\u578B\u6B65\u91CD\u8BFB\u3002\n\n## \u8EAB\u4EFD\n\u4F60\u662F\u7528\u6237\u7684\u52A9\u624B\uFF0C\u76F4\u63A5\u3001\u7B80\u6D01\u3001\u4E0D\u7AEF\u7740\u3002\u9700\u8981\u81EA\u5B9A\u4E49\u4EBA\u683C\u65F6\uFF0C\u6574\u6BB5\u66FF\u6362\u672C\u6587\u4EF6\u5373\u53EF\u3002\n\n## \u8BF4\u8BDD\uFF08\u786C\u89C4\u5219\uFF09\n1. \u5148\u7ED3\u8BBA\u540E\u89E3\u91CA\uFF0C\u80FD\u4E00\u53E5\u8BDD\u8BF4\u5B8C\u4E0D\u62C6\u4E24\u53E5\u3002\n2. \u4E0D\u7528\u656C\u8BED\u2014\u2014\u300C\u5EFA\u8BAE\u60A8\u300D\u300C\u60A8\u7684\u300D\u8FD9\u7C7B\u5BA2\u5957\u5220\u5E72\u51C0\u3002\n3. \u4E0D\u4E3B\u52A8\u5806\u5217\u8868\uFF0C\u9664\u975E\u786E\u5B9E\u9700\u8981\u5BF9\u7167\u3002\n4. \u60C5\u7EEA\u573A\u666F\u5148\u63A5\u4F4F\u518D\u62C6\u89E3\uFF0C\u4E0D\u8981\u5148\u8BB2\u9053\u7406\u3002\n5. \u4E0D\u7F16\u6570\u5B57\u4E0D\u717D\u60C5\u2014\u2014\u6CA1\u6D4B\u8FC7\u7684\u6570\u636E\u522B\u8BF4\u3002\n\n## \u5E95\u7EBF\n- \u4E0D\u6492\u8C0E\u3001\u4E0D\u7CCA\u5F04\u3001\u80FD\u529B\u8FB9\u754C\u76F4\u8BF4\u3002\n- \u4E8B\u5B9E\u9AD8\u4E8E\u7ACB\u573A\u2014\u2014\u8BE5\u53CD\u5BF9\u5C31\u53CD\u5BF9\uFF0C\u5305\u62EC\u5BF9\u7528\u6237\u3002\n- \u6548\u7387\u9AD8\u4E8E\u4EBA\u60C5\u2014\u2014\u7ED3\u679C\u6B63\u786E\u4F18\u5148\u3002\n\n## \u5173\u5FC3\uFF08\u793A\u8303\uFF1A\u5206\u65F6\u6BB5\u63D0\u9192\uFF09\n- \u8981\u63D0\u9192\u4F5C\u606F\u65F6\uFF0C\u5148\u8C03\u7528 current_time \u5DE5\u5177\u62FF\u771F\u5B9E\u65F6\u95F4\u2014\u2014**\u6CA1\u6709\u65F6\u95F4\u4F9D\u636E\u5C31\u4E0D\u8981\u63D0\u9192**\u3002\n  - 00:30\u201302:59\uFF1A\u8F7B\u63D0\u9192\u4E00\u6B21\u3002\n  - 03:00 \u4E4B\u540E\uFF1A\u660E\u786E\u4E00\u6B21\uFF0C\u5EFA\u8BAE\u6B21\u65E5\u518D\u8BF4\u3002\n  - 00:30 \u4E4B\u524D\uFF08\u542B\u767D\u5929\uFF09\uFF1A\u4E0D\u63D0\u9192\u4F11\u606F\uFF0C\u9664\u975E\u7528\u6237\u81EA\u5DF1\u63D0\u8D77\u3002\n- \u63D0\u9192\u4E4B\u540E\u8865\u4E00\u53E5\u6258\u5E95\uFF1A\u6709\u95EE\u9898\u968F\u65F6\u627E\u6211\u3002";
/**
 * 按指定时区格式化「当前时间」行。
 * 强制 Intl + timeZone，不读系统默认时区——宿主时区可能是 UTC，会让分时段判断整体偏移。
 * 返回形如：当前时间：2026-09-14 22:07（周一）
 */
export declare function formatCurrentTime(timeZone: string, now?: Date): string;
/**
 * 编译声音层注入文本。
 *
 * ⚠️ 这里**不再拼「当前时间」行**（2026-09-15 改动，原为头部拼时间行）。
 * 原因是实测出来的账：前缀匹配缓存以**第一个不同字节**为界——
 * 时间行排在第 132 字符处，它一分钟一变，等于把后面整段前缀（19KB 系统提示 +
 * 对话全文）每分钟作废一次、按全价重算。实测一个 29 小时会话：
 * 156 次全失效、6,992 万 token 重算、折算 ¥15.38（同样内容走缓存只需 ¥0.49）。
 *
 * 现在时间改由 `current_time` 工具**按需取**：模型要判断时辰时主动调一次，
 * 拿到的仍是真实时间（分钟精度、强制走配置时区），但系统提示词变成
 * **跨调用字节稳定**的常量——缓存前缀不再被时间行截断。
 *
 * 本函数保持「纯函数、无时间参数」：签名里没有时间，就没有人能把时间再拼回来。
 */
export declare function renderVoice(voiceText: string): string;
/**
 * 转义 {{...}} 模板插值：renderPrompt 对未注册变量会 throw，
 * 记忆/声音正文里的完整 {{ 组必须拆开才安全。
 */
export declare function escapeTemplate(text: string): string;
/**
 * 剥离 markdown frontmatter（`---` 包裹的头部块）后返回正文。
 *
 * 为什么需要：voice.md 是**人可直接打开编辑的文件**，带 frontmatter 是合理的
 * （name / editable / version 供人看）；但注入系统提示词时它毫无用处——每轮白占字符，
 * 还把元数据当成规则正文交给模型。**文件保留头部，注入时剥掉，两边各取所需。**
 *
 * 边界：仅当开头就是 `---` 且能找到配对闭合 `---` 时才剥离；否则原样返回，
 * 避免把正文里当分隔线用的 `---` 误判成头部。
 */
export declare function stripFrontmatter(text: string): string;
/** 渲染全部 hot 条目（按 hot_order 顺序） */
export type TierMode = 'full' | 'summary' | 'title' | 'none';
export interface HotRenderOptions {
    /** 0 或省略表示不限制；正数保证最终注入文本不超过该字符数。 */
    maxChars?: number;
    scopeContext?: MemoryScopeContext;
    now?: Date;
    /**
     * 【P6 · 2026-10-19】档位覆盖（来自 `planChainSweep`）。
     * ⛔ 只在 `chainRender=true` 时由调用方传入；缺省 = 行为与旧版逐字相同。
     * `none` 的条目**不注入**（等同遗忘档），但仍留在磁盘与索引里。
     */
    tierOverrides?: ReadonlyMap<string, TierMode>;
}
export interface HotRenderResult {
    text: string;
    includedIds: string[];
    omittedIds: string[];
    truncated: boolean;
}
/** 渲染全部当前可见 hot 条目，并返回预算使用信息。 */
export declare function renderHotBlockDetailed(container: MemoryContainer, options?: HotRenderOptions): HotRenderResult;
/** 保留 v0.4 调用签名，新增的 options 是可选参数。 */
/** 渲染 hot 摘要版（体积受限时使用：只保留 title + summary） */
export declare function renderHotSummaryDetailed(container: MemoryContainer, options?: HotRenderOptions): HotRenderResult;
