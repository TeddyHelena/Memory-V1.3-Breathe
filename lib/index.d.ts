/**
 * dsh-memory-container 插件入口（Harness Cordis 插件 · 对外版本 V1.0）
 *
 * 对齐 Harness 真实插件 API（已对照 harness 源码逐一核实）：
 *   - 具名导出 { name, inject, Config, apply }
 *   - Config 用 @deepseek-ai/schemastery 的 zod
 *   - 工具注册：@deepseek-ai/dsh-tools 的 defineTool + ctx.tools.register
 *   - persona 注入：ctx.systemPrompt.section（注册表层，自动随 fiber 释放）
 *   - 生命周期：ctx.effect
 *
 * 人格化设计（记忆与声音分层）：
 *   - 声音层（强制人格，可编辑）：容器根目录 voice.md → section memory-container:voice (order 5)
 *     函数态：每轮装配重算并注入「当前时间」，催睡规则据此判断时段
 *   - 记忆层（hot 条目）：index.json hot_order → section memory-container:hot (order 10)
 *   - 长期记忆：memory_search / memory_load 工具按需检索
 *   - 写入闭环（V1.0）：memory_remember / memory_update / memory_forget / memory_propose
 *     仅在 allowWrite=true 时注册；写事务统一由 writer.ts 承担
 *
 * 设置页 UI：settings.plugins.tab 插槽 → 浏览器端「记忆」标签页，
 *   数据通道 = webServer HTTP API（GET /list、GET /entry/:id、PUT /entry/:id、
 *   POST /pending/:id/confirm、POST /pending/:id/discard）。
 *   client 半区见 src/client/，由 package.json dsh.client 声明加载。
 *
 * 安全边界：
 *   - 默认只读容器目录；写路径（PUT）仅当 allowEdit=true 时注册
 *   - 独立插件，fail-fast，异常只影响本插件
 */
import z from '@deepseek-ai/schemastery';
export declare const PRODUCT: {
    readonly package: "0.16.3+breathe.1120.4";
    readonly productVersion: "MemoryV1.3-Breathe";
    readonly baseline: "MemoryV1.3";
};
/** Cordis 插件名（loader diagnostics 使用） */
declare const name = "memory-container";
/**
 * 声明依赖的服务：工具注册表 + systemPrompt（persona 注入）+ webServer（设置页数据 API）
 * + **llm**（V1.1 增量② 的压缩接入点）。
 *
 * ⚠️ 这里曾漏声明 `llm`，后果是**静默**的：cordis 不注入未声明的服务，`ctx.llm` 取不到，
 * 压缩接入点解析为 null —— 插件照常工作、不报错，只是压缩能力永远不可用。
 * 压测时靠自检端点（GET /selftest 的 `compressor` 字段）才发现。
 * 参照官方 `compaction-basic` 的声明：`['llm', 'tokenMeter', 'sessions']`。
 */
