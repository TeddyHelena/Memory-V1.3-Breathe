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
 * memory 插件的注入契约。**新增任何注入段，先在这里登记，再去注册。**
 */
export const CHANNEL_CONTRACT = [
    {
        name: 'memory-container:voice',
        channel: 'systemPrompt',
        // ⚠️ 定级理由（2026-10-03 改）：原定 `coldStart`（"本会话内必须字节不变，变了就是 bug"），
        //    但它**每轮重读 voice.md**，而人工编辑 voice.md 是已登记的合法触发条件 ——
        //    两句话互相矛盾：既说"变了就是 bug"，又把"人改了"写成批准原因。
        //    按事实定级：**变化合法（人工编辑），但必须登记原因** = `stable`。
        //    同时记账侧改成"只有源文件真的变了才算已登记原因"（index.ts），守卫这才咬得动。
        stability: 'stable',
        changeTriggers: ['voiceFile 内容被人工编辑（需重启或下一轮重读后**接受一次**重算）'],
        mutatesCacheUnit: '整条系统提示词（字节）',
        order: 5,
        onMissing: '回退内置默认声音（不中断装配）',
    },
    {
        name: 'memory-container:hot',
        channel: 'systemPrompt',
        stability: 'stable',
        changeTriggers: ['记忆写入置脏（hotCacheDirty）', '动态预算收缩导致预算字符数变化'],
        mutatesCacheUnit: '整条系统提示词（字节）',
        order: 10,
        onMissing: '记忆层为空——模型看不到常驻条目',
    },
    {
        name: 'memory-container:route',
        channel: 'runtimeContext',
        stability: 'volatile',
        changeTriggers: ['每轮用户输入变化（这是它的职责）'],
        // 关键：它走自替换快照，**不进**可缓存前缀
        mutatesCacheUnit: '会话尾部的 runtime-context 快照（自替换，不动系统提示词）',
        order: 50,
        onMissing: '动态召回为空，无【本轮唤起】',
        // ★ 这一条是 MemoryV1.1-Exact 落地时加的（2026-09-30）：
        //   V1.2 当年就是把它挂进了 `systemPrompt.section({order:50})`，代价实测
        //   36 轮被追加 43 份副本、上下文 53% 是重复。契约表存在的意义就是拦这个——
        //   `auditContract()` 对「volatile 走 systemPrompt」直接报错。
        note: '仅当 enableRoute=true 时注册；**必须走 context()**，改回 section() 会被契约自检拦下',
    },
];
// ════════════════════════════════════════════════════════════
// 二、两条判据（可执行形式）
// ════════════════════════════════════════════════════════════
/**
 * 判据一：**缓存单元 = 整条系统提示词。**
 *
 * 这句话写成函数，是为了让「按 section 算账」这种错法在代码评审里一眼可见：
 * 任何按 section 折算成本的推理，都要先经过这里 —— 而这里只认整条。
 */
export function cacheUnit() {
    return {
        unit: 'systemMessage',
        note: '整条系统提示词按字节比较；section / order / 位置都不改变这个单元',
    };
}
export function validateDeclaration(decl) {
    const issues = [];
    if (!decl.cacheUnit || decl.cacheUnit.trim().length === 0) {
        issues.push('未声明「改的是哪个缓存单元」');
    }
    if (typeof decl.changesEveryTurn !== 'boolean') {
        issues.push('未声明「是否每轮变化」');
    }
    return issues;
}
/** 契约表自检：每一条都必须能通过判据二。 */
export function auditContract(contracts = CHANNEL_CONTRACT) {
    const problems = [];
    const seen = new Set();
    for (const c of contracts) {
        if (seen.has(c.name))
            problems.push(`重名契约：${c.name}`);
        seen.add(c.name);
        if (c.stability === 'volatile' && c.channel === 'systemPrompt') {
            problems.push(`${c.name}：volatile 内容走 systemPrompt 通道 —— 这会让宿主每轮追加一整份副本（缓存单元 = 整条系统提示词）`);
        }
        if (c.stability !== 'volatile' && c.changeTriggers.length === 0) {
            problems.push(`${c.name}：非 volatile 却没写任何批准的变化触发条件`);
        }
        if (!c.mutatesCacheUnit.trim())
            problems.push(`${c.name}：未声明改的是哪个缓存单元`);
    }
    return problems;
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
export class AssemblyLedger {
    state = new Map();
    violations = [];
    observe(name, obs) {
        const prev = this.state.get(name);
        const entry = prev ?? { observations: 0, changes: 0, violations: 0, lastChars: -1 };
        entry.observations += 1;
        if (entry.lastChars >= 0 && entry.lastChars !== obs.chars) {
            entry.changes += 1;
            if (!obs.expected) {
                entry.violations += 1;
                const msg = `契约违反：${name} 在未登记原因的情况下变化（${entry.lastChars} → ${obs.chars} 字符）`;
                // 只在首次违规时留告警文案，避免刷屏；违规计数照样累加
                if (entry.violations === 1)
                    this.violations.push(msg);
            }
        }
        entry.lastChars = obs.chars;
        this.state.set(name, entry);
    }
    // ⚠️ 这里**故意没有** "整条系统提示词字节数" 的字段。
    //   插件侧看不到宿主拼好后的完整文本（它只拿到自己那几段的函数调用），
    //   硬塞一个恒为 0 的字段，就是"看起来在跟踪、其实是零"——本项目反复出现的那个病。
    //   整条字节数只能在**会话日志**里量（system/message 事件），属 O-2 采集器的活。
    snapshot() {
        return {
            channels: Object.fromEntries([...this.state.entries()].map(([k, v]) => [k, { ...v }])),
            violations: [...this.violations],
        };
    }
    reset() {
        this.state.clear();
        this.violations.length = 0;
    }
}