declare const inject: string[];
/** 插件配置（zod schema，对齐 dsh 插件惯例） */
declare const Config: z<Schemastery.ObjectS<NoInfer<{
    /** 容器根目录（绝对路径） */
    containerRoot: z<string, string, "defined">;
    /** 是否注入 hot 记忆到 persona（默认 true） */
    injectPersona: z<boolean, boolean, "defined">;
    /** persona 注入模式: full=全文, summary=摘要 */
    personaMode: z<"full" | "summary", "full" | "summary", "defined">;
    /** 声音层文件（相对 containerRoot）。空字符串关闭声音层；文件缺失回退内置默认声音 */
    voiceFile: z<string, string, "defined">;
    /**
     * `current_time` 工具的默认时区（IANA 名）。
     * 强制走 Intl，不读系统默认时区——宿主时区若是 UTC，分时段判断会整体偏移。
     * 2026-09-15 起时间**不再注入系统提示词**（那会让缓存前缀每分钟作废），改为按需调工具。
     */
    timeZone: z<string, string, "defined">;
    /** memory_search 默认 topK */
    searchTopK: z<number, number, "defined">;
    /** 是否同时检索 archive（默认 false，只搜 longterm） */
    searchArchive: z<boolean, boolean, "defined">;
    /**
     * 库登记表（相对 containerRoot 的上一级 vault 根，或绝对路径）。
     * 空字符串 = 关闭「库文件参与检索」。默认指向 vault 根的 `_index/库登记表.md`。
     *
     * 为什么要它：库里有大批文件**不该进容器**（字符量太大、也不需要每轮被想起），
     * 但**必须能被找到**。这张表就是那批文件的目录（2026-09-30 设计）。
     */
    vaultRegistryFile: z<string, string, "defined">;
    /** vault 根目录；登记表里的路径相对它解析。空 = 用 containerRoot 的上一级 */
    vaultRoot: z<string, string, "defined">;
    /**
     * 库条目在混合排序里的**权重**（2026-09-30）。
     *
     * 为什么需要：两边是**两套打分器**——容器走 BM25，库走词频归一，
     * 量纲差一个数量级（实测容器 17.98 / 22.9，库 1.5~2.0）。
     * 不校准的话，**库条目除非「容器完全没命中」才露头**，等于白登记。
     *
     * **取舍要说清**：校准是把库的「本次最高分」顶到容器「本次最高分」同高——
     * 于是**弱命中也会被顶到满分**（实测：查「缓存命中率」时库最高分原始仅 0.43，
     * 校准后 = 17.98）。这不理想，但比"永远沉底"好。
     *
     * 默认 0.5（保守）：校准后再打五折，让库条目**能进榜但不霸榜**。
     * 设 1.0 = 等权；设 0 = 不参与排序（仍可被 memory_load 按 id 取到）。
     * ✅ 这个值**改配置即生效，不用重启**（profile 是热重载的）。
     */
    vaultHitWeight: z<number, number, "defined">;
    /**
     * 路由引擎开关（MemoryV1.1-Exact 的核心件，2026-09-30 移植自 V1.2）。
     *
     * 它做的事：按**本轮用户输入**做三层召回（身份卡 / 定向 BM25 / 联想涌现 1 跳），
     * 打分后选出 `main` 注入。
     *
     * ⚠️ **投递通道硬约束**：它每轮都变，**只能走 `ctx.systemPrompt.context()`**
     * （会话尾部自替换快照），**绝不能走 `section()`**——后者会让宿主每轮追加一整份
     * 系统提示词副本（V1.2 实测：36 轮 43 次 append、上下文 53% 是重复）。
     * 这条已写进 `src/injection.ts` 的契约表，`auditContract()` 会拦。
     */
    enableRoute: z<boolean, boolean, "defined">;
    /**
     * 【P0-5 · 2026-10-18】**自动扫描总开关**：同时管**启动扫描**与**定时自检**；
     * 手动 `/decay-sweep` **不受此开关管**。关闭时启动只落一行「未扫（开关）」。
     *
     * 原说明（goal ④ · 2026-10-14）：进程内每日自检，换日之后自动扫一次（默认开）。
     *
     * 为什么要有：扫描触发点此前**只有"宿主启动"** ⇒ 宿主连着开几天，那几天**一次都不扫**
     * （条目不会丢、只会继续变老，但退场会积压）。
     * ⛔ 为什么**不挂在请求上**：作者 拍过「**不在请求路径里改数据**」（请求是读的时刻）。
     *    定时自检不违背那条 —— 写盘时刻仍然**有界**：每进程最多每 10 分钟问一次，
     *    **真写只在换日之后发生一次**（闸门唯一权威 `runDueSweep` 判的）。
     */
    decayDailyCheck: z<boolean, boolean, "defined">;
    /**
     * 【P6 · 2026-10-19】**档位渲染开关（默认关）**。
     * 打开后按 `planChainSweep` 的档位决定注入形态：full→正文 / snapshot→摘要 / outline→标题 / forget→不注入。
     * ⛔ 默认关：开启前必须满足 `docs/BREATHE-P6-P8-ACTIVATION.md` 的条件（14 活跃日影子 + 缓存基线）。
     */
    chainRender: z<boolean, boolean, "defined">;
    /**
     * 【修复 · 2026-10-19】要求宿主会话上下文（默认关）。
     * 打开后：`exec.agent.session.id` 取不到 ⇒ **不回落进程级 id**，直接空来源 ⇒ writer 拒写。
     * 用途：并发/子代理场景下宁可拒写，也不把来源记到“最后说话的人”头上。
     */
    requireHostSession: z<boolean, boolean, "defined">;
    /**
     * 【P7 · 2026-10-19】**链级判据接管（默认关）**：单生产者 + 公示制 + 钉住。
     * ⛔ 打开前必须满足 docs/BREATHE-P6-P8-ACTIVATION.md 的条件；打开后 runSweep 的 moves 只来自 planChainSweep。
     */
    chainJudge: z<boolean, boolean, "defined">;
    /** 【P7】公示制（默认关）：濒死清单公示 N 个活跃日，沉默=同意。 */
    publicNotice: z<boolean, boolean, "defined">;
    /** 【P8】候选自动转正（默认关）：每活跃日 ≤3、真会话 id、相似度闸门。 */
    autoPromote: z<boolean, boolean, "defined">;
    /**
     * 【E3】是否把**真 fresh**（会话内轮次钟）接进打分。默认取 `fresh.ts` 的常量（当前 false）。
     * ⛔ 默认不开：接线会改变排序，必须经 作者 亲口批准才开（见 E3 窄口径施工单）。
     */
    freshFromTurnClock: z<boolean, boolean, "defined">;
    /** hot 注入字符硬预算；0 表示不限制。开启动态预算时它是**上限**，实际预算可能更小 */
    hotMaxChars: z<number, number, "defined">;
    /**
     * hot 注入字符**地板**（动态预算用）。窗口被占满时预算会算成 0，hot 段将被静默清空——
     * 地板保证任何情况下都保留最核心的常驻条目。0 = 不要地板（不推荐）。
     */
    hotMinChars: z<number, number, "defined">;
    /**
     * 动态预算（方案A）：把「窗口 − 上一轮实际用量」作为 hot 段预算的第二道上限。
     * true（默认）= 对话越长注入越少；false = 恒用 hotMaxChars（旧行为）。
     */
    dynamicBudget: z<boolean, boolean, "defined">;
    /**
     * 宿主上下文窗口（token）。**DSH 不暴露该值**（`TokenMeterConfig = Record<string, never>`），
     * 故由插件自持，默认 1M（与宿主窗口一致）。
     */
    contextWindow: z<number, number, "defined">;
    /**
     * token → 字符换算比（动态预算用）。默认 1.5：
     * DeepSeek 分词下 1 汉字约 0.6~0.7 token（1 token ≈ 1.4~1.7 字符），取偏保守值。
     */
    charsPerToken: z<number, number, "defined">;
    /** 压缩用 provider 路由 id（如 `deepseek-official`）。空 = 自动探测含 "deepseek" 的 provider */
    compressProvider: z<string, string, "defined">;
    /** 压缩用 model。空 = 取该 provider 的第一个可用模型 */
    compressModel: z<string, string, "defined">;
    /**
     * 压缩调用输出上限（token）。
     *
     * ⚠️ **默认值在 2026-09-24 被上调 4096 → 16384，原因是一次真实评测。**
     * （本条属 V1.1 线的"遗留尾巴"：压缩语义评测，见 CHANGELOG 同条目。）
     *
     * 默认模型 `deepseek-v4-flash` 是**推理型**，思考也吃 maxTokens。原默认 4096 的标定依据是：
     * 「1024 时 `finish=max-tokens`、reasoning 吃掉全部额度、正式输出为 0；
     *   同一输入同一提示词在 4096 下正常产出 60 字摘要。」
     *
     * **但那次标定用的是探针里内置的 120 字短样本。** 2026-09-24 的压缩语义评测
     * 换成真实记忆正文（实测 537 字）后，4096 重新变成"产出为 0"：
     *   - 537 字 × 短指令 × 4096 → ❌ 空产出
     *   - 537 字 × 长指令 × 4096 → ❌ 空产出
     *   - 537 字 × 长指令 × 16384 → ✅ 80 字摘要
     *   - 537 字 × 长指令 × 32768 → ✅ 127 字摘要（更详细）
     * 也就是说：**4096 只对"文本足够短"成立**，与指令长短无关。
     *
     * 这是本项目反复出现的那类失真 —— **短样本验证通过 → 结论外推到真实数据 → 静默失败**
     * （失败形态是 outputChars=0，调用"成功"、不报错、拿到的空字符串）。
     *
     * 新默认 16384 的依据：真实记忆正文量级 200~1500 字时留足推理额度；
     * 未超额度的部分不额外计费，属于"给够余量"而非"多花成本"。
     */
    compressMaxTokens: z<number, number, "defined">;
    /** hot_order 条数软上限（超限告警，不熔断）；字符硬预算仍由 hotMaxChars 把关 */
    maxHotEntries: z<number, number, "defined">;
    /**
     * 是否注册写入工具（remember/update/forget/propose）。默认 false = 只读容器。
     * 与 allowEdit（设置页 PUT 编辑）是两个独立开关：写工具与人工编辑可以分别开关。
     */
    allowWrite: z<boolean, boolean, "defined">;
    /** 是否允许物理删除（memory_forget 的 purge 模式）。默认 false，只墓碑 */
    allowPurge: z<boolean, boolean, "defined">;
    /**
     * HTTP API 共享 token（安全专项 §三-5）。
     *   'auto'（默认）= 启动时随机生成，注入页面供 GUI 使用；本机脚本需读 `apiTokenFile` 才能调
     *   'off'        = 不启用 token（仅排障用；此时只剩 Host/Origin 两层防护）
     *   其他字符串   = 用你给的字面量作为 token
     */
    apiToken: z<string, string, "defined">;
    /** token 落盘位置（'auto' 模式下写出，供本地脚本读取）。空字符串 = 不写文件 */
    apiTokenFile: z<string, string, "defined">;
    /**
     * 是否校验 Host / Origin 头（防 DNS rebinding 与 CSRF）。默认 true。
     * 关掉只在「确实需要从非 loopback 主机名访问」时使用——那等于放弃这两层。
     */
    guardHost: z<boolean, boolean, "defined">;
    /**
     * 检索时启用同义词扩展（P2）。默认开：实测 recall@5 92.1% → 95.2%，误召回不升。
     * 关掉即回落到纯 BM25，便于对照验证。
     */
    enableLexicon: z<boolean, boolean, "defined">;
    /**
     * 写入前做「用户原话比对」（P2）：直写内容必须能指到用户真正说过的片段，
     * 否则拒绝并提示改走 memory_propose。这是把「用户明说」从模型自觉拧成机械可验证。
     * 默认开；CLI/无会话上下文时不校验（否则 CLI 写入会被全拒）。
     */
    verifyUserQuote: z<boolean, boolean, "defined">;
    /** 当前工作区标识；仅匹配同 scope_id 的 workspace 记忆 */
    workspaceId: z<string, string, "defined">;
    /** 当前项目标识；仅匹配同 scope_id 的 project 记忆 */
    projectId: z<string, string, "defined">;
    /** 设置页 HTTP API 前缀（默认 /api/memory） */
    apiPrefix: z<string, string, "defined">;
    /** 是否启用写 API（PUT 编辑）。默认 false = 只读容器，保持安全边界 */
    allowEdit: z<boolean, boolean, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    /** 容器根目录（绝对路径） */
    containerRoot: z<string, string, "defined">;
    /** 是否注入 hot 记忆到 persona（默认 true） */
    injectPersona: z<boolean, boolean, "defined">;
    /** persona 注入模式: full=全文, summary=摘要 */
    personaMode: z<"full" | "summary", "full" | "summary", "defined">;
    /** 声音层文件（相对 containerRoot）。空字符串关闭声音层；文件缺失回退内置默认声音 */
    voiceFile: z<string, string, "defined">;
    /**
     * `current_time` 工具的默认时区（IANA 名）。
     * 强制走 Intl，不读系统默认时区——宿主时区若是 UTC，分时段判断会整体偏移。
     * 2026-09-15 起时间**不再注入系统提示词**（那会让缓存前缀每分钟作废），改为按需调工具。
     */
    timeZone: z<string, string, "defined">;
    /** memory_search 默认 topK */
    searchTopK: z<number, number, "defined">;
    /** 是否同时检索 archive（默认 false，只搜 longterm） */
    searchArchive: z<boolean, boolean, "defined">;
    /**
     * 库登记表（相对 containerRoot 的上一级 vault 根，或绝对路径）。
     * 空字符串 = 关闭「库文件参与检索」。默认指向 vault 根的 `_index/库登记表.md`。
     *
     * 为什么要它：库里有大批文件**不该进容器**（字符量太大、也不需要每轮被想起），
     * 但**必须能被找到**。这张表就是那批文件的目录（2026-09-30 设计）。
     */
    vaultRegistryFile: z<string, string, "defined">;
    /** vault 根目录；登记表里的路径相对它解析。空 = 用 containerRoot 的上一级 */
    vaultRoot: z<string, string, "defined">;
    /**
     * 库条目在混合排序里的**权重**（2026-09-30）。
     *
     * 为什么需要：两边是**两套打分器**——容器走 BM25，库走词频归一，
     * 量纲差一个数量级（实测容器 17.98 / 22.9，库 1.5~2.0）。
     * 不校准的话，**库条目除非「容器完全没命中」才露头**，等于白登记。
     *
     * **取舍要说清**：校准是把库的「本次最高分」顶到容器「本次最高分」同高——
     * 于是**弱命中也会被顶到满分**（实测：查「缓存命中率」时库最高分原始仅 0.43，
     * 校准后 = 17.98）。这不理想，但比"永远沉底"好。
     *
     * 默认 0.5（保守）：校准后再打五折，让库条目**能进榜但不霸榜**。
     * 设 1.0 = 等权；设 0 = 不参与排序（仍可被 memory_load 按 id 取到）。
     * ✅ 这个值**改配置即生效，不用重启**（profile 是热重载的）。
     */
    vaultHitWeight: z<number, number, "defined">;
    /**
     * 路由引擎开关（MemoryV1.1-Exact 的核心件，2026-09-30 移植自 V1.2）。
     *
     * 它做的事：按**本轮用户输入**做三层召回（身份卡 / 定向 BM25 / 联想涌现 1 跳），
     * 打分后选出 `main` 注入。
     *
     * ⚠️ **投递通道硬约束**：它每轮都变，**只能走 `ctx.systemPrompt.context()`**
     * （会话尾部自替换快照），**绝不能走 `section()`**——后者会让宿主每轮追加一整份
     * 系统提示词副本（V1.2 实测：36 轮 43 次 append、上下文 53% 是重复）。
     * 这条已写进 `src/injection.ts` 的契约表，`auditContract()` 会拦。
     */
    enableRoute: z<boolean, boolean, "defined">;
    /**
     * 【P0-5 · 2026-10-18】**自动扫描总开关**：同时管**启动扫描**与**定时自检**；
     * 手动 `/decay-sweep` **不受此开关管**。关闭时启动只落一行「未扫（开关）」。
     *
     * 原说明（goal ④ · 2026-10-14）：进程内每日自检，换日之后自动扫一次（默认开）。
     *
     * 为什么要有：扫描触发点此前**只有"宿主启动"** ⇒ 宿主连着开几天，那几天**一次都不扫**
     * （条目不会丢、只会继续变老，但退场会积压）。
     * ⛔ 为什么**不挂在请求上**：作者 拍过「**不在请求路径里改数据**」（请求是读的时刻）。
     *    定时自检不违背那条 —— 写盘时刻仍然**有界**：每进程最多每 10 分钟问一次，
     *    **真写只在换日之后发生一次**（闸门唯一权威 `runDueSweep` 判的）。
     */
    decayDailyCheck: z<boolean, boolean, "defined">;
    /**
     * 【P6 · 2026-10-19】**档位渲染开关（默认关）**。
     * 打开后按 `planChainSweep` 的档位决定注入形态：full→正文 / snapshot→摘要 / outline→标题 / forget→不注入。
     * ⛔ 默认关：开启前必须满足 `docs/BREATHE-P6-P8-ACTIVATION.md` 的条件（14 活跃日影子 + 缓存基线）。
     */
    chainRender: z<boolean, boolean, "defined">;
    /**
     * 【修复 · 2026-10-19】要求宿主会话上下文（默认关）。
     * 打开后：`exec.agent.session.id` 取不到 ⇒ **不回落进程级 id**，直接空来源 ⇒ writer 拒写。
     * 用途：并发/子代理场景下宁可拒写，也不把来源记到“最后说话的人”头上。
     */
    requireHostSession: z<boolean, boolean, "defined">;
    /**
     * 【P7 · 2026-10-19】**链级判据接管（默认关）**：单生产者 + 公示制 + 钉住。
     * ⛔ 打开前必须满足 docs/BREATHE-P6-P8-ACTIVATION.md 的条件；打开后 runSweep 的 moves 只来自 planChainSweep。
     */
    chainJudge: z<boolean, boolean, "defined">;
    /** 【P7】公示制（默认关）：濒死清单公示 N 个活跃日，沉默=同意。 */
    publicNotice: z<boolean, boolean, "defined">;
    /** 【P8】候选自动转正（默认关）：每活跃日 ≤3、真会话 id、相似度闸门。 */
    autoPromote: z<boolean, boolean, "defined">;
    /**
     * 【E3】是否把**真 fresh**（会话内轮次钟）接进打分。默认取 `fresh.ts` 的常量（当前 false）。
     * ⛔ 默认不开：接线会改变排序，必须经 作者 亲口批准才开（见 E3 窄口径施工单）。
     */
    freshFromTurnClock: z<boolean, boolean, "defined">;
    /** hot 注入字符硬预算；0 表示不限制。开启动态预算时它是**上限**，实际预算可能更小 */
    hotMaxChars: z<number, number, "defined">;
    /**
     * hot 注入字符**地板**（动态预算用）。窗口被占满时预算会算成 0，hot 段将被静默清空——
     * 地板保证任何情况下都保留最核心的常驻条目。0 = 不要地板（不推荐）。
     */
    hotMinChars: z<number, number, "defined">;
    /**
     * 动态预算（方案A）：把「窗口 − 上一轮实际用量」作为 hot 段预算的第二道上限。
     * true（默认）= 对话越长注入越少；false = 恒用 hotMaxChars（旧行为）。
     */
    dynamicBudget: z<boolean, boolean, "defined">;
    /**
     * 宿主上下文窗口（token）。**DSH 不暴露该值**（`TokenMeterConfig = Record<string, never>`），
     * 故由插件自持，默认 1M（与宿主窗口一致）。
     */
    contextWindow: z<number, number, "defined">;
    /**
     * token → 字符换算比（动态预算用）。默认 1.5：
     * DeepSeek 分词下 1 汉字约 0.6~0.7 token（1 token ≈ 1.4~1.7 字符），取偏保守值。
     */
    charsPerToken: z<number, number, "defined">;
    /** 压缩用 provider 路由 id（如 `deepseek-official`）。空 = 自动探测含 "deepseek" 的 provider */
    compressProvider: z<string, string, "defined">;
    /** 压缩用 model。空 = 取该 provider 的第一个可用模型 */
    compressModel: z<string, string, "defined">;
    /**
     * 压缩调用输出上限（token）。
     *
     * ⚠️ **默认值在 2026-09-24 被上调 4096 → 16384，原因是一次真实评测。**
     * （本条属 V1.1 线的"遗留尾巴"：压缩语义评测，见 CHANGELOG 同条目。）
     *
     * 默认模型 `deepseek-v4-flash` 是**推理型**，思考也吃 maxTokens。原默认 4096 的标定依据是：
     * 「1024 时 `finish=max-tokens`、reasoning 吃掉全部额度、正式输出为 0；
     *   同一输入同一提示词在 4096 下正常产出 60 字摘要。」
     *
     * **但那次标定用的是探针里内置的 120 字短样本。** 2026-09-24 的压缩语义评测
     * 换成真实记忆正文（实测 537 字）后，4096 重新变成"产出为 0"：
     *   - 537 字 × 短指令 × 4096 → ❌ 空产出
     *   - 537 字 × 长指令 × 4096 → ❌ 空产出
     *   - 537 字 × 长指令 × 16384 → ✅ 80 字摘要
     *   - 537 字 × 长指令 × 32768 → ✅ 127 字摘要（更详细）
     * 也就是说：**4096 只对"文本足够短"成立**，与指令长短无关。
     *
     * 这是本项目反复出现的那类失真 —— **短样本验证通过 → 结论外推到真实数据 → 静默失败**
     * （失败形态是 outputChars=0，调用"成功"、不报错、拿到的空字符串）。
     *
     * 新默认 16384 的依据：真实记忆正文量级 200~1500 字时留足推理额度；
     * 未超额度的部分不额外计费，属于"给够余量"而非"多花成本"。
     */
    compressMaxTokens: z<number, number, "defined">;
    /** hot_order 条数软上限（超限告警，不熔断）；字符硬预算仍由 hotMaxChars 把关 */
    maxHotEntries: z<number, number, "defined">;
    /**
     * 是否注册写入工具（remember/update/forget/propose）。默认 false = 只读容器。
     * 与 allowEdit（设置页 PUT 编辑）是两个独立开关：写工具与人工编辑可以分别开关。
     */
    allowWrite: z<boolean, boolean, "defined">;
    /** 是否允许物理删除（memory_forget 的 purge 模式）。默认 false，只墓碑 */
    allowPurge: z<boolean, boolean, "defined">;
    /**
     * HTTP API 共享 token（安全专项 §三-5）。
     *   'auto'（默认）= 启动时随机生成，注入页面供 GUI 使用；本机脚本需读 `apiTokenFile` 才能调
     *   'off'        = 不启用 token（仅排障用；此时只剩 Host/Origin 两层防护）
     *   其他字符串   = 用你给的字面量作为 token
     */
    apiToken: z<string, string, "defined">;
    /** token 落盘位置（'auto' 模式下写出，供本地脚本读取）。空字符串 = 不写文件 */
    apiTokenFile: z<string, string, "defined">;
    /**
     * 是否校验 Host / Origin 头（防 DNS rebinding 与 CSRF）。默认 true。
     * 关掉只在「确实需要从非 loopback 主机名访问」时使用——那等于放弃这两层。
     */
    guardHost: z<boolean, boolean, "defined">;
    /**
     * 检索时启用同义词扩展（P2）。默认开：实测 recall@5 92.1% → 95.2%，误召回不升。
     * 关掉即回落到纯 BM25，便于对照验证。
     */
    enableLexicon: z<boolean, boolean, "defined">;
    /**
     * 写入前做「用户原话比对」（P2）：直写内容必须能指到用户真正说过的片段，
     * 否则拒绝并提示改走 memory_propose。这是把「用户明说」从模型自觉拧成机械可验证。
     * 默认开；CLI/无会话上下文时不校验（否则 CLI 写入会被全拒）。
     */
    verifyUserQuote: z<boolean, boolean, "defined">;
    /** 当前工作区标识；仅匹配同 scope_id 的 workspace 记忆 */
    workspaceId: z<string, string, "defined">;
    /** 当前项目标识；仅匹配同 scope_id 的 project 记忆 */
    projectId: z<string, string, "defined">;
    /** 设置页 HTTP API 前缀（默认 /api/memory） */
    apiPrefix: z<string, string, "defined">;
    /** 是否启用写 API（PUT 编辑）。默认 false = 只读容器，保持安全边界 */
    allowEdit: z<boolean, boolean, "defined">;
}>>, "plain">;
/**
 * 插件入口。
 * 注意：不要写成 async function（Cordis 4 会把带 prototype 的普通函数当构造器，
 * 返回的 Promise 不会被当作启动工作）。同步 apply + 内部同步加载即可。
 */
/**
 * **token 取值（`apiToken: 'auto'` 时）—— 跨重载保持不变**（2026-10-16 · 作者 拍）。
 *
 * ## 为什么（真身实测的坑）
 * 修前：每次插件 `apply` 都 `randomBytes(24)` **重新生成** ⇒
 *   · 宿主**每次重载都换 token**（插件管理器检测到 profile/配置变化会自己重载，例如今天 10:04 与 13:41 各一次）；
 *   · 而浏览器里那个页面是**更早加载的**，`globalThis.__DSH_MEMORY_TOKEN__` 还是旧的；
 *   · 客户端所有请求被 401 拒 ⇒ **面板静默变空**（球 0 节点 ⇒ 连线全无），
 *     提示只有一句「缺少或错误的 x-memory-token」，而面板的「重试」拿的还是旧 token ⇒ 重试也白搭。
 *   ⇒ 症状看起来像"界面被改坏了"，实际是**鉴权被换掉了**。
 *
 * ## 口径
 * `auto` = **首次生成、之后复用**：已有合规 token（`apiTokenFile` 里的一行）就直接用，
 * 没有或不合规才生成新的。⛔ `apiToken: 'off'` 仍是空；⛔ 显式给的字符串**始终优先**（本函数不参与）。
 *
 * ## 安全边界（如实说）
 * 不再"每次重生" ⇒ token 的生命周期变长。但它本来就落在 `0600` 的本机文件里
 * （`apiTokenFile`），能读那个文件的攻击者本来就能读容器明文 —— **没有降低实际门槛**。
 */
export declare function resolveAutoToken(existingFileRaw: string | null): string;
declare function apply(ctx: any, config: any): void;
export { name, inject, Config, apply };
