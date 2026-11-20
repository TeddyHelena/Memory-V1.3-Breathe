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
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { MemoryContainer } from './container.js';
import { createMemoryApi } from './api.js';
import { truthMark } from './truth-mark.js';
import { AssemblyLedger, CHANNEL_CONTRACT, auditContract } from './injection.js';
import { buildIdentity, captureBuild } from './build-identity.js';
import { dayKey, getDayTimeZone, parseInstant, setDayTimeZone } from './day-boundary.js';
import { ActiveDaysLog, activeDayKey, eventTimeOf } from './active-days.js';
import { SubjectStore, isQuestionForm } from './subjects.js';
import { appendEvent } from './event-log.js';
import { noteInjection, recordLlmReceipt, recordLlmUsage } from './llm-receipts.js';
import { computeTierOverrides, chainRenderBaselineOk } from './chain-render.js';
import { buildExactUiHtml } from './ui-html.js';
import { ChainStore } from './chains.js';
import { emptyDecayPlan, planPublicationBatch } from './publication.js';
import { loadPins, setPin } from './pins.js';
import { readEvents } from './event-log.js';
import { selectPromotable } from './promotion.js';
import { chainPlanToDecayPlan } from './chain-adapter.js';
import { monitorStartup, monitorSwitchOff, readStartups, setMonitorTimeZone } from './decay-monitor.js';
import { InjectionLedger } from './injection-ledger.js';
import { onboardingState } from './onboarding.js';
import { IDENTITY_FIELDS, readIdentity } from './identity.js';
import { E3_WEIGHTS, FRESH_PARAMS, FRESH_WIRING_DEFAULT, freshOf } from './route/fresh.js';
/**
 * **版本口径的唯一真源**（⛔ 不许在别处再写一遍）。
 * 为什么要提成常量：我在 C-0 里一度把 `productVersion` 硬写进 API 调用 —— 那就是"两个真源"，
 * 而这个仓已经因为"两处要同步"栽过多次（checksum / 索引 / 挂载模板 / 版本号本身）。
 * ⚠️ 版本号归 作者 拍板，改这里要同时动 package.json / README / 插件管理器 overrides。
 */
/** 【goal ④】每日自检的问询间隔：10 分钟（问询不写盘；真写只在换日之后一次） */
const DECAY_DAILY_CHECK_MS = 10 * 60_000;
// ⭐【2026-10-15】**对外版本号改为 `MemoryV1.3-Lite`** —— 这一版的交付形态就是 Lite（瘦身/收口那一版）。
//   ⛔ `baseline` **不动**：它的语义是「同源锚点」（登记口径原文：「锚点不随小版本动」）。
//   ⚠️ 回滚口径照旧（见下面那处注释）：把 `productVersion` 改回上一个字符串即可，**代码无需回退**。
//   ⚠️ 改了它 ⇒ `lib` 变 ⇒ **必须重启 DSH 才生效**（`post-deploy-check` 会报「动作人」）。
export const PRODUCT = { package: '0.16.3+breathe.1120.1', productVersion: 'MemoryV1.3-Breathe', baseline: 'MemoryV1.3' };
import { elapsed } from './route/clock.js';
import { boundaryPassed, computeNextBoundary, makeRevisionProbe } from './hot-invalidation.js';
import { WriteError } from './idem.js';
import { DEFAULT_VOICE, escapeTemplate, renderHotBlockDetailed, renderHotSummaryDetailed, renderVoice, stripFrontmatter, } from './persona.js';
import { isInScope, memoryScope, temporalState } from './policy.js';
import { searchLongterm, withoutUndefined } from './search.js';
import { loadVaultRegistry, scoreRegistry } from './vault-registry.js';
import { Router } from './route/router.js';
import { DEFAULT_ROUTE_CONFIG } from './route/types.js';
import { RouteDashboard } from './route/dashboard.js';
import { SessionBuffer } from './session-buffer.js';
import { currentTime } from './time-tool.js';
import { MemoryWriter, reconcilePurgeTrash } from './writer.js';
import { TokenBudget, usageFromSessionEvent } from './budget.js';
import { createCompressor } from './llm.js';
import { planDecaySweep, sweepEntries } from './decay.js';
import { runDueSweep, auditHealth, checkSweepState, readAudit, readSweepStateEx, readSweepStateCompat, resolveGateSnapshot } from './decay-sweep.js';
import { readIncompleteSweeps } from './decay-log.js';
/** Cordis 插件名（loader diagnostics 使用） */
const name = 'memory-container';
/**
 * 声明依赖的服务：工具注册表 + systemPrompt（persona 注入）+ webServer（设置页数据 API）
 * + **llm**（V1.1 增量② 的压缩接入点）。
 *
 * ⚠️ 这里曾漏声明 `llm`，后果是**静默**的：cordis 不注入未声明的服务，`ctx.llm` 取不到，
 * 压缩接入点解析为 null —— 插件照常工作、不报错，只是压缩能力永远不可用。
 * 压测时靠自检端点（GET /selftest 的 `compressor` 字段）才发现。
 * 参照官方 `compaction-basic` 的声明：`['llm', 'tokenMeter', 'sessions']`。
 */
const inject = ['tools', 'systemPrompt', 'webServer', 'llm'];
/** 插件配置（zod schema，对齐 dsh 插件惯例） */
const Config = z.object({
    /** 容器根目录（绝对路径） */
    containerRoot: z.string().required(),
    /** 是否注入 hot 记忆到 persona（默认 true） */
    injectPersona: z.boolean().default(true),
    /** persona 注入模式: full=全文, summary=摘要 */
    personaMode: z.union([z.const('full'), z.const('summary')]).default('full'),
    /** 声音层文件（相对 containerRoot）。空字符串关闭声音层；文件缺失回退内置默认声音 */
    voiceFile: z.string().default('voice.md'),
    /**
     * `current_time` 工具的默认时区（IANA 名）。
     * 强制走 Intl，不读系统默认时区——宿主时区若是 UTC，分时段判断会整体偏移。
     * 2026-09-15 起时间**不再注入系统提示词**（那会让缓存前缀每分钟作废），改为按需调工具。
     */
    timeZone: z.string().default('Asia/Shanghai'),
    /** memory_search 默认 topK */
    searchTopK: z.number().default(5),
    /** 是否同时检索 archive（默认 false，只搜 longterm） */
    searchArchive: z.boolean().default(false),
    /**
     * 库登记表（相对 containerRoot 的上一级 vault 根，或绝对路径）。
     * 空字符串 = 关闭「库文件参与检索」。默认指向 vault 根的 `_index/库登记表.md`。
     *
     * 为什么要它：库里有大批文件**不该进容器**（字符量太大、也不需要每轮被想起），
     * 但**必须能被找到**。这张表就是那批文件的目录（2026-09-30 设计）。
     */
    vaultRegistryFile: z.string().default('_index/库登记表.md'),
    /** vault 根目录；登记表里的路径相对它解析。空 = 用 containerRoot 的上一级 */
    vaultRoot: z.string().default(''),
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
    vaultHitWeight: z.number().default(0.5),
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
    enableRoute: z.boolean().default(false),
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
    decayDailyCheck: z.boolean().default(true),
    /**
     * 【P6 · 2026-10-19】**档位渲染开关（默认关）**。
     * 打开后按 `planChainSweep` 的档位决定注入形态：full→正文 / snapshot→摘要 / outline→标题 / forget→不注入。
     * ⛔ 默认关：开启前必须满足 `docs/BREATHE-P6-P8-ACTIVATION.md` 的条件（14 活跃日影子 + 缓存基线）。
     */
    chainRender: z.boolean().default(false),
    /**
     * 【修复 · 2026-10-19】要求宿主会话上下文（默认关）。
     * 打开后：`exec.agent.session.id` 取不到 ⇒ **不回落进程级 id**，直接空来源 ⇒ writer 拒写。
     * 用途：并发/子代理场景下宁可拒写，也不把来源记到“最后说话的人”头上。
     */
    requireHostSession: z.boolean().default(false),
    /**
     * 【P7 · 2026-10-19】**链级判据接管（默认关）**：单生产者 + 公示制 + 钉住。
     * ⛔ 打开前必须满足 docs/BREATHE-P6-P8-ACTIVATION.md 的条件；打开后 runSweep 的 moves 只来自 planChainSweep。
     */
    chainJudge: z.boolean().default(false),
    /** 【P7】公示制（默认关）：濒死清单公示 N 个活跃日，沉默=同意。 */
    publicNotice: z.boolean().default(false),
    /** 【P8】候选自动转正（默认关）：每活跃日 ≤3、真会话 id、相似度闸门。 */
    autoPromote: z.boolean().default(false),
    /**
     * 【E3】是否把**真 fresh**（会话内轮次钟）接进打分。默认取 `fresh.ts` 的常量（当前 false）。
     * ⛔ 默认不开：接线会改变排序，必须经 作者 亲口批准才开（见 E3 窄口径施工单）。
     */
    freshFromTurnClock: z.boolean().default(FRESH_WIRING_DEFAULT),
    /** hot 注入字符硬预算；0 表示不限制。开启动态预算时它是**上限**，实际预算可能更小 */
    hotMaxChars: z.number().default(16000),
    /**
     * hot 注入字符**地板**（动态预算用）。窗口被占满时预算会算成 0，hot 段将被静默清空——
     * 地板保证任何情况下都保留最核心的常驻条目。0 = 不要地板（不推荐）。
     */
    hotMinChars: z.number().default(2000),
    /**
     * 动态预算（方案A）：把「窗口 − 上一轮实际用量」作为 hot 段预算的第二道上限。
     * true（默认）= 对话越长注入越少；false = 恒用 hotMaxChars（旧行为）。
     */
    dynamicBudget: z.boolean().default(true),
    /**
     * 宿主上下文窗口（token）。**DSH 不暴露该值**（`TokenMeterConfig = Record<string, never>`），
     * 故由插件自持，默认 1M（与宿主窗口一致）。
     */
    contextWindow: z.number().default(1_000_000),
    /**
     * token → 字符换算比（动态预算用）。默认 1.5：
     * DeepSeek 分词下 1 汉字约 0.6~0.7 token（1 token ≈ 1.4~1.7 字符），取偏保守值。
     */
    charsPerToken: z.number().default(1.5),
    /** 压缩用 provider 路由 id（如 `deepseek-official`）。空 = 自动探测含 "deepseek" 的 provider */
    compressProvider: z.string().default(''),
    /** 压缩用 model。空 = 取该 provider 的第一个可用模型 */
    compressModel: z.string().default(''),
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
    compressMaxTokens: z.number().default(16384),
    /** hot_order 条数软上限（超限告警，不熔断）；字符硬预算仍由 hotMaxChars 把关 */
    maxHotEntries: z.number().default(12),
    /**
     * 是否注册写入工具（remember/update/forget/propose）。默认 false = 只读容器。
     * 与 allowEdit（设置页 PUT 编辑）是两个独立开关：写工具与人工编辑可以分别开关。
     */
    allowWrite: z.boolean().default(false),
    /** 是否允许物理删除（memory_forget 的 purge 模式）。默认 false，只墓碑 */
    allowPurge: z.boolean().default(false),
    /**
     * HTTP API 共享 token（安全专项 §三-5）。
     *   'auto'（默认）= 启动时随机生成，注入页面供 GUI 使用；本机脚本需读 `apiTokenFile` 才能调
     *   'off'        = 不启用 token（仅排障用；此时只剩 Host/Origin 两层防护）
     *   其他字符串   = 用你给的字面量作为 token
     */
    apiToken: z.string().default('auto'),
    /** token 落盘位置（'auto' 模式下写出，供本地脚本读取）。空字符串 = 不写文件 */
    apiTokenFile: z.string().default(''),
    /**
     * 是否校验 Host / Origin 头（防 DNS rebinding 与 CSRF）。默认 true。
     * 关掉只在「确实需要从非 loopback 主机名访问」时使用——那等于放弃这两层。
     */
    guardHost: z.boolean().default(true),
    /**
     * 检索时启用同义词扩展（P2）。默认开：实测 recall@5 92.1% → 95.2%，误召回不升。
     * 关掉即回落到纯 BM25，便于对照验证。
     */
    enableLexicon: z.boolean().default(true),
    /**
     * 写入前做「用户原话比对」（P2）：直写内容必须能指到用户真正说过的片段，
     * 否则拒绝并提示改走 memory_propose。这是把「用户明说」从模型自觉拧成机械可验证。
     * 默认开；CLI/无会话上下文时不校验（否则 CLI 写入会被全拒）。
     */
    verifyUserQuote: z.boolean().default(true),
    /** 当前工作区标识；仅匹配同 scope_id 的 workspace 记忆 */
    workspaceId: z.string().default(''),
    /** 当前项目标识；仅匹配同 scope_id 的 project 记忆 */
    projectId: z.string().default(''),
    /** 设置页 HTTP API 前缀（默认 /api/memory） */
    apiPrefix: z.string().default('/api/memory'),
    /** 是否启用写 API（PUT 编辑）。默认 false = 只读容器，保持安全边界 */
    allowEdit: z.boolean().default(false),
});
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
export function resolveAutoToken(existingFileRaw) {
    const existing = String(existingFileRaw ?? '').trim();
    if (/^[a-f0-9]{32,}$/.test(existing))
        return existing; // 合规 ⇒ 复用（跨重载不变）
    return randomBytes(24).toString('hex'); // 缺失/不合规 ⇒ 生成新的
}
function apply(ctx, config) {
    const logger = ctx.logger('memory-container');
    /**
     * 宿主是否提供事件系统（ctx.on）。用途有二：
     *   ① 原文比对要靠 `session/event` 拿用户原话
     *   ② API token 要靠 `webserver/index-inject` 注入页面
     * 缺失时两项都降级并告警——**不让插件因宿主能力缺失而崩**，但也不假装它们在生效。
     */
    const canListen = typeof ctx.on === 'function';
    // L3 实际输入收据：只在最终 llm/stream 边界记录 hash；失败不影响请求。
    if (canListen) {
        try {
            ctx.on('llm/stream', (options, next) => {
                let receipt = null;
                try {
                    receipt = recordLlmReceipt(config.containerRoot, options);
                }
                catch { /* 收据失败不影响模型 */ }
                const upstream = next();
                return (async function* () {
                    for await (const chunk of upstream) {
                        try {
                            if (receipt && chunk && chunk.type === 'usage' && chunk.usage) {
                                recordLlmUsage(config.containerRoot, receipt.request_id, chunk.usage);
                            }
                        }
                        catch { /* usage 记录失败不阻断流 */ }
                        yield chunk;
                    }
                })();
            }, { global: true });
        }
        catch (e) {
            logger.warn(`llm/stream 收据挂载失败：${String(e)}`);
        }
    }
    /**
     * **观测口哨兵**：容器根下存在 `diag-tap.on` ⇒ 落事件形状到 `diag-session-events.jsonl`。
     *
     * ## 为什么是**文件**而不是配置键（2026-10-16 实测教训）
     * 第一版做成 `diagEventTap` 配置项写进 profile ⇒ **宿主重载时把这个新键吃掉了**
     * （`lib` 里有、进程加载的也是这份、盘上配置也写了，进程内却始终读不到）。
     * 观测口若要靠"重读配置"才生效，就等于把排障能力挂在**正是要排障的那条链**上。
     * ⇒ 哨兵：运维放/删一个文件即可，⛔ **不需要重启、不需要重载配置**。
     *
     * ## 什么时候用它
     * 只有当"某个读数说不清是好是坏"（例：`route.rounds` 在涨却 `injected=0`）时才放它，
     * 量完就删。⛔ 它不是常驻件。
     * ⚠️ TTL 60s：`session/event` 在热路径上，⛔ 不每条事件都 stat；临时开关的滞后无所谓。
     */
    let diagTapCache = { at: 0, on: false };
    const DIAG_TAP_SENTINEL = 'diag-tap.on';
    function diagTapWanted() {
        const now = Date.now();
        if (now - diagTapCache.at < 60_000)
            return diagTapCache.on;
        let on = false;
        try {
            on = fs.existsSync(path.join(config.containerRoot, DIAG_TAP_SENTINEL));
        }
        catch {
            on = false;
        }
        diagTapCache = { at: now, on };
        return on;
    }
    const scopeContext = {
        workspaceId: config.workspaceId || undefined,
        projectId: config.projectId || undefined,
    };
    /**
     * 【D0 · 部署状态物化】启动时捕获一次"我加载的是哪个构建"。
     * 为什么必须有：插件目录是软链、`lib/` 就是生产加载路径 ⇒
     * **改了盘上的代码不重启等于没改**，而以前只能靠人去比 productVersion 字符串。
     * 判据进 `/selftest → data.build`：`stale: true` = 盘上已换、进程内还是旧的。
     */
    const buildAtStart = captureBuild(import.meta.dirname);
    // ── 【C1 · 投递权威表】谁·何时·以哪个面被注入 ──────────────────────────
    // 这是"什么算一次唤起"的**唯一权威**：唤起 ≡ 注入（面②），面①如实记录但不计唤起。
    // ⛔ 只有**真的把内容渲染进上下文的那一处**能往这里写（见下面 hot/route 两个注入点）。
    // 【E · 1.4】「一天」的唯一权威口径 = 配置时区（作者 2026-10-09 拍板）。
    // 这里是**唯一写入点**：日期粒度的到期、"今天"标签、每日任务的键全部由它决定。
    // 修前三套口径并存（UTC 日末 / UTC 日初 / UTC 日标签），后果是日期粒度的失效时刻取决于代码路径。
    setDayTimeZone(config.timeZone);
    setMonitorTimeZone(config.timeZone); // 【V1.3 监测补丁】影子判定与日志同一时区口径
    const injectionLedger = new InjectionLedger(path.join(config.containerRoot, 'injection-ledger.jsonl'));
    /** 宿主给的轮次号（`turn/start` 事件）。拿不到时 undefined ⇒ 账本退化为"集合变了才算一次" */
    let currentTurn;
    let currentSessionId;
    /**
     * 装配缓存失效标记：写入成功后置 true，hot 段下一轮装配强制重算。
     * 不用 fs.watch（本期单写入者），写入路径即失效来源——写入后「下一轮即可见」。
     */
    let hotCacheDirty = true;
    let hotCacheText = null;
    /** 【P6】hot 缓存对应的墙钟日：跨日必须重算（否则档位/日切都不走） */
    let hotCacheDay = '';
    // 【P6】档位覆盖缓存（按活跃日；先验 H/θ，待标定）
    const CHAIN_H = 7;
    const CHAIN_THETA = 0.1;
    let chainTierCache = null;
    /** 【P7】按天缓存的链级计划（单生产者用；⛔ 每 10 分钟读 147 个文件是不可接受的） */
    let chainPlanDay = '';
    let chainPlanCache = null;
    const chainPlanForToday = (fresh = false) => {
        if (!config.chainJudge)
            return undefined;
        const today = dayKey(new Date());
        if (!fresh && chainPlanDay === today && chainPlanCache)
            return chainPlanCache;
        chainPlanDay = today;
        chainPlanCache = chainPlanToDecayPlan(computeTierOverrides(container, subjects, injectionLedger, CHAIN_H, CHAIN_THETA, { limit: 20 }).plan);
        return chainPlanCache;
    };
    /** 【P1-2 修复 · 2026-10-19】扫描成功后计划缓存必须失效：修前 force 复用同一份 moves ⇒ 对已归档 id 再 relocate ⇒ 500+半批 */
    const invalidateChainPlan = () => { chainPlanDay = ''; chainPlanCache = null; };
    /**
     * 【P7 顺序修复 · 2026-10-19】一次启动的公示批次（**必须在扫描之前算**）。
     *
     * ⛔ 修前：启动先 `runDueSweep` 搬完，再算公示 ⇒ 条目已 archive、`plan.moves` 为空 ⇒ 恒「今日无」。
     * ✅ 修后：计划 → 上一批到期切 due → 只把 due 交给 `runDueSweep` → 再公示其余候选。
     *
     * 返回 undefined = 开关没开或计算失败（调用方走旧路径，⛔ 不许把“没算出来”当成“没有到期”）。
     */
    const computePublication = () => {
        if (!config.publicNotice || !config.chainJudge || !config.containerRoot)
            return undefined;
        try {
            // 公示要看到**全部** forget 候选：每批公示上限由 NOTICE_LIMIT 控制，不在这里截断
            const res = computeTierOverrides(container, subjects, injectionLedger, CHAIN_H, CHAIN_THETA);
            const events = readEvents(config.containerRoot, 'publication');
            // 上一批 = 最新一条带订阅期的行（空清单行同样参与：它的订阅期照样会到期）
            const rawPrev = [...events].reverse().find((r) => typeof r.expireDay === 'number' && Array.isArray(r.ids) && typeof r.batch === 'string');
            const prev = rawPrev
                ? {
                    batch: String(rawPrev.batch),
                    ids: rawPrev.ids,
                    publishedDay: Number(rawPrev.publishedDay),
                    expireDay: Number(rawPrev.expireDay),
                    ...(typeof rawPrev.publishedWallDay === 'string' ? { publishedWallDay: rawPrev.publishedWallDay } : {}),
                    ...(typeof rawPrev.expireWallDay === 'string' ? { expireWallDay: rawPrev.expireWallDay } : {}),
                }
                : null;
            return planPublicationBatch({
                plan: res.plan,
                pins: loadPins(config.containerRoot),
                prev,
                today: res.today,
                wallDay: dayKey(new Date()),
                seenBatches: events.map((e) => String(e.batch)),
                layerOf: (id) => container.entryMeta(id)?.layer ?? null,
                // N = max(3 活跃日, 7 日历日)：两个时钟都记，到期取较晚者
                N: 3,
                calendarN: 7,
            });
        }
        catch (e) {
            // ⛔ 算不出来就不公示、也不搬：宁可这一天忘记停摆，也不许“先忘后公示”
            logger.warn(`[P7] 公示批次计算失败（本次不公示、链级计划不执行）：${e instanceof Error ? e.message : String(e)}`);
            return undefined;
        }
    };
    /**
     * 上一次编译所用的字符预算 —— **缓存必须带这一维**：
     * 预算随对话变化，若只看 dirty 标记，预算缩小后仍会命中超预算的旧文本。
     */
    let hotCacheBudget = null;
    /**
     * 索引修订探针（D2）：判断"盘上这份索引是不是我们上次看到的那份"。
     * 提到这里是因为**两条我们自己写盘的路径**都要销账（工具写入 / touch+账本 flush）——
     * ⛔ 外审第 4 条：不销账的话，我们自己的写会被下一轮误判成"外部改盘"。
     */
    const revisionProbe = makeRevisionProbe(path.join(config.containerRoot, 'index.json'));
    const invalidateHotCache = () => {
        hotCacheDirty = true;
        // 自己的写盘已经发生 ⇒ 顺手把修订基线挪到"我刚写出来的那份"
        revisionProbe.rebaseline();
    };
    // ── 动态预算（方案A）──────────────────────────────────────────────
    // 装配点拿不到 session（详见 budget.ts 顶部），用量只能由事件回调记录、下一轮装配读取
    // ——「上一轮驱动本轮」是物理约束，不是设计偏好。
    // 数据源：会话事件 `assistant/message`.usage（adapter 未报用量时该字段缺失，此处不猜、跳过）。
    const tokenBudget = new TokenBudget();
    if (canListen) {
        ctx.on('session/event', (_session, event) => {
            // 事件载荷在 `event.data` 里 —— 解析逻辑见 usageFromSessionEvent（自带测试，
            // 因为按顶层取 usage 会**静默**失效：不报错、预算恒等于静态上限）
            const usage = usageFromSessionEvent(event);
            if (usage)
                tokenBudget.record(usage);
        }, 'memory-container.budget');
    }
    else {
        logger.warn('宿主未提供 ctx.on：无法订阅 session/event，动态预算退化为静态 hotMaxChars');
    }
    // ── 轻量 LLM 接入点（v1.0 需求② 前置）───────────────────────────
    // ctx.llm 用 try/catch 取：cordis 访问未注册的服务会抛；压缩能力不可用**不能影响插件启动**。
    const readLlm = () => {
        try {
            const llm = ctx.llm;
            if (!llm || typeof llm.stream !== 'function' || typeof llm.listProviders !== 'function') {
                return undefined;
            }
            return llm;
        }
        catch {
            return undefined;
        }
    };
    const compressor = createCompressor(readLlm(), {
        provider: config.compressProvider,
        model: config.compressModel,
        maxTokens: config.compressMaxTokens,
    }, logger);
    // 启动即探测一次，结果进日志；不可用只告警，不影响装配
    void compressor.resolve();
    // ── 库登记表（2026-09-30）─────────────────────────────────────
    // 库里有大批文件不该进容器、但必须能被找到；这张表就是它们的目录。
    // **表不存在不是错误**：静默空集，主检索照常——「登记表没建」不该让插件起不来。
    // ⚠️ 用 `?? ''` 兜底：测试会直接调 apply() 传入最小 config（不走 schema 默认值），
    //    字段可能是 undefined —— 这里必须自己挡，不能指望 zod 的 default。
    const registryFile = String(config.vaultRegistryFile ?? '');
    const containerRootCfg = String(config.containerRoot ?? '');
    // ⚠️ **不能假设 vault 就是 containerRoot 的上一级**（2026-09-30 踩到）：
    //    实配是 `<vault>/00_记忆系统/dsh-memory-container` —— vault 在**上两级**。
    //    原来写 `resolve(containerRoot, '..')` 会算到 `<vault>/00_记忆系统`，
    //    于是登记表找不到、静默空集、检索一条库命中都没有。**错得很安静。**
    //    改法：从 containerRoot 逐级上溯，找到**含登记表的那个目录**才算 vault 根。
    const findVaultRoot = () => {
        if (config.vaultRoot)
            return String(config.vaultRoot);
        if (!containerRootCfg || !registryFile || path.isAbsolute(registryFile))
            return path.resolve(containerRootCfg || '.');
        let dir = path.resolve(containerRootCfg);
        for (let i = 0; i < 4; i++) {
            const parent = path.resolve(dir, '..');
            if (fs.existsSync(path.resolve(parent, registryFile)))
                return parent;
            if (parent === dir)
                break;
            dir = parent;
        }
        return path.resolve(containerRootCfg, '..'); // 找不到就退回旧行为，并靠下面的日志暴露
    };
    const vaultRootResolved = findVaultRoot();
    const registryPath = registryFile
        ? path.isAbsolute(registryFile)
            ? registryFile
            : path.resolve(vaultRootResolved, registryFile)
        : '';
    const vaultRegistry = registryFile && containerRootCfg
        ? loadVaultRegistry(registryPath, vaultRootResolved)
        : { entries: [], problem: '未配置且无 containerRoot（已关闭）' };
    if (vaultRegistry.problem) {
        // 把算出来的路径也打出来 —— 路径算错时**必须一眼看得见**，不能静默空集
        logger.warn(`库登记表未启用: ${vaultRegistry.problem}（vaultRoot=${vaultRootResolved}）`);
    }
    else {
        logger.info(`库登记表已加载: ${vaultRegistry.entries.length} 条（${registryPath}）`);
    }
    // ── 容器加载（同步 fail-fast） ──────────────────────────────
    // 【purge 崩溃恢复 · 2026-10-19】必须在 load 之前：索引列着但文件被搬进 trash 的条目，
    // 先搬回原路径，否则 load 会因「条目文件缺失」直接 fail-fast。
    try {
        const rec = reconcilePurgeTrash(config.containerRoot, logger);
        if (rec.restored.length)
            logger.warn(`[purge] 已恢复崩溃残留：${rec.restored.join(', ')}`);
    }
    catch (e) {
        logger.warn(`[purge] 启动对账失败（不阻断启动）：${e instanceof Error ? e.message : String(e)}`);
    }
    const container = new MemoryContainer(config.containerRoot);
    container.load({ repairProjection: true });
    // 【孤儿发现 · 2026-10-19】longterm/archive 的未登记 md 以前永远不可见（不进检索/注入/备份）。
    // 只告警 + 落 orphan-report，不自动收养（id 冲突/来源需要人工判断）。
    {
        const orphans = container.getOrphanFiles?.() ?? [];
        if (orphans.length) {
            logger.warn(`[container] ⛔ 发现 ${orphans.length} 个未登记 md（不进检索/注入）：${orphans.slice(0, 10).join(', ')}${orphans.length > 10 ? ' …' : ''}`);
            appendEvent(config.containerRoot, 'orphan-report', { kind: 'container-md', files: orphans }, logger);
        }
        // 【半批对账 · 2026-10-26】有 begin 没 commit/abort = 崩在批次中间。
        // ⛔ 只告警 + 落 orphan-report；不自动补 commit（审计事实不能靠猜）。
        const incomplete = readIncompleteSweeps(config.containerRoot);
        if (incomplete.txns.length) {
            logger.warn(`[decay] ⛔ 发现 ${incomplete.txns.length} 个未完成扫描事务（半批/崩溃现场）：${incomplete.txns.slice(0, 5).join(', ')}${incomplete.txns.length > 5 ? ' …' : ''}`);
            appendEvent(config.containerRoot, 'orphan-report', { kind: 'incomplete-sweep', txns: incomplete.txns }, logger);
        }
    }
    // 投影对账出口（2026-10-07 加）：索引（派生）与条目文件（唯一真源）不符时**喊一声**。
    // 为什么不能只靠容器自己：容器是库、不带 logger；而"派生陈旧"恰恰是最容易被静默放行的一类
    // （实测 l-e01…l-e09 的 tags 少了 h01，按 h01 检索那九条命中不了，223 项测试一条没报）。
    // 不阻断启动 —— 容器不能被自己的校验写死（2026-09-15 / 10-06 两次教训）。
    const projectionDrift = container.getProjectionDrift();
    if (projectionDrift.length > 0) {
        logger.warn(`索引投影与条目文件不符 ${projectionDrift.length} 处（索引是派生、文件是唯一真源）。` +
            `用 scripts/repair-index-projection.mjs 回正。前几处：${projectionDrift.slice(0, 3).join(' ｜ ')}`);
    }
    // 数据缺口出口（V1.3-A · G1）：**两侧都没有**该字段的条目，与上面的漂移严格分开报。
    // 二者处置方式不同 —— 漂移要回正索引，缺口要回填数据（G2 的分层回填就是干这个）。
    const legacyMissing = container.getLegacyMissing();
    const dataMissing = container.getDataMissing();
    if (dataMissing.length > 0) {
        logger.warn(`条目字段缺口 ${dataMissing.length} 处（两侧都没有该字段，按契约该有值）。` +
            `这是**数据缺口不是漂移**：走 scripts/backfill-decay-fields.mjs 回填。前几处：${dataMissing.slice(0, 3).join(' ｜ ')}`);
    }
    // 正文完整性出口（V1.3-A · G3）：**三个数必须一起报** —— 只报 mismatch 会让人以为
    // "没报就是全对"，而实际可能一条都验不了（首批 112 条全是 v3 旧格式，一条都验不了）。
    const checksum = container.checksumStatus();
    if (checksum.mismatch.length > 0) {
        logger.error(`⚠️ 条目正文校验和不符 ${checksum.mismatch.length} 处（正文被改动而校验和没跟上）。` +
            `前几处：${checksum.mismatch.slice(0, 3).join(' ｜ ')}`);
    }
    logger.info(`正文完整性：验过 ${checksum.verified} 条 ／ 不符 ${checksum.mismatch.length} 条 ／ 不可验证 ${checksum.unverifiable} 条（旧格式或无值）`);
    // ── 路由引擎（MemoryV1.1-Exact 核心件，2026-09-30 移植自 V1.2）────────
    // 职责：按**本轮用户输入**做三层召回 + 打分，产出要"想起"的条目。
    // 不负责投递——**投递位置由下面的 context() 决定，这条边界当年就是栽在这**。
    let routeQuery = '';
    // 【反制 · 2026-10-09】面②（动态段）关着这件事必须**说出来**。
    // 事故实录：重挂载把配置里的 `enableRoute: true` 弄丢了（挂载模板缺这个键），
    // 于是 `router = null` ⇒ 动态召回**静默关闭约 4.5 小时**，
    // 而读数上只表现为 `route.rounds = 0` —— 与"这次会话还没说话"**长得一模一样**。
    // ⛔ 权重**随开关一起换**：开关关着 ⇒ 逐字用冻结权重（w2_pri=0，行为与接线前相同）；
    //    开关打开 ⇒ 用标定权重（w2_pri=0.2）—— 否则 priority 会从 0.6 掉到 0.2 而没人处理，
    //    那正是"只换条曲线、权重不管"，标定集上会**掉一条命中**（12→11）。
    const routeConfig = config.freshFromTurnClock
        ? { ...DEFAULT_ROUTE_CONFIG, weights: { ...E3_WEIGHTS } }
        : DEFAULT_ROUTE_CONFIG;
    const router = config.enableRoute ? new Router(container, routeConfig) : null;
    // 【标定结论 · 2026-10-09】接线后若 `w2_pri < 0.1`，标定集上**命中从 12 掉到 11**（漏掉 2→3）。
    // 这不是"更保守"，是变差 ⇒ 开机就说出来（⛔ 不许让这个组合静默上线）。
    if (config.freshFromTurnClock && Number(DEFAULT_ROUTE_CONFIG.weights.w2_pri) < 0.1) {
        logger.warn(`fresh 接线已开，但 w2_pri=${DEFAULT_ROUTE_CONFIG.weights.w2_pri} < 0.1 —— ` +
            '标定集实测：该组合命中 11/漏掉 3（w2_pri≥0.1 时为 12/2）⇒ 请同版把 w2_pri 提到 ≥0.1');
    }
    // 【P4】process 分支的"乘零"要在启动时说出来（⛔ 不让它静默装死）。
    // 门槛写死：**active process ≥ 5 条**才值得投入标定（当前 1 条 ⇒ 不可验证）。
    {
        const idx0 = container.getIndex();
        const procActive = idx0.entries.filter((e) => (e.status === 'active' || e.status === undefined) && e.decay_type === 'process').length;
        if (DEFAULT_ROUTE_CONFIG.weights.w3_process === 0 && procActive > 0) {
            logger.warn(`process 衰减分支整体乘零（w3_process=0）⇒ 等价 recent，当前影响 ${procActive} 条 active 条目。` +
                `要在意它，先把 active process 攒到 ≥5 条（现 ${procActive} 条，改了也验证不了）`);
        }
    }
    if (!router) {
        logger.warn('面②（动态召回）**已关闭**（config.enableRoute=false）—— 记忆只走系统提示词的常驻段；' +
            '若这不是有意为之，检查 profile 的插件配置（挂载模板缺键会导致这个开关静默退回默认值）');
    }
    // ── 路由仪表盘（V1.2 出口件）────────────────────────────────────
    // RouteStats 从 09-23 起每轮都在算，但**没有任何出口**：为什么选了这几条只活在
    // 一次性内存里，验收只能靠读日志。没有出口，标定（②）与接线（③）都无法验收。
    // 边界：只读观测（不参与任何决策）、不落盘（重启即清空）、有界（容量 20 次装配）。
    const routeDashboard = new RouteDashboard(20);
    const round4 = (x) => Math.round(x * 1000) / 1000;
    /** 查询指纹（djb2）：同一轮多次装配要能辨重。只用于观测，不参与决策。 */
    const routeQueryKey = (q) => {
        let h = 5381;
        for (let i = 0; i < q.length; i++)
            h = ((h << 5) + h + q.charCodeAt(i)) >>> 0;
        return `${q.length}:${h.toString(16)}`;
    };
    /**
     * 记一格仪表盘。**只读观测**：不改分值、不改集合、不落盘。
     * skipped 的轮次照记（empty-query / empty-main / error）——不粉饰：
     * 「没注入」与「注入了 0 条」是两件事，聚合口径里必须分得开。
     */
    const recordRouteRound = (result, renderedChars, ms, skipped, error) => {
        routeDashboard.record({
            at: new Date().toISOString(),
            query: routeQuery.slice(0, 40),
            queryKey: routeQueryKey(routeQuery),
            recalled: result?.stats.recall ?? { directed: 0, emergent: 0 },
            scored: result?.stats.scored ?? 0,
            gated: result?.stats.gated ?? { passed: 0, failed: 0 },
            gateIn: result?.stats.gateIn ?? { baseSet: 'gatePassed', fraction: 0, value: null, eligible: 0 },
            injected: result?.main.length ?? 0,
            candidates: result?.stats.candidates ?? 0,
            capped: result?.stats.capped ?? 0,
            picked: (result?.main ?? []).map((e) => ({
                id: e.meta.id,
                origin: e.origin,
                rel: round4(e.rel),
                pri: round4(e.pri),
                score: round4(e.score_cand),
            })),
            renderedChars,
            ms,
            skipped,
            ...(error === undefined ? {} : { error }),
        });
    };
    /** touch 落盘节流：30s 地板。不每轮写（写放大），不一味攒（进程被 kill 会丢新鲜度）。 */
    const TOUCH_FLUSH_INTERVAL_MS = 30_000;
    let lastTouchFlush = Date.now();
    if (router)
        logger.info('路由引擎已启用（dynamic main → runtime-context 自替换快照，不进系统提示词）');
    const index = container.getIndex();
    logger.info(`容器加载成功: ${index.entry_count} 条, schema=${index.schema}`);
    // hot_order 指针一致性快照（P1 出口条件：必须为空）
    logger.info(`写入保护: 锁=${'on'}，原文比对=${config.verifyUserQuote ? 'on（直写必须指到用户原话）' : 'off（纯模型判据）'}，` +
        `同义扩展=${config.enableLexicon ? 'on' : 'off'}`);
    const hotCheck = container.hotOrderConsistency();
    if (!hotCheck.ok) {
        logger.warn(`hot_order 指针一致性检查未通过：${hotCheck.problems.join('；')}`);
    }
    // 索引一致性告警（数据仍可用，不阻断启动）
    if (index.entry_count !== index.entries.length) {
        logger.warn(`index.json 的 entry_count(${index.entry_count}) 与 entries 实际数量(${index.entries.length}) 不一致`);
    }
    // ── HTTP API token（安全专项 §三-5）──────────────────────────
    // 目的：让「本机任意进程」不能无凭证读写记忆——它得先能拿到 token。
    // 诚实边界：能读本机文件的攻击者既能读容器明文也能读 token；本机制提高门槛，不等于安全。
    // 注入路径：宿主 webServer 提供 `webserver/index-inject`，把 token 写进页面 globalThis，
    //           浏览器端 GUI 读取后放进请求头（插件 client 半区见 src/client/index.ts）。
    const apiToken = (config.apiToken === 'auto'
        // ⭐ 跨重载复用（2026-10-16 拍）：先读 `apiTokenFile` 里已有的那个
        ? resolveAutoToken((() => {
            try {
                return config.apiTokenFile ? fs.readFileSync(config.apiTokenFile, 'utf-8') : null;
            }
            catch {
                return null;
            }
        })())
        : (config.apiToken === 'off' ? '' : String(config.apiToken)));
    if (apiToken && config.apiTokenFile) {
        try {
            // 0600：仅属主可读；本机脚本读它才能调 API
            fs.mkdirSync(path.dirname(config.apiTokenFile), { recursive: true, mode: 0o700 });
            fs.writeFileSync(config.apiTokenFile, apiToken + '\n', { encoding: 'utf-8', mode: 0o600 });
            logger.info(`API token 已就位 ${config.apiTokenFile}（0600；auto 模式下**跨重载复用**，不会每次重生）`);
        }
        catch (error) {
            logger.warn(`API token 写文件失败（token 仍生效，但本机脚本无法读取）: ${String(error)}`);
        }
    }
    // 页面注入表：宿主每次渲染 index 都会 emit，推 kind:'global' 即在首屏前写入 globalThis。
    // 用 ctx.on 而非 ctx.inject——注入服务不是这里要做的事，事件注册随 fiber 释放即可。
    //
    // 为什么 token 与前缀都要注入：客户端半区是独立 bundle，拿不到宿主 config。
    // 只注入 token 会让「自定义 apiPrefix」变成**静默坏前端**（客户端仍打默认路径）。
    if (canListen) {
        ctx.on('webserver/index-inject', (table) => {
            if (apiToken)
                table.push({ kind: 'global', name: '__DSH_MEMORY_TOKEN__', value: apiToken });
            table.push({ kind: 'global', name: '__DSH_MEMORY_API_PREFIX__', value: config.apiPrefix });
        }, 'memory-container.api-inject');
    }
    // 照官方范例（experimental/inspector 注入 __DSH_INSPECTOR__ 的同一路径）。
    if (apiToken && canListen) {
        logger.info('API token 已启用（Host/Origin 校验 + 请求头 token 三层防护）');
    }
    else if (apiToken) {
        logger.error('宿主未提供 ctx.on：token 无法注入页面 → GUI 将被 401 拒绝。token 校验仍生效，请检查宿主版本');
    }
    else {
        logger.warn('API token 已关闭（apiToken=off）：HTTP API 仅剩 Host/Origin 两层防护');
    }
    // ── 会话原话缓冲（P2）：为「原文比对」提供依据 ────────────────
    // 只收 source.kind === 'user' 的消息——plugin 注入与 model 产出都不是「用户明说」。
    // 只存内存、会话销毁即弃：原话属会话上下文，落盘会把记忆库变成监听库。
    const sessionBuffer = new SessionBuffer();
    /** 【P0-7】活跃日账本（真人消息，按 day+session 去重） */
    const activeDays = new ActiveDaysLog(config.containerRoot);
    /** 【P2】subject 结构表（切口建会话 subject；只写不读） */
    const subjects = new SubjectStore(config.containerRoot, { log: { error: (m) => logger.error(m), warn: (m) => logger.warn(m) } });
    /** Breathe 手动记忆链注册表：独立于 memory-write 锁与条目 schema。损坏时 fail-closed。 */
    let chainStore;
    let chainUnavailableReason = '';
    try {
        chainStore = new ChainStore(config.containerRoot, {
            log: {
                error: (m) => logger.error(m),
                warn: (m) => logger.warn(m),
                info: (m) => logger.info(m),
            },
        });
    }
    catch (error) {
        chainUnavailableReason = error instanceof Error ? error.message : String(error);
        logger.error(`[chains] 注册表不可用，拒绝猜测或覆盖；链管理 API 将关闭：${chainUnavailableReason}`);
    }
    /** 【P3】本会话内每个 subject 被人工提及的次数（activation 的唯一依据） */
    const mentionCounts = new Map();
    /** 【P8】自动转正：每活跃日计数（默认关） */
    let autoPromoteDay = '';
    let autoPromoteCount = 0;
    let autoPromoteBatch = '';
    /** 【P8】日配额落盘：重启/多实例都不许清零重来 */
    const autoPromoteFile = path.join(config.containerRoot, 'auto-promote.json');
    const readAutoPromote = () => {
        try {
            const d = JSON.parse(fs.readFileSync(autoPromoteFile, 'utf-8'));
            return { day: String(d?.day ?? ''), count: Number(d?.count ?? 0) || 0 };
        }
        catch {
            return { day: '', count: 0 };
        }
    };
    const bumpAutoPromote = (day) => {
        const cur = readAutoPromote();
        const next = (cur.day === day ? cur.count : 0) + 1;
        try {
            fs.writeFileSync(`${autoPromoteFile}.tmp-${process.pid}`, JSON.stringify({ day, count: next }));
            fs.renameSync(`${autoPromoteFile}.tmp-${process.pid}`, autoPromoteFile);
        }
        catch { /* 写失败按内存继续 */ }
        return next;
    };
    if (config.verifyUserQuote && !canListen) {
        logger.warn('宿主未提供 ctx.on：原文比对降级为「无依据可比」（退化为纯模型判据）');
    }
    // ── 【B-0 修复 · 2026-10-09】这条订阅**不再**由 `verifyUserQuote` 把关 ──────────
    // 外审第 3 条（当时判为"B 段硬前置"）指出：整段包在 `verifyUserQuote && canListen` 里，
    // 关掉那个配置 ⇒ touch 永不落盘（引擎会算在死时间戳上）。
    // 而到了 C 段，同一个开关**连带关掉了另外三件事**，比当初说的更严重：
    //   · `turn/start` 轮次号捕获 ⇒ 账本退化为"集合变了才算一次"（判据变弱）；
    //   · **`routeQuery` 捕获 ⇒ 面②（动态段）直接返回空** —— 整个动态召回不工作；
    //   · touch 与投递账本**都不落盘**。
    // 现在按职责拆开：`canListen` 决定"能不能听事件"；`verifyUserQuote` 只决定
    // **"要不要做原话比对"**（它本来就是"写入必须指到用户原话"那条纪律的开关，与上面三件事无关）。
    if (canListen) {
        ctx.on('session/event', (session, event) => {
            try {
                /**
                 * 【2026-10-16】量事件形状（**文件哨兵**，见 `config.diagEventTap` 的注释）。
                 * ⛔ 放在**所有判据之前**：正是为了看清"被哪一条挡下的"。
                 * ⛔ 不抛：观测口不许影响主流程（写失败只吞掉）。
                 * ⚠️ 探测带 TTL 缓存（60s）：`session/event` 在热路径上，⛔ 不能每条事件都 stat 一次盘。
                 *    哨兵的语义是"运维临时放/删文件" ⇒ 60s 的滞后完全够用。
                 */
                if (diagTapWanted()) {
                    try {
                        const m = event?.data;
                        const blocks = Array.isArray(m?.content) ? m.content : [];
                        fs.appendFileSync(path.join(config.containerRoot, 'diag-session-events.jsonl'), JSON.stringify({
                            at: new Date().toISOString(),
                            eventType: event?.type,
                            seq: event?.seq,
                            sessionId: session?.id,
                            sourceKind: m?.source?.kind,
                            contentIsArray: Array.isArray(m?.content),
                            blockTypes: blocks.map((b) => b?.type),
                            textLen: blocks.filter((b) => b?.type === 'text').map((b) => String(b?.text ?? '').length),
                            // 判据逐条的结果（空 = 与捕获判据相符）
                            blockedBy: [
                                event?.type !== 'user/message' ? 'type≠user/message' : null,
                                event?.type === 'user/message' && m?.source?.kind !== 'user' ? 'source.kind≠user' : null,
                                event?.type === 'user/message' && !(blocks.some((b) => b?.type === 'text' && String(b?.text ?? ''))) ? '无 text 块或文本为空' : null,
                                event?.type === 'user/message' && !String(session?.id ?? '') ? '无 sessionId' : null,
                            ].filter(Boolean),
                        }) + '\n');
                    }
                    catch { /* 观测口：写不进去不影响主流程 */ }
                }
                // 【C2】轮次号从宿主事件里取（0.1.7 实测：`turn/start.data.turn` 就在这条通道上）。
                // 它是"按轮去重"的依据 —— 宿主**每步**都装配，没有它就只能靠猜。
                if (event?.type === 'turn/start') {
                    const t = Number(event?.data?.turn);
                    if (Number.isFinite(t))
                        currentTurn = t;
                    const sid = String(session?.id ?? '');
                    if (sid)
                        currentSessionId = sid;
                    return;
                }
                if (event?.type !== 'user/message')
                    return;
                const message = event.data;
                if (message?.source?.kind !== 'user')
                    return;
                const text = (message.content ?? [])
                    .filter((block) => block?.type === 'text')
                    .map((block) => block.text)
                    .join('\n');
                if (!text)
                    return;
                const sessionId = String(session?.id ?? '');
                if (!sessionId)
                    return;
                currentSessionId = sessionId;
                // 【P2】切口：会话首条真人消息 ⇒ 建会话 subject（幂等）
                try {
                    subjects.openConversation(sessionId, text);
                }
                catch (e) {
                    // 【并发修复】写锁失败/落盘失败要看得见；不拖垮会话，但也不能静默
                    logger.warn(`[P2] 会话 subject 落盘失败（本次不阻断对话）：${e instanceof Error ? e.message : String(e)}`);
                }
                // 【P3】mention 扫描：人工提及才记；疑问式算 1 次；只记事件，不驱动判定
                try {
                    const mainId = subjects.mainSubjectOf(sessionId);
                    const questionForm = isQuestionForm(text);
                    for (const hit of subjects.scan(text, mainId, subjects.mainSubjectOf(sessionId))) {
                        appendEvent(config.containerRoot, 'mention', {
                            session: sessionId,
                            turn: currentTurn,
                            subject: hit.id,
                            name: hit.name,
                            matched: hit.matched,
                            questionForm,
                            primary: hit.primary,
                        });
                        subjects.touchActivated(hit.id);
                        // 【P3】一场对话里第 2 次人工提及 ⇒ 激活（+1 档）；疑问式仍只算 1 次
                        const k = `${sessionId}|${hit.id}`;
                        const n = (mentionCounts.get(k) ?? 0) + 1;
                        mentionCounts.set(k, n);
                        if (n === 2) {
                            appendEvent(config.containerRoot, 'activation', {
                                session: sessionId,
                                turn: currentTurn,
                                subject: hit.id,
                                mentions: n,
                                from: 'none',
                                to: '+1',
                                deep: false,
                            });
                        }
                    }
                }
                catch { /* 观测口不拖垮会话 */ }
                // ⛔ 只有**这一项**归 `verifyUserQuote` 管（它是"写入必须指到用户原话"的纪律开关）
                // 原话比对仍由 verifyUserQuote 把住（b0 测试 ③ 的纪律）
                if (config.verifyUserQuote)
                    sessionBuffer.record(sessionId, Number(event.seq ?? 0), text);
                // 【P0-4】seq 无条件记录（只存数字，不存文本）——source_message 的唯一来源
                sessionBuffer.recordSeq(sessionId, Number(event.seq ?? 0));
                // 【P0-7】活跃日：只认真人消息；时间源三级回退（探针 2 的现场证据落在 timeSource）
                {
                    const t = eventTimeOf(event);
                    activeDays.record(activeDayKey(t.at), sessionId, Number(event.seq ?? 0), t.at, t.source, text);
                }
                // ── 路由：取"上一轮用户输入"当 query（2026-09-30 移植自 V1.2）────
                // 为什么是"上一轮"而不是"本轮"：宿主在 systemPrompt 装配时不传本轮 query
                // （这是宿主接口的限制，不是设计选择）。所以 `main` 反映的是**上一句用户输入**
                // 的相关性——它比"永远按静态 priority 排"准得多，但不是实时。
                // 这条边界在 V1.2 的项目回执里已如实标注，现在照搬，不假装实时。
                routeQuery = text.slice(0, 500);
                // touch 落盘（30s 地板）：不每轮写（13+ 个文件 = 写放大），不一味攒（被 kill 会丢）
                if (router && Date.now() - lastTouchFlush >= TOUCH_FLUSH_INTERVAL_MS) {
                    // 【Ledger】touch 落盘必须进写事务（拿锁 + 持锁后重读索引）——
                    // 修复前这是插件里**唯一一条从不拿写锁的落盘路径**：`flushTouch()` 末尾直接
                    // `container.saveIndex()`，靠 10-07 的三路合并兜底。合并能救"别人加了条目"，
                    // 但救不了"读磁盘 → 合并 → 写"这三步之间的竞态（check-then-act）。
                    // 无 writer 时（只读装配）退回原路径：那条路不落盘（allowEdit/writer 同源）。
                    const flushed = writer
                        ? writer.withWriteTransaction(() => {
                            // 账本与 touch 同一节奏落盘（同一个写事务）：⛔ 不新增一条独立写路径
                            injectionLedger.flush();
                            return router.flushTouch();
                        })
                        : router.flushTouch();
                    if (flushed.written > 0) {
                        lastTouchFlush = Date.now();
                        // 【外审第 4 条】自己写了盘 ⇒ 立刻重新登记修订基线，
                        // 否则下一轮会把"我们自己的写"当成"外部改盘"，白跑一次 load + hot 重算。
                        revisionProbe.rebaseline();
                        if (flushed.failed.length || !flushed.indexSaved) {
                            // 文件写了但索引没落 = 双真源分叉。**不能静默**（本插件反复踩的坑）。
                            logger.warn(`touch 落盘不完整: 文件 ${flushed.written} 条，索引落盘=${flushed.indexSaved}` +
                                (flushed.failed.length ? `，失败 ${flushed.failed.length}` : ''));
                        }
                    }
                }
            }
            catch (error) {
                // 事件监听绝不抛错：抛出去会影响会话本身
                logger.warn(`会话事件处理失败（忽略）: ${String(error)}`);
            }
        }, 'memory-container.session-buffer');
    }
    // ── 写入器（V1.0）：唯一新增写出口，仅在 allowWrite=true 时注册工具 ──
    /** 自动转正审计：只追加，不记录正文；失败不阻断主写，但必须可见。 */
    function autoPromoteAuditPath(root) { return path.join(root, '.auto-promote.jsonl'); }
    function appendAutoPromoteAudit(root, row) {
        try {
            fs.appendFileSync(autoPromoteAuditPath(root), JSON.stringify(row) + '\n', 'utf8');
        }
        catch (e) {
            logger.warn(`[P8] 自动转正审计写失败（不阻断）：${e instanceof Error ? e.message : String(e)}`);
        }
    }
    function chainFieldsOf(input) {
        const o = (input ?? {});
        const about = Array.isArray(o.about) ? o.about.filter((x) => typeof x === 'string' && x.trim().length > 0) : [];
        return { about, scope: o.scope, scope_id: o.scope_id, memory_type: o.memory_type };
    }
    function chainQualified(input) {
        const c = chainFieldsOf(input);
        return c.about.length > 0 || (c.scope === 'project' && typeof c.scope_id === 'string' && c.scope_id.trim().length > 0);
    }
    const writer = new MemoryWriter(container, {
        operator: 'assistant',
        allowPurge: config.allowPurge,
        sessionBuffer: config.verifyUserQuote ? sessionBuffer : undefined,
        quoteMode: 'enforce',
        log: {
            info: (message) => logger.info(message),
            warn: (message) => logger.warn(message),
            error: (message) => logger.error(message),
        },
        onWrite: () => invalidateHotCache(),
    });
    /**
     * ── 【P0-1 / P0-2 / P0-4 · 2026-10-18】宿主写入上下文（唯一口径）────────────
     * · 会话 id：优先 `exec.agent.session.id`（调用方上下文），退回进程级 `currentSessionId`；
     * · 模型传的 `source_session` **一律丢弃**（P0-2）；
     * · `source_message` 覆写成最后一条真人消息的 seq（无则 `0`，`0` 不参与幂等）。
     */
    function resolveHostSession(exec) {
        const agentSid = exec?.agent?.session?.id;
        if (typeof agentSid === 'string' && agentSid)
            return { id: agentSid, idSource: 'agent' };
        // 【修复】要求宿主上下文时，⛔ 不许回落到“最后说话的人”
        if (config.requireHostSession)
            return { id: '', idSource: 'none' };
        if (currentSessionId)
            return { id: currentSessionId, idSource: 'fallback' };
        return { id: '', idSource: 'none' };
    }
    function hostWriteContext(exec, args) {
        const host = resolveHostSession(exec);
        const lastSeq = host.id ? sessionBuffer.latestSeq(host.id) : null;
        const { source_session: _ignoredSession, source_message: _ignoredMessage, ...rest } = args;
        return {
            input: { ...rest, source_session: host.id, source_message: String(lastSeq ?? 0) },
            idSource: host.idSource,
        };
    }
    // 【P0-3a 修复 · 2026-10-19】回执不再在这里 append：已搬进 `writer.transaction`
    //（事务外写 = 分母丢了账面仍 ok:true；现在 append 失败 ⇒ 写回滚 ⇒ 工具回 ok:false）
    // ── 【P7 顺序修复 · 2026-10-19】公示批次的**两个作用域**必须活到扫描之后 ──
    //    `pub`：扫描**之前**算出的计划（due 从上一批推、override 只含 due）
    //    `pubFailed`：算不出来（异常）⇒ 链级遗忘整批不执行
    //    `pubSwept`：扫描是否真的执行过（⚠️ 只有它跑过，due 才算“已消费”）
    let pub;
    let pubFailed = false;
    let pubIntentFailed = false;
    let pubSwept = false;
    // ── 【B6】启动时跑一次衰减扫描（一天最多一次）────────────────────────
    // 设计见 `docs/decay-design.md`：**启动是有界时刻**，⛔ 不在请求里改数据。
    // ⛔ 硬约束：这里**永不抛到启动路径**（容器/写入器有问题也只是不扫，不能拖垮插件）。
    if (config.containerRoot) {
        // 【V1.3 监测补丁 · 2026-10-12】时区注入：影子判定要按"当地自然日"算
        setMonitorTimeZone(getDayTimeZone());
        // ⚠️ 必须在 runSweep **之前**读上次状态：runSweep 内部会把 lastAt 推进成"现在"
        //    （见 decay-sweep.ts 的 finally 块）⇒ 读晚了就拿不到"距上次多久"这个读数。
        // ⛔ 必须用**兼容读**：旧格式状态文件缺 `lastAutoAt` ⇒ 原始读会让"一天一次"整条判据失效
        //    （实测：10-14 07:39 扫过、14:31 重启又扫一遍——同一自然日两次）。见 `readSweepStateCompat` 注释。
        // ⚠️ 两种读法各有其位（2026-10-14 自查抓到过一次混淆）：
        //    · **决策**用兼容读（把旧格式缺的字段兜底补上，判据才算得对）
        //    · **审计这个文件**用原始读（兼容读会把缺失字段补上 ⇒ G2 那道检查就永远不响了）
        const rawEx = readSweepStateEx(config.containerRoot);
        const rawState = rawEx.state;
        const prevSweep = readSweepStateCompat(config.containerRoot);
        // ── 【闸门兜底 · 2026-10-14】状态坏了就从**审计**兜底（审计只追加 ⇒ 扛得住状态写失败）
        //   ⛔ 不做"一律拦住"：那会让衰减停摆（库只增不减），用停摆换正确性方向错了。
        //   只有"状态文件损坏 **且** 审计也空 ⇒ 真无从得知今天扫没扫"那一种才硬拦。
        const gate = resolveGateSnapshot(config.containerRoot, Date.now());
        if (gate.from === 'audit')
            ctx.logger?.warn?.(`[decay] 闸门兜底：${gate.note ?? ''}（用审计时刻 ${new Date(gate.snap.lastAt ?? 0).toISOString()}）`);
        if (gate.block) {
            ctx.logger?.error?.(`[decay] ⛔ 本次不扫：${gate.note ?? ''} —— 修法：检查 .decay-sweep.json 是否被破坏；审计为空说明从未归档过，可删该状态文件让它按首启处理`);
        }
        // ── 【G1 退役 · L4 步③c-2 · 2026-10-15】**自愈不再跑**；⛔ 但坏行读**照旧** ──────────
        //   ⭐ 为什么能退役：`readAudit` 现在并入日志的 **`moved`** 段（③c-1 已验：日志的 `moved` 才是
        //      "它确实被搬了"）⇒ **"搬了但审计没写"那一缝由日志直接顶上** ⇒ 自愈成了冗余。
        //   ⛔ 为什么不连坏行读数一起删：那两个文件**还在写**（③c-4' 才停），**坏行必须有人看见**
        //      （审计的坏行尤其 —— `auditHealth` 与自愈的早退无关，见原注释的教训）。
        try {
            // ⛔【L4 步④c · 2026-10-15】意图那半**已摘** —— ③c-3 起**意图文件不再增长** ⇒ 它的健康读数恒为"0 行/0 坏行"，
            //   再读它就是**对着一份冻住的历史报健康**（⛔ 那不是读数，那是仪式）。
            //   ⚠️ **审计那半留着** —— `.decay-audit.jsonl` 还在写（④d 才停）。
            const ah = auditHealth(config.containerRoot);
            if (ah.badLines || ah.badShapes || ah.unboundRows || ah.logProblems) {
                ctx.logger?.warn?.(`[decay] 旁挂审计健康异常：audit 坏 JSON ${ah.badLines}/${ah.rows}，坏结构 ${ah.badShapes}，未绑定可信事务 ${ah.unboundRows}，事务日志问题 ${ah.logProblems}；未绑定记录不会进入回滚`);
            }
        }
        catch (e) {
            ctx.logger?.warn?.(`[decay] 旁挂文件坏行读数失败（已忽略，不影响启动）：${e instanceof Error ? e.message : String(e)}`);
        }
        // ── 【G2】状态一致性自检：三种语义互相对账（⛔ 只报不改）────────────────
        try {
            // ⛔ 传 rawState + corrupt 标记 + 审计最新时刻（跨文件对账）—— 见 readSweepStateEx / checkSweepState 注释
            // ⛔ 必须同时判 typeof 与 Number.isFinite（对抗验证 C：只判 typeof 时 `at: Infinity` 会漏进来 ⇒ 下游炸）
            const auditNewestAt = readAudit(config.containerRoot).reduce((m, r) => (typeof r.at === 'number' && Number.isFinite(r.at) && (m === null || r.at > m) ? r.at : m), null);
            const issues = checkSweepState(rawState, Date.now(), { corrupt: rawEx.corrupt, auditNewestAt });
            if (issues.length)
                ctx.logger?.warn?.(`[decay G2] 状态文件不一致（${issues.length} 条）：${issues.join(' ｜ ')}`);
        }
        catch (e) {
            // 【F2】修前这里是空 catch ⇒ 自检自己抛错时**零日志**（实测 RangeError 被吞）
            ctx.logger?.warn?.(`[decay G2] 自检本身出错（已忽略，但要看得见）：${e instanceof Error ? e.message : String(e)}`);
        }
        // 本次扫描的结果（启动路径自己的，不跨作用域复用）
        let out = null;
        // ── 【P0-5 · 2026-10-18】自动扫描总开关（含启动扫描）──────────────────
        //    关闭时：**一行记账（未扫）、零扫描**；gate/G2/auditHealth 等诊断照常。
        //    ⛔ 手动 `/decay-sweep` 不受此开关管。
        if (!config.decayDailyCheck) {
            try {
                monitorSwitchOff({ root: config.containerRoot, snap: gate.snap });
            }
            catch (e) {
                ctx.logger?.warn?.(`[decay] 开关关闭记账失败（已忽略）：${e instanceof Error ? e.message : String(e)}`);
            }
            ctx.logger?.info?.('[decay] 自动扫描关闭（开关）：本次启动不扫（手动 /decay-sweep 仍可用）');
        }
        else {
            /** 当前积压（按类计数）—— 只读、成本与一次判定同量级（亚毫秒~3ms） */
            const backlogOf = (c) => 
            // ⭐【F】把在册名单传进去（在册条目标 `roster-anchor` ⇒ 衰减不动它）
            planDecaySweep(sweepEntries(c.getIndex().entries, undefined, c.getIndex().hot_order, injectionLedger.deliveredCounts())).classes;
            let sweepErr;
            let planned;
            // 【P7 顺序修复】计划必须在**搬之前**算：修前先搬后公示 ⇒ 搬完 plan.moves 为空 ⇒ 恒「今日无」
            if (config.publicNotice && config.chainJudge) {
                pub = computePublication();
                pubFailed = pub === undefined;
                // 【due 账崩溃安全 · 2026-10-19】先落“要消费这一批”的意图，再搬。
                // 崩在搬完→写 due 行之间时，下次启动能凭意图 + 索引真值补终态，不再写 ids:[] 的假账。
                if (pub?.prevDue && pub.intentBatch && !pub.dueDuplicate && !pub.intentDuplicate) {
                    pubIntentFailed = !appendEvent(config.containerRoot, 'publication', {
                        batch: pub.intentBatch, kind: 'due-intent', prevBatch: pub.prevBatch, day: pub.day, ids: pub.due,
                    }, logger);
                    if (pubIntentFailed)
                        logger.error('[P7] ⛔ 到期消费意图落盘失败 ⇒ 本次不搬（避免搬完无账）');
                }
            }
            try {
                /**
                 * 计划条数（G3 抛错时用它当"计划 N 条"的痕迹）。
                 * ⛔ 修前这里自己写了一套公式（只筛 `effectiveAge < 0.5`）—— 那是**第三套口径**：
                 *    它不管地板、也不扣每批上限 ⇒ 会**多报**（对抗验证 D 的第 6 条）。
                 *    现在直接用 `planDecaySweep` 的结果（唯一权威）。
                 */
                planned = planDecaySweep(sweepEntries(container.getIndex().entries, undefined, container.getIndex().hot_order, injectionLedger.deliveredCounts())).moves.length;
                try {
                    // ⛔ **走 `runDueSweep`**（2026-10-14 架构主线一）：闸门只有一份实现，
                    //   与「手动」「定时」两条路共用；启动路径把自己已解析的 `gate` 传进去 ⇒ 不重复读盘。
                    // 【due 账崩溃安全】意图没落盘 ⇒ 退回不扫：⛔ 不许“搬完没账”或“空计划占掉当天闸门”
                    if (pubIntentFailed)
                        throw new Error('到期消费意图落盘失败，本次不扫描（等下次重启）');
                    // 【P7】单生产者：chainJudge=true 时唯一计划来自链级判据（旧判据不参与）
                    // 【P7 顺序修复】publicNotice 打开时只交 due（其余候选等自己的订阅期；空 ⇒ 空 moves，不搬）
                    // ⛔ 公示批次算不出来时用空计划 —— 宁可停摆一天，也不许“先忘后公示”
                    // ⛔ publicNotice 打开时**永远**给显式计划：即使 chainJudge=false 也不许落回 legacy 立刻遗忘
                    //   （修前只 warn ⇒ 运维以为“公示已开”，实际无公示、当天就忘）
                    const chainOverride = pubIntentFailed ? emptyDecayPlan()
                        : pub ? pub.override : (config.publicNotice ? emptyDecayPlan() : chainPlanForToday());
                    out = runDueSweep({
                        gate,
                        root: config.containerRoot,
                        ...(chainOverride ? { planOverride: chainOverride } : {}),
                        // 【P0-2】pin 在所有路径都生效（不只链级判据）
                        pins: loadPins(config.containerRoot),
                        // ⛔ fresh 由 `sweepEntries` 现算（2026-10-11 前这里读的是不存在的索引字段 `e.fresh` ⇒ 恒 undefined ⇒ 永不降层）
                        entries: sweepEntries(container.getIndex().entries, undefined, container.getIndex().hot_order, injectionLedger.deliveredCounts()),
                        relocate: (id, layer, o) => writer.relocate(id, layer, o),
                        // ⛔ 判定输入用**扫描之前**解析出的快照（状态坏了则由审计兜底 —— 见上面 gate 那段）
                        snap: gate.snap,
                        // 【G3】搬完立刻回查索引真值 ⇒ 静默漂移当场抛，不留到下次加载
                        readLayer: (id) => container.getIndex().entries.find((e) => e.id === id)?.layer,
                        // 【F3 · 对抗验证 B 的 A9（最重那条）】状态写失败的唯一出口。
                        //   修前 `onStateWriteFail` 全仓零调用方 ⇒ 写失败被静默吞掉，闸门不推进、
                        //   同一自然日连跑多批，而日志三行全绿（实测搬走 9 条）。
                        onStateWriteFail: (e) => ctx.logger?.error?.(`[decay] ⛔ 状态文件写入失败（闸门无法推进，同日可能重复扫描）：${e instanceof Error ? e.message : String(e)}`),
                    });
                }
                catch (e) {
                    // 【G3/对抗验证 B】搬运或后置校验抛错 ⇒ **不能把整次启动的监测账也吞掉**
                    //   （修前：G3 抛错 ⇒ 该次启动在 `.decay-startup.jsonl` 上零行 ⇒ 半批中断没人知道）
                    sweepErr = e instanceof Error ? e.message : String(e);
                    ctx.logger?.warn?.(`[decay] 启动扫描失败（已忽略，但会落账）：${sweepErr}`);
                }
                if (out?.ran)
                    ctx.logger?.info?.(`[decay] 扫描 ${container.getIndex().entries.length} 条 → 归档 ${out.archived.length} 条（可撤销）`);
                // 【P7 顺序修复】闸门真的放行且整批没抛 ⇒ due 已消费（`out.ran` 为 true 才是真的跑了）
                if (pub && out?.ran)
                    pubSwept = true;
                if (out?.ran)
                    invalidateChainPlan(); // P1-2：搬过的计划不许再被 force/手动路复用
                // 【F3】状态写失败 ⇒ 闸门没推进，说清楚
                if (out?.stateWriteFailed)
                    ctx.logger?.error?.('[decay] ⛔ 本次状态未落盘 ⇒ 闸门没推进，同一自然日可能再扫一遍（已计入监测记录）');
                // ⭐【步④c-α 收尾 · 2026-10-15】日志写失败 —— 与上面那条 `stateWriteFailed` **同一个理由、同一个出口**。
                //   ⚠️ 而且**停写旧件之后它更要紧**：那时日志是**唯一真源** ⇒ 静默失败 = 这一批没被记下。
                if (out?.logWriteFailed)
                    ctx.logger?.error?.('[decay] ⛔ 扫描日志写失败 ⇒ **这一批没被记下**，下次启动会当"首启"、同日可能重复扫描。查 .sweep-log.jsonl 的路径/权限。');
                // 【修 6】意图落盘失败 ⇒ G1 对这些条目静默缺席，必须说出来
                if (out?.intentFailures?.length)
                    ctx.logger?.warn?.(`[decay G1] 意图落盘失败 ${out.intentFailures.length} 条 ⇒ 这几条的崩溃缝**没有护栏**：${out.intentFailures.join(', ')}`);
                // 【V1.3 监测补丁】每次启动必落一行（含"被门槛跳过"）——修前归档 0 条那天零落痕
                // 【#5 可见化】距上次实际扫描多少天 —— 宿主久不重启时，衰减其实在停摆
                const lastSweepAt = gate.snap.lastAt;
                const daysSinceSweep = typeof lastSweepAt === 'number' && Number.isFinite(lastSweepAt)
                    ? Number(((Date.now() - lastSweepAt) / 86400000).toFixed(2))
                    : null;
                if (daysSinceSweep !== null && daysSinceSweep >= 3) {
                    ctx.logger?.warn?.(`[decay] ⚠️ 距上次实际扫描已 ${daysSinceSweep} 天（宿主长时间未重启 ⇒ 衰减在停摆；归档是惰性的、不会丢，但会越积越多）`);
                }
                const mon = monitorStartup({
                    root: config.containerRoot,
                    ...(daysSinceSweep !== null ? { daysSinceSweep } : {}),
                    snap: gate.snap, // ⛔ 与 runSweep 同一个快照（同源、同时刻）
                    // ⛔ 抛错时也要落账：`error` + `planned` 就是半批中断的痕迹
                    //   （对抗验证 B：修前 G3 抛错 ⇒ 该次启动在监测账上**零行** ⇒ 半批中断没人知道）
                    // 【修复】“今天没扫”时的真实积压必须走 `blockedByClass`（`backlog` 不是 MonitorInput 字段，
                    //   条件展开会绕过 TS 检查、静默丢弃 ⇒ 账面永远零待办）
                    sweep: out
                        ? (out.ran ? out : { ...out, blockedByClass: backlogOf(container) })
                        // 【P1-4 修复 · 2026-10-19】扫描抛错不许写 ran:true：state 在 finally 已推进 lastCount，
                        //   写「ran:true / archived:0」会让监控把半批失败当成一次真扫描（账实不符）。
                        : { ran: false, archived: [], blocked: 0, reason: `扫描抛错：${sweepErr ?? '未知'}`, ...(sweepErr ? { error: sweepErr } : {}), ...(typeof planned === 'number' ? { planned } : {}) },
                });
                if (mon && mon.ok === false) {
                    ctx.logger?.error?.('[decay] ⛔ 监控账写入失败（.decay-startup.jsonl）：本次启动没有落账，读数会缺口（按红处理）');
                }
                if (out && !out.ran) {
                    // 【Breathe-R1 · 2026-10-14】影子语义已换：现在记的是"**按 legacy 24h 门槛**会怎样"
                    //（修前口径）——真值判据是"当地自然日 + 6h 最小间隔"，`decidedBy` 说得出是谁拦的。
                    const lastGate = [...readStartups(config.containerRoot)].reverse().find((r) => r.kind === 'gate');
                    ctx.logger?.info?.(`[decay] 本次未扫描（${mon.decision.decidedBy}）：${mon.decision.reason}（对照：按 legacy 24h 门槛${lastGate?.by24h ? '会跑' : '同样不跑'}；已记账，⛔ 只记不生效）`);
                }
            }
            catch (e) {
                // 只记日志，⛔ 不影响插件启动
                ctx.logger?.warn?.(`[decay] 启动扫描失败（已忽略）：${e instanceof Error ? e.message : String(e)}`);
            }
        } // ── P0-5 else（自动扫描开关打开时的原逻辑）──
    }
    // ── 【P7 · 2026-10-19】公示落账（默认关）：**先公示、到期才忘** ──────────────
    //    顺序（2026-10-19 修）：扫描前算 `pub` → 只把 due 交给扫描 → 扫描后落 due/公示两笔账。
    //    ⛔ 本段不改任何条目；搬迁只发生在上面那次 `runDueSweep`（唯一 mover）。
    if (config.containerRoot && config.publicNotice) {
        if (!config.chainJudge) {
            logger.warn('[P7] publicNotice=true 但 chainJudge=false：公示与遗忘会分叉 ⇒ 本次不公示（请先开 chainJudge）');
        }
        else if (!config.decayDailyCheck) {
            // 公示批次要有扫描才算一个周期；开关关着还落行 ⇒ 周期推进了、人却没说“同意”，那是假账
            logger.info('[P7] 自动扫描关闭 ⇒ 本次不公示（没有扫描就不产生公示周期）');
        }
        else
            try {
                // ⛔ **必须复用扫描前算的那份 `pub`**：扫描后重算拿到的是“已搬走”的计划（修前的病根）
                const p = pub;
                if (!p || pubFailed) {
                    logger.warn('[P7] 公示批次不可用（计算失败）⇒ 本次不落公示行（链级遗忘也未执行）');
                }
                else {
                    // ① 到期消费：只有扫描**真的跑过**才落账（闸门拦下/半批抛错时 due 没执行，写“到期执行”就是谎报）
                    //    ⚠️ 用 `prevDue` 而不是 `due.length`：**到期但全被钉住**也要留痕（否则这一天在账上不存在）
                    if (pubSwept && p.prevDue && p.dueBatch && !p.dueDuplicate) {
                        // 【due 账崩溃安全】终态以**索引真值**为准：due 里的 id 只要已在 archive 就算执行，
                        // 不管这一轮 runDueSweep 实际搬了几条（崩后重启时 archivedDue 会覆盖上轮已搬的）。
                        const archivedDue = p.due.filter((id) => container.entryMeta(id)?.layer === 'archive');
                        appendEvent(config.containerRoot, 'publication', {
                            batch: p.dueBatch,
                            kind: 'due',
                            day: p.day,
                            ids: archivedDue,
                            note: p.prevCount === 0 ? '到期批次为空（今日无）'
                                : p.due.length === 0 ? '到期但全被钉住或已重新活跃'
                                    : archivedDue.length === p.due.length ? '到期执行'
                                        : archivedDue.length ? '到期部分执行（其余已重新活跃或被钉）' : '到期但全被钉住或已重新活跃',
                        }, logger);
                    }
                    // ② 本批公示（口径 A：**上一批未到期就不落新行**；空清单也落「今日无」）
                    if (!p.publishNew) {
                        // 单未结批次：不重签订阅期。安静等待，不刷行。
                    }
                    else if (!p.notice || p.duplicate) {
                        // 同墙钟日已落过 / 没有可公示内容
                    }
                    else if (p.prevDue && !pubSwept) {
                        // 到期了但扫描没跑（闸门拦下/半批抛错）⇒ 不落新批次，避免把到期债覆盖掉
                        logger.warn(`[P7] 到期批次 ${p.prevBatch ?? ''} 未执行（扫描未跑）⇒ 本次不落新批次，保留到期债`);
                    }
                    else {
                        appendEvent(config.containerRoot, 'publication', p.notice.ids.length
                            ? { batch: p.batch, ...p.notice, waiting: p.waiting, overLimit: p.overLimit }
                            : { batch: p.batch, day: p.day, ids: [], note: '今日无', publishedDay: p.notice.publishedDay, expireDay: p.notice.expireDay, ...(p.notice.publishedWallDay ? { publishedWallDay: p.notice.publishedWallDay, expireWallDay: p.notice.expireWallDay } : {}), waiting: p.waiting, overLimit: p.overLimit }, logger);
                    }
                }
            }
            catch (e) {
                logger.warn(`[P7] 公示落账失败（已忽略）：${e instanceof Error ? e.message : String(e)}`);
            }
    }
    /**
     * ── 【goal ④ · 2026-10-14】进程内**每日自检**：解除"不重启就停摆" ─────────────
     *
     * 三条路（**启动 / 定时 / 手动**）共用 `runDueSweep` ⇒ 闸门只有**一份实现**。
     * ⛔ 这里**绝不自己算**"今天扫过没有" —— 那会变成第二套判据（本仓今天的病）。
     *
     * 成本（查过控制流才敢写）：闸门说"不跑"时，`runSweep` **在 try/finally 之前就 return**
     * ⇒ **一次盘都不写**。所以每 10 分钟问一次的真实代价只是一次小 JSON 读。
     */
    if (config.containerRoot && config.decayDailyCheck) {
        if (config.publicNotice) {
            // 【P7 单生产者 · 2026-10-19】公示开启后**不注册定时扫描**：
            //   tick 跑一次就会推进“今天已扫”的闸门，而 due 的唯一消费点是启动路径
            //   ⇒ 当天的启动会被判 same-day，到期批次随即被当天的新公示覆盖（到期丢了）。
            //   代价：宿主长开不重启时衰减停摆——这是 P7 的已知边界，等公示周期口径定了再解。
            logger.info('[P7] 公示开启 ⇒ 定时自检不扫描（到期只由启动路径消费；避免 tick 先占掉当天闸门）');
        }
        else {
            const root = config.containerRoot;
            ctx.effect(() => {
                const tick = () => {
                    try {
                        const chainOverrideDaily = chainPlanForToday();
                        // 【监控修复】tick 也要落启动账（否则定时扫描在账上不可见）
                        const tickGate = resolveGateSnapshot(root, Date.now());
                        const out = runDueSweep({
                            gate: tickGate,
                            root,
                            ...(chainOverrideDaily ? { planOverride: chainOverrideDaily } : {}),
                            pins: loadPins(root),
                            entries: sweepEntries(container.getIndex().entries, undefined, container.getIndex().hot_order, injectionLedger.deliveredCounts()),
                            relocate: (id, layer, o) => writer.relocate(id, layer, o),
                            readLayer: (id) => container.getIndex().entries.find((e) => e.id === id)?.layer,
                            onStateWriteFail: (e) => ctx.logger?.error?.(`[decay] ⛔ 状态文件写入失败（定时自检，闸门无法推进）：${e instanceof Error ? e.message : String(e)}`),
                        });
                        if (out.ran) {
                            invalidateChainPlan(); // P1-2：同上，扫描成功后计划缓存失效
                            ctx.logger?.info?.(`[decay] 每日自检：已换日 ⇒ 扫了一批（归档 ${out.archived.length} 条）`);
                            try {
                                monitorStartup({ root, snap: tickGate.snap, sweep: out });
                            }
                            catch (e) {
                                ctx.logger?.warn?.(`[decay] tick 记账失败：${e instanceof Error ? e.message : String(e)}`);
                            }
                        }
                        // ⭐【步④c-α 收尾 · 2026-10-15】日志写失败 ⇒ **error 级报出来**（⛔ 不许静默）
                        //    为什么比 `onStateWriteFail` 更要紧：**停写旧件之后日志是唯一真源** ——
                        //    它静默失败 ⇒ 这一批没被记下 ⇒ 下次启动当"首启" ⇒ 同日可能重复扫描。
                        if (out.logWriteFailed) {
                            ctx.logger?.error?.('[decay] ⛔ 扫描日志写失败：**这一批没被记下** ⇒ 下次启动会当"首启"、同日可能重复扫描。查 .sweep-log.jsonl 的路径/权限。');
                        }
                    }
                    catch (e) {
                        // ⛔ **永不抛**：定时器里抛出去没人接
                        ctx.logger?.warn?.(`[decay] 每日自检失败（不影响运行）：${e instanceof Error ? e.message : String(e)}`);
                    }
                };
                const timer = setInterval(tick, DECAY_DAILY_CHECK_MS);
                // dispose 时清掉（⛔ 不留孤儿定时器 —— 与客户端那边 WakeHandle 是同一类纪律）
                return () => clearInterval(timer);
            }, 'memory-container: decay daily check');
        } // ── P7 公示未开启：定时自检照旧 ──
    }
    // ── 工具注册 ─────────────────────────────────────────────────
    // 生命周期 effect：dispose 时自动反注册（register 返回 disposer）
    ctx.effect(() => {
        const disposers = [];
        // current_time：时间**按需取**，不进系统提示词。
        // 为什么：时间行曾在提示词第 132 字符处每分钟一变 ⇒ 缓存前缀每分钟作废、
        // 全文按全价重算（实测 156 次、折算 ¥15.38）。工具化后提示词字节稳定，
        // 模型要判断时辰时自己调一次，拿到的时间一样真实。
        // 不受 allowWrite 影响：只读，与写入开关无关。
        disposers.push(ctx.tools.register(defineTool({
            name: 'current_time',
            description: '取当前真实时间（默认走本机配置时区，返回形如「当前时间：2026-09-15 22:15（周二）」）。' +
                '系统提示词里不含时间——凡是要判断时辰（催作息、算耗时、说「今天/现在」）之前，先调这个工具，' +
                '不要凭对话上下文猜时间。可选传 timezone（IANA 名，如 UTC）查别的时区。',
            parameters: {
                timezone: { type: 'string', description: 'IANA 时区名，如 Asia/Shanghai、UTC；缺省用本机配置时区' },
            },
            output: {
                schema: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        ok: { type: 'boolean', required: true },
                        line: { type: 'string' },
                        timezone: { type: 'string' },
                        is_default: { type: 'boolean' },
                        error: { type: 'string' },
                    },
                },
                render: (_args, value) => [
                    {
                        type: 'text',
                        text: value?.ok
                            ? `[current_time] ${value.line}`
                            : `[current_time] 取时间失败: ${value?.error ?? 'unknown error'}`,
                    },
                ],
            },
            async execute(args) {
                return currentTime(args, config.timeZone);
            },
        })));
        disposers.push(ctx.tools.register(defineTool({
            name: 'memory_load',
            description: '按 id 加载容器条目全文（archive/longterm）。入参 { id: string }',
            parameters: {
                id: { type: 'string', required: true, description: '条目 id，如 a01 / l02' },
            },
            output: {
                schema: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        ok: { type: 'boolean', required: true },
                        id: { type: 'string' },
                        title: { type: 'string' },
                        content: { type: 'string' },
                        scope: { type: 'string' },
                        scope_id: { type: 'string' },
                        temporal_state: { type: 'string' },
                        /** 【post-Scoped 增量】被哪一条取代（非现行条目才有）——用于在渲染里报警 */
                        superseded_by: { type: 'string' },
                        source: { type: 'string' },
                        source_line: { type: 'string' },
                        source_session: { type: 'string' },
                        source_message: { type: 'string' },
                        where: { type: 'string' },
                        error: { type: 'string' },
                    },
                },
                render: (_args, value) => [
                    {
                        type: 'text',
                        text: value.ok
                            ? `[memory_load] ${value.id} ${value.title}${truthMark(value)}\n\n${value.content}`
                            : `[memory_load] ${value.error ?? 'unknown error'}`,
                    },
                ],
            },
            async execute(args) {
                const entry = container.readEntry(args.id);
                // ── 库文件兜底（2026-09-30）──────────────────────────────
                // 容器里找不到时，查登记表：命中就按路径读库里的文件。
                // 为什么放这里而不是新开一个工具：**调用方不该关心它住在哪**——
                // 检索给什么 id，load 就取什么。
                if (!entry) {
                    const reg = vaultRegistry.entries.find((e) => e.id === args.id);
                    if (reg) {
                        try {
                            const text = fs.readFileSync(reg.abs, 'utf-8');
                            const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
                            return {
                                ok: true,
                                ...withoutUndefined({
                                    id: reg.id,
                                    title: reg.note || reg.path.split('/').pop() || reg.id,
                                    content: body,
                                    scope: 'global',
                                    temporal_state: 'vault',
                                    source: reg.path,
                                    where: 'vault',
                                }),
                            };
                        }
                        catch (error) {
                            return { ok: false, error: `库文件读取失败: ${reg.path}（${String(error)}）` };
                        }
                    }
                    return { ok: false, error: `条目不存在: ${args.id}` };
                }
                if (!isInScope(entry.frontmatter, scopeContext)) {
                    return { ok: false, error: `条目不存在或不在当前作用域: ${args.id}` };
                }
                return {
                    ok: true,
                    ...withoutUndefined({
                        id: args.id,
                        title: entry.frontmatter.title,
                        content: entry.content,
                        scope: memoryScope(entry.frontmatter),
                        scope_id: entry.frontmatter.scope_id,
                        temporal_state: temporalState(entry.frontmatter),
                        superseded_by: entry.frontmatter.superseded_by,
                        source: entry.frontmatter.source || undefined,
                        source_line: entry.frontmatter.source_line,
                        source_session: entry.frontmatter.source_session,
                        source_message: entry.frontmatter.source_message,
                    }),
                };
            },
        })));
        disposers.push(ctx.tools.register(defineTool({
            name: 'memory_search',
            description: '在长期记忆中检索，返回命中的条目 id/标题/片段。入参 { query, top_k? }',
            parameters: {
                query: { type: 'string', required: true, description: '检索关键词' },
                top_k: { type: 'number', description: '返回条数，默认 5' },
            },
            output: {
                schema: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        ok: { type: 'boolean', required: true },
                        query: { type: 'string' },
                        hits: {
                            type: 'array',
                            items: {
                                type: 'object',
                                additionalProperties: false,
                                properties: {
                                    id: { type: 'string' },
                                    layer: { type: 'string' },
                                    title: { type: 'string' },
                                    score: { type: 'number' },
                                    snippet: { type: 'string' },
                                    tags: { type: 'array', items: { type: 'string' } },
                                    file: { type: 'string' },
                                    reasons: { type: 'array', items: { type: 'string' } },
                                    scope: { type: 'string' },
                                    scope_id: { type: 'string' },
                                    temporal_state: { type: 'string' },
                                    source: { type: 'string' },
                                    source_line: { type: 'string' },
                                    source_session: { type: 'string' },
                                    source_message: { type: 'string' },
                                    // 库登记表条目专用（2026-09-30）：
                                    // where='vault' 表示它**不在容器里**，取全文要 memory_load id（走路径读）
                                    where: { type: 'string' },
                                    path: { type: 'string' },
                                },
                            },
                        },
                    },
                },
                render: (_args, value) => {
                    const hitLines = (value.hits ?? [])
                        .map((h) => {
                        const reasons = h.reasons?.length ? `；${h.reasons.join('；')}` : '';
                        const source = h.source ? `；来源 ${h.source}${h.source_line ? `:${h.source_line}` : ''}` : '';
                        return `- ${h.id} ${h.title} (BM25 ${h.score}): ${h.snippet}${reasons}${source}`;
                    });
                    return [
                        {
                            type: 'text',
                            text: `[memory_search] ${value.query}\n` +
                                (hitLines.length > 0 ? hitLines.join('\n') : '  (无命中)'),
                        },
                    ];
                },
            },
            async execute(args) {
                const topK = args.top_k ?? config.searchTopK;
                const hits = searchLongterm(container, args.query, {
                    topK,
                    layerFilter: config.searchArchive ? ['longterm', 'archive'] : ['longterm'],
                    scopeContext,
                    enableLexicon: config.enableLexicon,
                });
                // ── 库登记表条目并入（2026-09-30）─────────────────────────
                // 它们在**容器外**，所以不进上面那次检索；单独打一次分再合并。
                // 字段多一个 `where`：容器条目是 'container'，库文件是 'vault'——
                // **调用方要能一眼看出"这条不在容器里，取全文要按路径去库**。
                // ── 量纲校准（2026-09-30）─────────────────────────────────
                // 两套打分器不可比：容器 BM25（可达 20+）vs 库词频归一（约 1~2）。
                // 不校准 = 库条目永远沉底。做法：把库分数按「容器最高分 / 库最高分」等比放大，
                // 让两边**各自的第一名**站在同一水平线上；再由 vaultHitWeight 调保守程度。
                const rawVault = scoreRegistry(vaultRegistry.entries, args.query, topK);
                const maxContainer = hits.length ? Math.max(...hits.map((h) => h.score ?? 0)) : 0;
                const maxVault = rawVault.length ? Math.max(...rawVault.map((v) => v.score)) : 0;
                const scale = maxVault > 0 && maxContainer > 0 ? maxContainer / maxVault : 0;
                const weight = Number(config.vaultHitWeight ?? 1);
                const vaultHits = rawVault.map((e) => ({
                    id: e.id,
                    title: e.note || e.path.split('/').pop() || e.id,
                    score: e.score * scale * weight,
                    snippet: `${e.tags} · ${e.path}`,
                    reasons: ['库登记表命中'],
                    where: 'vault',
                    path: e.path,
                }));
                // 排序：两边都是"越大越相关"，直接混排后截断
                // ⚠️ 容器条目**不能**带 `path: undefined` —— 带上去会让返回值不是 lossless JSON，
                //    宿主当场拒收（实测报 `tool returned invalid output: value is not lossless JSON`）。
                //    所以两条路径各自 only-有则加：容器条目只加 where，库条目才带 path。
                const merged = [
                    ...hits.map((h) => ({ ...h, where: 'container' })),
                    ...vaultHits,
                ].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, topK);
                // 收口（2026-10-06 · S1）：全仓工具返回统一走 withoutUndefined，
                // 由 test/tool-output-schema.test.mjs 机械守着——裸对象 return 会被判红。
                return withoutUndefined({ ok: true, query: args.query, hits: merged });
            },
        })));
        // ── V1.0 写入工具（仅 allowWrite=true 注册） ──────────
        // 诚实口径：工具契约负责「推断/情绪/总结 → 只能走 propose」的语义指引（软层）；
        // 候选隔离（propose 物理上无转正通道）是硬兜底。任何描述不得写成"物理防污染"。
        if (config.allowWrite) {
            const fail = (error) => error instanceof WriteError ? { ok: false, error: error.message } : { ok: false, error: String(error) };
            // ── 【B2 · P7】钉住工具：被钉住的条目永不遗忘（pins.json 原子落盘）──────────
            disposers.push(ctx.tools.register(defineTool({
                name: 'memory_pin',
                description: '钉住或取消钉住一条记忆。钉住的条目永不遗忘；写入 pins.json（原子）。',
                parameters: {
                    id: { type: 'string', required: true, description: '条目 id' },
                    pinned: { type: 'boolean', required: true, description: 'true=钉住，false=取消' },
                },
                output: {
                    schema: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            ok: { type: 'boolean', required: true },
                            id: { type: 'string' },
                            pinned: { type: 'boolean' },
                            error: { type: 'string' },
                        },
                    },
                    render: (_args, value) => [{
                            type: 'text',
                            text: value?.ok
                                ? `[钉住] ${value.id} → ${value.pinned ? '已钉住（永不遗忘）' : '已取消钉住'}`
                                : `[钉住失败] ${value?.error ?? 'unknown'}`,
                        }],
                },
                async execute(args) {
                    try {
                        const state = setPin(config.containerRoot, String(args.id), Boolean(args.pinned));
                        if (state === null)
                            return withoutUndefined({ ok: false, error: 'pins.json 写入失败（未落盘，不谎报已钉）' });
                        // 【P6/P7】钉住变了：档位/计划/hot 缓存全部作废（否则当天 pin 不生效）
                        hotCacheDirty = true;
                        chainTierCache = null;
                        chainPlanDay = '';
                        chainPlanCache = null;
                        return withoutUndefined({ ok: true, id: String(args.id), pinned: state });
                    }
                    catch (e) {
                        return fail(e);
                    }
                },
            })));
            disposers.push(ctx.tools.register(defineTool({
                name: 'memory_remember',
                description: '仅在用户【明确要求记住】时调用：保存用户亲口说出的事实、偏好、决定（如「记住我…」「以后都…」）。' +
                    '模型自己的推断、规律总结、情绪判断、跨域联想【一律不得】用本工具，必须改用 memory_propose。' +
                    '无法确认是否用户明说时，默认走 memory_propose（保守优先）。' +
                    '记忆分类 memory_type：opinion=用户的偏好/判断（会自动常驻注入），world=客观事实，experience=亲历事件。',
                parameters: {
                    content: { type: 'string', required: true, description: '记忆正文，一句话说清，不含解释' },
                    title: { type: 'string', required: true, description: '标题，不超过 40 字' },
                    memory_type: { type: 'string', required: true, description: 'experience | world | opinion' },
                    decay_type: { type: 'string', description: '衰减类型 core | recent | process。缺省 recent；只有"底线/身份/永远不会过时"的内容才显式 core，core 不会自动判定' },
                    tags: { type: 'array', items: { type: 'string' }, description: '标签' },
                    about: { type: 'array', items: { type: 'string' }, description: '次事 subject（可多个；主事由会话级决定，不填这里）' },
                    priority: { type: 'number', description: '排序参考值，默认 60（不影响是否常驻）' },
                    scope: { type: 'string', description: 'global | workspace | project，默认 global' },
                    scope_id: { type: 'string', description: 'scope 非 global 时必填' },
                    valid_from: { type: 'string', description: 'ISO 时间；未来生效' },
                    valid_to: { type: 'string', description: 'ISO 时间；到期失效' },
                    summary: { type: 'string', description: '摘要，留空则取正文前 80 字' },
                    source_message: { type: 'string', required: true, description: '来源消息 id（插件会随调用上下文填充）' },
                },
                output: {
                    schema: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            ok: { type: 'boolean', required: true },
                            id: { type: 'string' },
                            old_id: { type: 'string' },
                            new_id: { type: 'string' },
                            version: { type: 'number' },
                            layer: { type: 'string' },
                            mode: { type: 'string' },
                            temporal_state: { type: 'string' },
                            hot_state: { type: 'string' },
                            duplicate: { type: 'string' },
                            title_collision: { type: 'string' },
                            scope_collision: { type: 'string' },
                            error: { type: 'string' },
                        },
                    },
                    render: (_args, value) => {
                        if (!value?.ok)
                            return [{ type: 'text', text: `[写入失败] ${value?.error ?? 'unknown error'}` }];
                        const hot = value.hot_state ? `\n常驻状态: ${value.hot_state}` : '';
                        const chain = value.old_id
                            ? `\n${value.old_id} → ${value.new_id}（version ${value.version}，旧版本已标 superseded）`
                            : '';
                        // 判重与撞车必须**显式说出来**：静默吸收=模型以为写了条新记忆，实际没有；
                        // 静默放过=同一件事堆两条。两种静默都会让后续检索失真。
                        const dup = value.duplicate
                            ? `\n[判重] 内容已存在（${value.duplicate}），未新建；已记一次 access`
                            : '';
                        const collide = value.title_collision
                            ? `\n[标题撞车] 已有同名条目 ${value.title_collision}，正文不同故未合并 —— 若其实是同一件事，请用 memory_update 纠正它；否则换一个标题。`
                            : '';
                        const scoped = value.scope_collision
                            ? `\n[跨作用域同文] 已有同文条目 ${value.scope_collision} 在**另一个作用域**里 —— 按口径不合并（各归各），本条已新建。`
                            : '';
                        return [{
                                type: 'text',
                                text: `[写入成功] ${value.id ?? value.new_id} 已落到 ${value.layer ?? 'longterm'}${chain}${hot}${dup}${collide}${scoped}`,
                            }];
                    },
                },
                async execute(args, exec) {
                    try {
                        const { input, idSource } = hostWriteContext(exec, args);
                        const outcome = writer.remember(input, { sessionId: String(input.source_session), idSource });
                        // ⚠️ 必须过 `withoutUndefined`：宿主对工具返回做 lossless JSON 校验，
                        //    值里出现 undefined 会**整条**被拒收（INVALID_TOOL_OUTPUT）。
                        //    2026-10-06 审计 P0-1 实测：判重吸收分支不带 version / temporal_state
                        //    （`absorbDuplicate` 只回 ok/id/layer/duplicate），这两个字段就成了 undefined。
                        //    下方那行注释从 2026-09-30 起就写着"不许出现 undefined"——
                        //    **注释约束不住分支**，所以改成机械收口。
                        return withoutUndefined({
                            ok: true,
                            id: outcome.id,
                            layer: outcome.layer,
                            version: outcome.version,
                            temporal_state: outcome.temporal_state,
                            ...(outcome.duplicate ? { duplicate: `${outcome.duplicate.via}:${outcome.duplicate.id}` } : {}),
                            ...(outcome.title_collision ? { title_collision: outcome.title_collision.id } : {}),
                            ...(outcome.scope_collision ? { scope_collision: outcome.scope_collision.id } : {}),
                            hot_state: outcome.hot_order
                                ? `已自动常驻 hot_order（${outcome.hot_order.before.length} → ${outcome.hot_order.after.length} 条）`
                                : '未进 hot_order（仅按需检索）',
                        });
                    }
                    catch (error) {
                        return fail(error);
                    }
                },
            })));
            disposers.push(ctx.tools.register(defineTool({
                name: 'memory_update',
                description: '纠正既有记忆：用户说「我说错了」「改成…」「不是这样」时调用。' +
                    '不覆盖旧条目——会生成新版本并把旧版本标为 superseded，历史可追溯、可回退。',
                parameters: {
                    id: { type: 'string', required: true, description: '要纠正的条目 id' },
                    content: { type: 'string', description: '新的正文（与 title 至少给一项）' },
                    title: { type: 'string', description: '新的标题' },
                    tags: { type: 'array', items: { type: 'string' }, description: '新的标签' },
                    about: { type: 'array', items: { type: 'string' }, description: '次事 subject（可多个）' },
                    reason: { type: 'string', required: true, description: '纠正原因，一句话' },
                    valid_from: { type: 'string', description: 'ISO 时间；未来生效' },
                    valid_to: { type: 'string', description: 'ISO 时间；到期失效' },
                    source_message: { type: 'string', required: true, description: '来源消息 id' },
                },
                output: {
                    schema: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            ok: { type: 'boolean', required: true },
                            id: { type: 'string' },
                            old_id: { type: 'string' },
                            new_id: { type: 'string' },
                            version: { type: 'number' },
                            layer: { type: 'string' },
                            mode: { type: 'string' },
                            temporal_state: { type: 'string' },
                            hot_state: { type: 'string' },
                            error: { type: 'string' },
                        },
                    },
                    render: (_args, value) => {
                        if (!value?.ok)
                            return [{ type: 'text', text: `[写入失败] ${value?.error ?? 'unknown error'}` }];
                        const hot = value.hot_state ? `\n常驻状态: ${value.hot_state}` : '';
                        const chain = value.old_id
                            ? `\n${value.old_id} → ${value.new_id}（version ${value.version}，旧版本已标 superseded）`
                            : '';
                        return [{
                                type: 'text',
                                text: `[写入成功] ${value.id ?? value.new_id} 已落到 ${value.layer ?? 'longterm'}${chain}${hot}`,
                            }];
                    },
                },
                async execute(args, exec) {
                    try {
                        const { input, idSource } = hostWriteContext(exec, args);
                        const outcome = writer.update(String(input.id), input, { sessionId: String(input.source_session), idSource });
                        return withoutUndefined({
                            ok: true,
                            id: outcome.new_id,
                            old_id: outcome.old_id,
                            new_id: outcome.new_id,
                            version: outcome.version,
                            layer: 'longterm',
                            hot_state: outcome.hot_order
                                ? `hot_order ${outcome.hot_order.before.length} → ${outcome.hot_order.after.length} 条` +
                                    (outcome.hot_order.added.length ? `（新版本原位继承槽位）` : '（两版一并退出常驻）')
                                : undefined,
                        });
                    }
                    catch (error) {
                        return fail(error);
                    }
                },
            })));
            disposers.push(ctx.tools.register(defineTool({
                name: 'memory_forget',
                description: '撤销当前有效记忆：用户说「忘掉这件事」「删掉这条」「别再提了」时调用。' +
                    '默认写墓碑（保留可审计记录、不再被召回），不做物理删除；物理删除需显式 mode="purge" 且插件开启 allowPurge。',
                parameters: {
                    id: { type: 'string', required: true, description: '要撤销的条目 id' },
                    reason: { type: 'string', required: true, description: '撤销原因' },
                    mode: { type: 'string', description: 'tombstone（默认）| purge（需 allowPurge=true）' },
                    source_message: { type: 'string', required: true, description: '来源消息 id' },
                },
                output: {
                    schema: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            ok: { type: 'boolean', required: true },
                            id: { type: 'string' },
                            old_id: { type: 'string' },
                            new_id: { type: 'string' },
                            version: { type: 'number' },
                            layer: { type: 'string' },
                            mode: { type: 'string' },
                            temporal_state: { type: 'string' },
                            hot_state: { type: 'string' },
                            // 2026-10-06：忘掉 = 整条版本血脉一起抹（作者 拍板 (a)）。
                            // 把条数报出来 —— 改行为必须同时改可观测性，否则调用方
                            // 看不出这次删的是一条还是一串。
                            wiped_versions: { type: 'number' },
                            purge_leftover: { type: 'array', items: { type: 'string' } },
                            error: { type: 'string' },
                        },
                    },
                    render: (_args, value) => {
                        // 这条 render 原先是从 memory_update 复制过来的（写"已落到 longterm"，
                        // 还带着 old_id→new_id 的版本链文案）——对一次**删除**是错的。
                        // 顺带把"抹了几个版本"播出来：整条血缘被抹时，调用方必须看得见。
                        if (!value?.ok)
                            return [{ type: 'text', text: `[写入失败] ${value?.error ?? 'unknown error'}` }];
                        const hot = value.hot_state ? `\n常驻状态: ${value.hot_state}` : '';
                        const wiped = Number(value.wiped_versions) > 1
                            ? `\n连同 ${Number(value.wiped_versions) - 1} 个历史版本一并抹除（该条的回退能力随之消失）`
                            : '';
                        const leftover = Array.isArray(value.purge_leftover) && value.purge_leftover.length
                            ? `\n⚠️ 暂存文件未删干净（正文仍在）：${value.purge_leftover.join(', ')}`
                            : '';
                        return [{
                                type: 'text',
                                text: `[已遗忘] ${value.id}（${value.mode ?? 'tombstone'}）${wiped}${hot}${leftover}`,
                            }];
                    },
                },
                async execute(args, exec) {
                    try {
                        const { input, idSource } = hostWriteContext(exec, args);
                        const outcome = writer.forget(String(input.id), input, { sessionId: String(input.source_session), idSource, op: 'memory_forget', operator: 'assistant', reason: String(input.reason ?? '') });
                        return withoutUndefined({
                            ok: true,
                            id: outcome.id,
                            mode: outcome.mode,
                            layer: 'longterm',
                            temporal_state: outcome.temporal_state,
                            wiped_versions: outcome.wiped_versions,
                            // 【P1】purge 未清干净时必须透出来（否则“物理删除”假成功）
                            purge_leftover: outcome.purge_leftover,
                        });
                    }
                    catch (error) {
                        return fail(error);
                    }
                },
            })));
            disposers.push(ctx.tools.register(defineTool({
                name: 'memory_propose',
                description: '把【你自己推断出来的】内容送进候选区等人工确认：规律总结、模式识别、情绪判断、跨域联想，' +
                    '以及任何无法确认是用户明说的内容。候选区不进检索、不进常驻注入，也【没有】模型自助转正工具——' +
                    '必须由人（设置页 / CLI）确认后才会成为正式记忆。注意：用户明确要求记住的内容请用 memory_remember。',
                parameters: {
                    content: { type: 'string', required: true, description: '候选内容' },
                    title: { type: 'string', required: true, description: '标题' },
                    memory_type: { type: 'string', required: true, description: 'experience | world | opinion' },
                    decay_type: { type: 'string', description: '衰减类型 core | recent | process。候选区缺省 process（快衰），一般不用显式给' },
                    tags: { type: 'array', items: { type: 'string' }, description: '标签' },
                    about: { type: 'array', items: { type: 'string' }, description: '次事 subject（可多个；主事由会话级决定，不填这里）' },
                    confidence: { type: 'number', description: '模型自评置信度（仅参考，不参与判定）' },
                    scope: { type: 'string', description: 'global | workspace | project' },
                    scope_id: { type: 'string', description: 'scope 非 global 时必填' },
                    source_message: { type: 'string', required: true, description: '来源消息 id' },
                },
                output: {
                    schema: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            ok: { type: 'boolean', required: true },
                            id: { type: 'string' },
                            old_id: { type: 'string' },
                            new_id: { type: 'string' },
                            version: { type: 'number' },
                            layer: { type: 'string' },
                            mode: { type: 'string' },
                            temporal_state: { type: 'string' },
                            hot_state: { type: 'string' },
                            duplicate: { type: 'string' },
                            title_collision: { type: 'string' },
                            scope_collision: { type: 'string' },
                            error: { type: 'string' },
                        },
                    },
                    render: (_args, value) => {
                        if (!value?.ok)
                            return [{ type: 'text', text: `[写入失败] ${value?.error ?? 'unknown error'}` }];
                        const dup = value.duplicate
                            ? `\n[判重] 内容已存在于 ${value.duplicate}，未再建候选（候选区不堆重复）`
                            : '';
                        const collide = value.title_collision
                            ? `\n[标题撞车] 已有同名条目 ${value.title_collision}，正文不同故未合并 —— 换一个更贴切的标题。`
                            : '';
                        const scoped = value.scope_collision
                            ? `\n[跨作用域同文] 已有同文条目 ${value.scope_collision} 在**另一个作用域**里 —— 按口径不合并（各归各），本条已新建。`
                            : '';
                        return [{
                                type: 'text',
                                text: `[候选已登记] ${value.id} 落到 ${value.layer}${dup}${collide}${scoped}`,
                            }];
                    },
                },
                async execute(args, exec) {
                    try {
                        const { input, idSource } = hostWriteContext(exec, args);
                        const outcome = writer.propose(input, { sessionId: String(input.source_session), idSource });
                        // 【P8】自动转正（默认关）：每活跃日 ≤3、真会话 id；⛔ 只转本工具刚写的候选
                        let promoted = false;
                        // 【P0-2 修复】判重吸收不许转“别的会话的旧候选”；且必须重读目标真身（type/layer/title）
                        const target = outcome.id ? container.entryMeta(outcome.id) : undefined;
                        const basePromotable = Boolean(config.autoPromote && outcome.ok && outcome.id
                            && !outcome.duplicate
                            && target?.layer === 'pending'
                            && target?.memory_type !== 'opinion'
                            && input.memory_type !== 'opinion');
                        const promotable = Boolean(basePromotable && chainQualified(input));
                        if (basePromotable && outcome.id && !autoPromoteBatch)
                            autoPromoteBatch = `auto-promote-${dayKey(new Date())}-${process.pid}`;
                        if (basePromotable && !promotable && outcome.id) {
                            const today = dayKey(new Date());
                            if (!autoPromoteBatch)
                                autoPromoteBatch = `auto-promote-${today}-${process.pid}`;
                            const c = chainFieldsOf(input);
                            appendAutoPromoteAudit(config.containerRoot, {
                                batch: autoPromoteBatch, at: new Date().toISOString(), id: outcome.id,
                                action: 'blocked', operator: 'auto', source_session: String(input.source_session ?? ''),
                                before: { layer: target?.layer ?? 'pending', about: c.about, scope: c.scope ?? null, scope_id: c.scope_id ?? null, memory_type: c.memory_type ?? null },
                                reason: 'missing-chain-fields',
                            });
                        }
                        if (promotable && outcome.id) {
                            const today = dayKey(new Date());
                            if (autoPromoteDay !== today) {
                                autoPromoteDay = today;
                                autoPromoteCount = readAutoPromote().day === today ? readAutoPromote().count : 0;
                            }
                            // 标题闸门用**目标自己的 title**（吸收/旧候选场景下 input.title 不可信）
                            const title = String(target?.title ?? '').trim();
                            const collision = title.length > 0 && container.getIndex().entries.some((e) => e.id !== outcome.id
                                && e.layer !== 'pending'
                                // 【修复】墓碑/被替代条目不挡；跨 scope 同名不算碰撞
                                && e.status !== 'superseded'
                                && (!target?.scope || !e.scope || e.scope === target.scope)
                                && String(e.title ?? '').trim() === title);
                            const pick = collision ? [] : selectPromotable([{ id: outcome.id, source_session: String(input.source_session) }], autoPromoteCount);
                            if (pick.length) {
                                try {
                                    writer.confirm(pick[0], { operator: 'auto' });
                                    autoPromoteCount = bumpAutoPromote(today);
                                    promoted = true;
                                    const c = chainFieldsOf(input);
                                    const after = container.entryMeta(outcome.id);
                                    appendAutoPromoteAudit(config.containerRoot, {
                                        batch: autoPromoteBatch, at: new Date().toISOString(), id: outcome.id,
                                        action: 'promoted', operator: 'auto', source_session: String(input.source_session ?? ''),
                                        before: { layer: 'pending', about: c.about, scope: c.scope ?? null, scope_id: c.scope_id ?? null, memory_type: c.memory_type ?? null },
                                        after: { layer: after?.layer ?? 'longterm', about: c.about, scope: after?.scope ?? c.scope ?? null, scope_id: after?.scope_id ?? c.scope_id ?? null, memory_type: after?.memory_type ?? c.memory_type ?? null },
                                        reason: 'chain-qualified',
                                    });
                                }
                                catch (e) {
                                    logger.warn(`[P8] 自动转正失败（留 pending）：${e instanceof Error ? e.message : String(e)}`);
                                }
                            }
                        }
                        return withoutUndefined({
                            ok: true,
                            id: outcome.id,
                            // 判重吸收时命中的可能是**正式记忆**（不是 pending）—— 这里必须报真实落点，不许写死 'pending'
                            layer: promoted ? 'longterm' : (outcome.layer ?? 'pending'),
                            version: outcome.version,
                            ...(outcome.duplicate ? { duplicate: `${outcome.duplicate.via}:${outcome.duplicate.id}` } : {}),
                            ...(outcome.title_collision ? { title_collision: outcome.title_collision.id } : {}),
                            ...(outcome.scope_collision ? { scope_collision: outcome.scope_collision.id } : {}),
                        });
                    }
                    catch (error) {
                        return fail(error);
                    }
                },
            })));
            logger.info('写入工具已注册 (allowWrite=on): remember / update / forget / propose');
        }
        else {
            logger.info('写入工具未注册 (allowWrite=off)：容器保持只读');
        }
        return () => {
            for (const dispose of disposers)
                dispose();
        };
    }, 'memory-container.tools');
    // ── 设置页数据 API（HTTP） ─────────────────────────────────────
    // 注册到 webServer：GET /list、GET /entry/:id、（allowEdit 时）PUT /entry/:id。
    // 调度逻辑与工具注册一致：ctx.effect 生命周期，dispose 时反注册路由。
    ctx.effect(() => {
        const disposers = [];
        const paths = new Set([config.apiPrefix, '/api/memory']);
        try {
            for (const apiPath of paths) {
                const { handler } = createMemoryApi(container, {
                    prefix: apiPath,
                    allowEdit: config.allowEdit,
                    chainStore,
                    // ⭐【2026-10-17】只读端点与启动路径同一口径（否则"计划动几条"与真身扫描会分叉）
                    deliveredCounts: () => injectionLedger.deliveredCounts(),
                    // 【P7】单生产者：手动扫描与自动路径同一来源（chainJudge=false ⇒ undefined ⇒ 旧行为）
                    // 【P7 顺序修复】公示开启后手动路也**不搬**：一次点击不是“沉默 N 个活跃日”的同意，
                    //   due 只由启动路径消费（⛔ 否则 /decay-sweep 就成了绕过公示的后门）
                    chainPlan: config.publicNotice ? () => emptyDecayPlan()
                        : !config.chainJudge ? undefined : () => chainPlanForToday(true),
                    // UI 链镜头：真实档位（只读，不触发扫描/模型）。chainJudge 关时返回空。
                    uiHtml: () => buildExactUiHtml({ onboardingNeeded: onboardingState(config.containerRoot, PRODUCT.productVersion).needed, container, subjects, ledger: injectionLedger, token: apiToken, apiPrefix: apiPath, chainStore, allowEdit: config.allowEdit, chainUnavailableReason }),
                    suggest: async (body) => {
                        const count = Math.min(5, Math.max(3, Number(body?.count) || 3));
                        const useHistory = body?.useHistory !== false;
                        const names = ['小满', '阿澈', '青禾', '予安', '岚', '简', '星野', '南风', '时序', '少白'];
                        const vibes = ['稳一点，先听你说完', '直接，不绕弯', '安静但记得住细节', '有点锋利，能帮你拦坑', '轻快，负责把事接住'];
                        const titles = useHistory
                            ? container.getIndex().entries.filter((e) => e.layer === 'hot').map((e) => String(e.title || '')).filter((t) => t && !/Teddy|Helena|杨天雨|杨瑾|瑾瑾/i.test(t)).slice(0, 6)
                            : [];
                        const local = () => Array.from({ length: count }, (_, i) => ({ name: names[i % names.length], gender: '不设定', vibe: titles.length && i === 1 ? `像「${titles[0]}」这条记忆一样，先接住语境` : vibes[i % vibes.length] }));
                        return { source: titles.length ? 'history+template' : 'generic', cards: local() };
                    },
                    pin: (id, pinned) => setPin(config.containerRoot, id, pinned),
                    subjects: () => subjects.list(),
                    tiers: () => {
                        if (!config.chainJudge)
                            return {};
                        try {
                            const r = computeTierOverrides(container, subjects, injectionLedger, CHAIN_H, CHAIN_THETA);
                            const out = {};
                            for (const [id, mode] of r.map) {
                                out[id] = mode === 'summary' ? 'snapshot' : mode === 'title' ? 'outline' : mode === 'none' ? 'forgotten' : 'full';
                            }
                            return out;
                        }
                        catch {
                            return {};
                        }
                    },
                    // 【P2-6 修复】公示开启时手动扫描连闸门都不碰：空计划跑一次会推进 lastAutoAt，
                    //   把当天启动的 due 饿掉。改为直接告诉调用方“为什么这次不跑”。
                    sweepDisabledReason: config.publicNotice
                        ? '公示开启：到期只由启动路径消费（手动扫描不执行，避免绕过订阅期/吃掉当天闸门）'
                        : undefined,
                    // 【P1-4】状态写失败必须从手动路也能报出来（与启动/tick 同一出口）
                    onStateWriteFail: (e) => logger.error(`[decay] ⛔ 状态文件写入失败（手动扫描，闸门无法推进）：${e instanceof Error ? e.message : String(e)}`),
                    // 【C-0 · H1/H2/H3】三个新通道要的东西：
                    //   · productVersion —— 「认识一下」拿它比对（⛔ 不另立第二个版本号）
                    //   · containerRoot  —— `.onboarded` / `identity/profile.json` 的落点 + 修订探针的靶子
                    productVersion: PRODUCT.productVersion, // ← 唯一真源（见文件头 PRODUCT）
                    containerRoot: config.containerRoot,
                    scopeContext,
                    writer,
                    token: apiToken,
                    guardHost: config.guardHost,
                    // 排障自检（只读）：把「动态预算是否真的在采样」「压缩接入点是否真的可达」
                    // 变成可 curl 的事实 —— 否则这两件事只存在于日志里，无法验证。
                    introspect: async () => ({
                        // 版本口径：**归 作者 拍板**，不许自行改。
                        // 'baseline' 会同时出现在 /api/memory/selftest 与本地插件管理器面板上，
                        // 所以它必须是**当前真实形态**——2026-09-30 之前这里一直写着 'v1.1 性能地基'，
                        // 而那时已经装了路由引擎，面板因此显示过时版本。
                        //
                        // 2026-10-03：作者 拍板定名 **MemoryV1.2**（原值 MemoryV1.1-Exact）。
                        // 定名依据：四件正事（出口 / 标定 / 接线 / 清悬空）全部落地并在线上验过，
                        // 证据见 00_记忆系统/docs/MemoryV1.2-验收报告_20261003.md。
                        // 回滚口径：改回 'MemoryV1.1-Exact' 即回到上一版的对外表述（代码无需回退）。
                        // 版本口径的唯一真源（进 /selftest 出口，可审计）：
                        //   baseline     = 锚点（**定版点**），不随每个小版本变 —— 但**随大版本切一次**
                        //   productVersion = 发布版，随每次发布改
                        // 2026-10-09（V1.3-A）：锚点由 `MemoryV1.2` 切到 **`MemoryV1.3`**（作者 拍板）。
                        //   ⚠️ 切的时候这句注释必须一起改 —— 原话是「恒指定版点，不随发布变」，
                        //   锚点都动了而注释不动，注释本身就成了谎。切完 B/C 两版⛔ 不再动它。
                        // ⚠️ 两套号必须同时动（2026-10-06 纪律）：0.7.0 曾被三个产品版共用，
                        //    审计报告因此说"仅凭版本字符串不足以确认已包含哪组修复"。
                        // 2026-10-09（**A.1**）：A 段之后又落地了四段（安全修复 / 投递账本 / 四项独立修复 / 一天统一），
                        //   其中**四处是行为改动**（去重投递、唤起≡注入、缓存失效触发、日界提前 8 小时）⇒
                        //   'A = 零行为改动的地基' 这个描述已经不成立，故切 **A.1**（作者 拍板：切）。
                        //   2026-10-10 切 **B**：A.1 当时的理由写着"不占 B 位，因为衰减引擎没做" ——
                        //   而今天引擎已经做完并上线（E1/E2/E3，含权重重标定）⇒ **那个理由不再成立**，
                        //   号必须跟着内容走（同 A→A.1 的同一条逻辑）。
                        //   anchor 仍是 MemoryV1.3：**锚点随大版本切一次**，不随小版本动。
                        product: { ...PRODUCT },
                        // 【D0 · 部署状态物化】"现在跑的是哪一版"的**机械答案**（2026-10-09）。
                        // `product` 是这版代码**自称**是谁；这一块才是**盘上与进程内是否同一个构建**：
                        //   stale: true ⇒ 盘上的产物已经换了、而进程里跑的还是启动时那份 ⇒ **必须重启**。
                        // 为什么不做成"自动重载"：热重载会让"正在跑的代码"随时变，难以复现问题；
                        // 这里只做**如实报告**，重启与否由人决定。
                        build: buildIdentity(import.meta.dirname, buildAtStart),
                        // 【D3 · 常驻名单审计】非抛出的一致性清单（空数组 = 一致）。
                        // 为什么必须有：`h10` 掉了 6 周没人知道 —— 既有校验只查单向。
                        hot_audit: container.hotAudit,
                        // 【E · 1.4】「一天」归谁管 —— 这是那个**单一权威**的可读读数。
                        // 带上本例：人一眼就能核对"当地日末"是不是他理解的那个时刻（⛔ 不是靠读代码）。
                        // 【E3】新鲜度参数：**标定状态必须可读**（calibrated:false = 初值由 A 段分布推来，未标定）。
                        // 为什么必须进出口：光在代码里标 * 没人看得见；参数一改行为就变，得有人能一眼确认它是什么值。
                        // 【配置漂移的靶子 · 2026-10-10】把"进程实际加载的功能开关"报出来。
                        // 为什么必须有：昨天那场事故（面②静默关闭 4.5 小时）就是**配置漂移**——
                        // 盘上的 profile patch 与进程内加载的配置不一致，而**没有任何读数能看出来**。
                        // ⛔ 只报功能开关，⛔ 绝不报 token/路径（那会把 selftest 变成信息泄露面）。
                        // 【P4 · 2026-10-10】三条衰减曲线的**实际生效面**必须可读。
                        // 处置依据（真身数据）：process 全库 6 条但 **active 只有 1 条**；core 全库 1 条且在**常驻名单**里
                        // （按 D1 不进动态段 ⇒ 不参与打分）。⇒ 那两条曲线的**任何实现都不可验证**，
                        // 按纪律「⛔ 不改不可验证的东西」⇒ 不实现，但**把"乘零"显式说出来**，不让它静默装死。
                        decay_branches: (() => {
                            const idx = container.getIndex();
                            const active = idx.entries.filter((e) => e.status === 'active' || e.status === undefined);
                            const byType = (t) => active.filter((e) => String(e.decay_type) === t).length;
                            const roster = new Set(idx.hot_order ?? []);
                            const processActive = byType('process');
                            const coreActiveScored = active.filter((e) => e.decay_type === 'core' && !roster.has(e.id)).length;
                            return {
                                recent_active: byType('recent'),
                                process_active: processActive,
                                core_active_可打分: coreActiveScored,
                                w3_process: routeConfig.weights.w3_process,
                                effective: routeConfig.weights.w3_process === 0
                                    ? (processActive > 0
                                        ? `process 分支**整体乘零** ⇒ 等价 recent（当前 ${processActive} 条 active 受此影响）`
                                        : 'process 分支乘零，但当前没有 active 的 process 条目 ⇒ 无实际影响')
                                    : 'process 分支生效',
                                note: 'core 曲线不实现：唯一一条 core 在常驻名单里 ⇒ 不进动态段、不参与打分（D1 去重投递）',
                            };
                        })(),
                        // 【C-0 · H1/H2 的出口】新通道必须**看得见** —— 否则又是"通道建了没人知道它在不在"。
                        // ⛔ 只报状态与字段名，⛔ 绝不报字段**值**（身份里有名字/头像，那是隐私）。
                        onboarding: (() => {
                            try {
                                const st = onboardingState(config.containerRoot, PRODUCT.productVersion);
                                return { needed: st.needed, version: st.version, reason: st.reason };
                            }
                            catch (error) {
                                return { needed: false, reason: 'unreadable', error: String(error) };
                            }
                        })(),
                        identity: (() => {
                            try {
                                const prof = readIdentity(config.containerRoot);
                                return {
                                    present: Object.keys(prof.fields).length > 0,
                                    fields: Object.keys(prof.fields), // 只报**哪些**字段有值，不报值
                                    droppedKeys: prof.droppedKeys,
                                    allowed: [...IDENTITY_FIELDS], // 契约本体：允许写哪些字段（新增字段只改这一处）
                                    updatedAt: prof.updatedAt,
                                };
                            }
                            catch (error) {
                                return { present: false, fields: [], droppedKeys: [], error: String(error) };
                            }
                        })(),
                        config_effective: {
                            enableRoute: Boolean(config.enableRoute),
                            // ⭐【2026-10-17】**关掉自动扫描必须看得见**（P0-5 起含启动扫描；手动仍可用）。
                            //   为什么加进读数：它关掉之后**行为上是"什么都不发生"**——跟"没坏"长得一模一样，
                            //   而本仓已经有过"静默关闭 4.5 小时"的事故。能看见，才敢关。
                            decayDailyCheck: Boolean(config.decayDailyCheck),
                            freshFromTurnClock: Boolean(config.freshFromTurnClock),
                            dynamicBudget: Boolean(config.dynamicBudget),
                            hotMinChars: config.hotMinChars,
                            hotMaxChars: config.hotMaxChars,
                            maxHotEntries: config.maxHotEntries,
                            personaMode: config.personaMode,
                            searchArchive: Boolean(config.searchArchive),
                            verifyUserQuote: Boolean(config.verifyUserQuote),
                        },
                        fresh_params: {
                            halfLifeTurn: FRESH_PARAMS.halfLifeTurn,
                            halfLifeDay: FRESH_PARAMS.halfLifeDay,
                            wired: Boolean(config.freshFromTurnClock),
                            // 生效权重（随开关换）：关着 = 冻结 V1.2 值；开着 = 标定值。⛔ 权重改了行为就变，必须可读。
                            effectiveWeights: { ...routeConfig.weights },
                            calibrated: false,
                            note: 'H_turn 未标定（标定集无时间轴，在这份数据上不可辨识）；H_day 实测无区分度（极差 0.0009）',
                        },
                        day_boundary: {
                            timeZone: getDayTimeZone(),
                            样例: {
                                '2026-10-09 的结束': new Date(parseInstant('2026-10-09', true) ?? 0).toISOString(),
                                说明: '日期粒度语义 = 当地那一天的结束（作者 2026-10-09 拍板）',
                            },
                        },
                        // 【C1】投递账本（投递权威表）：事件数 / 最近一次投递 / 本轮去重窗口。
                        // 它是"什么算一次唤起"的唯一权威；⛔ 不许在别处再算一份。
                        injection_ledger: injectionLedger.snapshot(),
                        // 路由仪表盘（V1.2 出口件 ①）：近 20 次装配的 RouteStats + 本轮被选中的 id 与分项。
                        // 为什么必须在这里：`/selftest` 是唯一裁判席 —— "它在日志里"不算事实。
                        // 判据：curl /api/memory/selftest | jq .data.route 有真值，且能看到这一轮为什么选这几条。
                        // 【反制】两个投递面各开没开 —— ⛔ 不许让"关着"与"没数据"长得一样。
                        faces: {
                            hot: { enabled: true, entries: container.getIndex().hot_order.length },
                            route: { enabled: Boolean(router), note: router ? '' : '面②已关闭（enableRoute=false）⇒ 动态召回的 rounds 恒为 0，别误读成"还没对话"' },
                        },
                        route: routeDashboard.snapshot(),
                        // 注入契约层的装配账本（2026-09-30）：见 src/injection.ts
                        assembly: assemblyLedger.snapshot(),
                        // 契约表自检结果（2026-10-03 接线）：静态检查，启动时算一次。
                        // 有 问题 = 契约表本身自相矛盾（例如 volatile 段挂在了系统提示词上）。
                        contract: { problems: contractProblems, declared: CHANNEL_CONTRACT.length },
                        // 投影对账出口（2026-10-07 加）：索引（派生）与条目文件（唯一真源）不符的清单。
                        // 空数组 = 一致。为什么不并进 contract.problems：那一条是**装配契约**的违规，
                        // 会进 fail-fast 语义；投影陈旧是"派生视图过期"，**不该阻断**，只该被看见。
                        projection_drift: projectionDrift,
                        // 数据缺口出口（V1.3-A · G1）：**两侧都缺**该字段的清单，与投影漂移严格分开。
                        // 分开的理由：漂移要回正索引（派生视图陈旧），缺口要回填数据（这条记忆压根没这字段）。
                        // 两者混报就没人看得懂，而"看不懂"的下一步是"不看了"。
                        data_missing: dataMissing,
                        // 历史遗留（V1.3-A · G1）：两侧都缺、且**不可重建**（如 14 条旧条目的 source）。
                        // ⛔ 单列一档、不做任何写动作 —— 不可重建就是不可重建，编个值糊上才是真丢东西。
                        legacy_missing: legacyMissing,
                        // 正文完整性（V1.3-A · G3）：三个数一起报，⛔ 不许只报"不符 0"就交差 ——
                        // 首批 112 条全是 v3 旧格式，一条都验不了，"0 不符"在那里毫无意义。
                        checksum: { verified: checksum.verified, mismatch: checksum.mismatch, unverifiable: checksum.unverifiable },
                        // 索引乐观锁的合并事件（2026-10-07 加）：磁盘索引被外部改过时，
                        // saveIndex() 会三路合并而不是整片覆盖。**这件事必须被看见**——
                        // 实测事故里它是完全静默的（修好的 18 处 10 分钟内被覆盖回去，零日志）。
                        index_merge_events: container.getIndexMergeEvents(),
                        // 【Ledger · L-1】崩溃自愈留痕：⛔ 不许静默修——出过事必须在这个出口上看得见
                        repair_events: container.repairEvents,
                        // 【L-5】增量索引日志现状 + 作废/折平留痕（⛔ 不许静默）
                        index_log: container.indexLogStatus(),
                        index_log_events: container.indexLogEvents,
                        dynamicBudget: {
                            enabled: config.dynamicBudget,
                            contextWindow: config.contextWindow,
                            charsPerToken: config.charsPerToken,
                            hotMaxChars: config.hotMaxChars,
                            ...tokenBudget.snapshot(),
                            hotMinChars: config.hotMinChars,
                            budgetCharsNow: config.dynamicBudget
                                ? tokenBudget.budgetChars({
                                    contextWindow: config.contextWindow,
                                    hotMaxChars: config.hotMaxChars,
                                    hotMinChars: config.hotMinChars,
                                    charsPerToken: config.charsPerToken,
                                })
                                : config.hotMaxChars,
                            // 收缩曲线：同一份采样、不同窗口下的预算 —— 验证「窗口越紧预算越小」的单调性
                            curve: [1_000_000, 200_000, 100_000, 50_000, 20_000].map((window) => ({
                                window,
                                budgetChars: tokenBudget.budgetChars({
                                    contextWindow: window,
                                    hotMaxChars: config.hotMaxChars,
                                    hotMinChars: config.hotMinChars,
                                    charsPerToken: config.charsPerToken,
                                }),
                            })),
                        },
                        // resolve() 会落定状态（成功或原因），state() 同步读回它 —— 不要在这里自己拼 available，会重复定义
                        compressor: await compressor.resolve().then(() => compressor.state()),
                        voiceLayer: { voiceFile: config.voiceFile, injectPersona: config.injectPersona },
                    }),
                    // 显式触发一次真实压缩调用（会产生一次真实 LLM 请求）
                    compressProbe: async (overrides) => {
                        // ── 为什么探针要能接受任意文本（2026-09-24 加）─────────────────
                        // 原实现把待压文本**硬编码**在这段代码里（一段 130 字的说明文字）。
                        // 那只能证明"调用链通"，**证明不了语义质量**——
                        // 而 V1.1 压测报告里明确把「压缩的语义质量」标为未评估项，本次就是来补它的。
                        // 评测要跑真实记忆正文，所以必须能传文本进来。
                        //
                        // 边界：`text` / `instruction` 只影响这一次探针调用，不落盘、不进上下文；
                        //       缺省值保持与原实现一致（既有调用方的行为不变）。
                        const DEFAULT_INPUT = '记忆容器的候选隔离区负责挡住未经人工确认的模型推断：任何推断都先进候选层，' +
                            '物理上没有自助转正工具，转正必须由人经设置页、CLI 或 HTTP 三通道之一确认；' +
                            '被纠正的条目写新版本而不覆盖旧版，旧版标 superseded 以保留可回退能力。';
                        const DEFAULT_INSTRUCTION = '把输入压缩成不超过 60 字的中文摘要，只输出摘要本身，不要任何解释或前后缀。';
                        const input = typeof overrides?.text === 'string' && overrides.text.length > 0 ? overrides.text : DEFAULT_INPUT;
                        const instruction = typeof overrides?.instruction === 'string' && overrides.instruction.length > 0
                            ? overrides.instruction
                            : DEFAULT_INSTRUCTION;
                        const t0 = Date.now();
                        const output = await compressor.compress({
                            text: input,
                            instruction,
                            ...(overrides?.maxTokens === undefined ? {} : { maxTokens: overrides.maxTokens }),
                            ...(overrides?.model === undefined ? {} : { model: overrides.model }),
                        });
                        return {
                            inputChars: input.length,
                            outputChars: output.length,
                            output,
                            latencyMs: Date.now() - t0,
                            ...(overrides?.maxTokens === undefined ? {} : { maxTokens: overrides.maxTokens }),
                            ...(overrides?.model === undefined ? {} : { model: overrides.model }),
                        };
                    },
                });
                disposers.push(ctx.webServer.register({
                    kind: 'prefix',
                    path: apiPath,
                    handler,
                }));
            }
        }
        catch (error) {
            for (const dispose of disposers.reverse())
                dispose();
            throw error;
        }
        logger.info(`设置页 API 已注册: ${[...paths].join(', ')} (allowEdit=${config.allowEdit ? 'on' : 'off'})`);
        return () => {
            for (const dispose of disposers.reverse())
                dispose();
        };
    }, 'memory-container.api');
    // ── persona 注入（声音层 + 记忆层 → systemPrompt section） ────
    // section 顺序约定：harness:identity(-100) → deployment:persona(0) →
    //   声音层 memory-container:voice(5) → 记忆层 memory-container:hot(10) → 工具指引(100+)。
    // 注意：renderPrompt 对 section.text 做严格 {{name}} 插值，未注册变量会 throw
    //   （unknown prompt variable）；记忆/声音正文含完整 {{...}} 组必须拆开。
    //
    // 【P0 · 动态装配】section.text 传「函数」而不是「字符串」：宿主每个模型步都会重新
    //   调用一次（agent-loop → systemPrompt.assemble，见 system-prompt/lib/index.js 中
    //   `typeof section.text === "function" ? section.text(context) : section.text`）。
    //   传字符串 = 启动时编译一次、之后永远冻结，这正是「上午 10:30 也被催睡」的根因：
    //   模型只看到一句静态的提醒例句，而它从未被告知现在几点。
    // ── 注入契约层（2026-09-30）─────────────────────────────────────
    // 规矩见 `src/injection.ts`：**缓存单元 = 整条系统提示词；每段内容必须声明它改的是
    // 哪个缓存单元、是否每轮变。** 装配账本在这里只做观测——稳定段在没有登记原因的
    // 情况下变了字节数，就是一条契约违反（会被 /selftest 暴露出来）。
    // 为什么必须先立这一层：V1.2 那次事故（每轮追加一整份 2 万字符副本、上下文 53% 是重复）
    // 的根因不是代码写错，是**没有人被指定为"装配位置"负责**。
    const assemblyLedger = new AssemblyLedger();
    // ── 注入契约自检（2026-10-03 接线）────────────────────────────────
    // `auditContract()` 从 MemoryV1.1-Exact 起就存在，注释里写着"volatile 走 systemPrompt
    // 会被它报出来"，但**全仓没有调用点** —— 守卫写着却没上岗。
    // 正是本项目重复栽的那一类：调用方看到注释就以为它生效了。
    // 现在启动即自检：有违反就 error 日志（不是 warn：这类错误会让缓存整份失效，代价是钱），
    // 结果同时进 `/selftest → data.contract`，让它变成可 curl 的事实而不是"代码里写了"。
    const contractProblems = auditContract();
    if (contractProblems.length > 0) {
        for (const problem of contractProblems)
            logger.error(`注入契约违反: ${problem}`);
    }
    else {
        logger.info(`注入契约自检通过（${CHANNEL_CONTRACT.length} 段已登记）`);
    }
    if (config.injectPersona) {
        // 声音层：容器 voice.md（可编辑）→ 缺失回退内置 DEFAULT_VOICE
        // 函数态：每轮重算，头部拼「当前时间」，让催睡规则有判断依据。
        if (config.voiceFile) {
            // ⚠️ 声音层文件**必须每轮重读**，不能在启动时读一次就编译成常量。
            //
            // 这里踩过一次坑（2026-09-15 扫描发现）：voice.md 自己写着「想调整就直接改，下次会话生效」，
            // 但实现是启动时读一次 → **改完不重启根本不生效**。文件在骗人，比没写还糟。
            // 单文件读（1.7KB）**实测** p50 0.015ms / p99 0.067ms（200 次采样），
            // 相对 hot 段渲染（p50 0.10ms）可忽略——所以这个「诚实的代价」几乎为零。
            const readVoiceText = () => {
                try {
                    const fileText = container.readOptionalFile(config.voiceFile);
                    return fileText !== null ? stripFrontmatter(fileText).trim() : DEFAULT_VOICE;
                }
                catch (error) {
                    // 读失败（被占用/编码坏）不得让装配整体失败：回退内置默认声音，下一轮再试
                    logger.warn(`声音层读取失败，本轮回退内置默认声音: ${String(error)}`);
                    return DEFAULT_VOICE;
                }
            };
            // 声音段记账用：上一轮读到的源文本 + 是否还在首次观测
            let lastVoiceSource = null;
            let firstVoiceObservation = true;
            const initialVoice = readVoiceText();
            if (container.readOptionalFile(config.voiceFile) === null) {
                logger.warn(`声音层文件缺失: ${config.voiceFile}，使用内置默认声音`);
            }
            logger.info(`声音层已编译 (${initialVoice.length} 字符, 每轮重读 voice.md, 不含时间行——时间改由 current_time 工具按需取)`);
            ctx.systemPrompt.section({
                name: 'memory-container:voice',
                order: 5,
                // ⚠️ 保持函数态（每轮重读 voice.md），但注入体内**不再含时间**：
                //   时间行曾在第 132 字符处，每分钟一变 ⇒ 缓存前缀每分钟作废、上下文按全价重算
                //   （实测 156 次全失效、折算 ¥15.38）。易变内容一律不进可缓存前缀的头部。
                //   转义仍必须在函数内执行：宿主对每次装配的返回值做 strict 插值。
                //
                //   ── 注入契约层的记账点（2026-09-30）──────────────────────────
                //   voice 是 coldStart 段：本会话内它**必须字节不变**。它的变化触发条件
                //   已在 `src/injection.ts` 的 CHANNEL_CONTRACT 里登记（人工编辑 voice.md），
                //   所以第一次变化按"已登记原因"记，**但那不是免费的**——
                //   改一次 voice.md = 从那一刻起缓存前缀按字节失效，整段上下文全价重算一次。
                //   实测口径见 voice.md 的"推理纪律"是 09-27 改的：那条改动的代价就是这样付的。
                text: () => {
                    const source = readVoiceText();
                    // ── 记账（2026-10-03 修：原来恒传 expected: true，等于这个守卫永远不报警）──
                    // 已登记的触发条件只有一个：**人工编辑 voice.md**。
                    // 所以 expected 必须由"源文件到底变没变"决定，而不是由调用方一律点头：
                    //   · 源变了（人改的）→ 已登记原因 ✓
                    //   · 源没变而渲染长度变了 → **违规**（渲染不再确定，或有人在中间塞了东西）
                    // 拼错这个标志位的代价：缓存前缀按字节失效、整段上下文全价重算一次 ——
                    // 这种事必须出现在 /selftest 里，而不是"看日志才知道"。
                    const sourceChanged = lastVoiceSource !== null && lastVoiceSource !== source;
                    lastVoiceSource = source;
                    const rendered = escapeTemplate(renderVoice(source));
                    assemblyLedger.observe('memory-container:voice', { chars: rendered.length, expected: sourceChanged || firstVoiceObservation });
                    appendEvent(config.containerRoot, 'render', { section: 'voice', chars: rendered.length });
                    firstVoiceObservation = false;
                    return rendered;
                },
            });
        }
        else {
            logger.info('声音层已按配置关闭 (voiceFile 为空)');
        }
        // 记忆层：hot 条目（full/summary）—— 同样函数态，写入后下一轮装配即可见（5 秒口径）
        // 缓存策略：命中缓存直接返回；写入成功置脏 → 下一轮强制重算。
        // 失败降级：重算抛错 → 回退上一份成功文本 + warn + 置脏（下一轮强制重算，不走缓存）；
        //          连续 3 次回退升级为 error，并记录条数供设置页提示。
        let hotFallbackStreak = 0;
        /** 本轮实际可用的 hot 字符预算；动态预算关闭时即静态 hotMaxChars */
        const resolveBudgetChars = () => config.dynamicBudget
            ? tokenBudget.budgetChars({
                contextWindow: config.contextWindow,
                hotMaxChars: config.hotMaxChars,
                hotMinChars: config.hotMinChars,
                charsPerToken: config.charsPerToken,
            })
            : config.hotMaxChars;
        // 【P6 门禁】没有冻结基线 ⇒ 退回旧渲染；⛔ 不许“先开再补基线”
        let chainRenderEnabled = config.chainRender;
        if (chainRenderEnabled) {
            const gate = chainRenderBaselineOk(config.containerRoot);
            if (!gate.ok) {
                logger.error(`[P6] chainRender=true 但基线不可用（${gate.reason}）⇒ 本次退回旧渲染；先跑 scripts/chain-render-baseline.mjs`);
                chainRenderEnabled = false;
            }
        }
        /** 上一次 hot 编译**真正渲染出去的 id**（C 段：只有它算"被投递"） */
        let hotIncludedIds = [];
        const compileHot = (maxChars) => {
            // 【P6】档位覆盖（开关关闭 ⇒ undefined ⇒ 行为与旧版逐字相同）
            let tierOverrides;
            if (chainRenderEnabled) {
                const today = dayKey(new Date());
                if (chainTierCache?.day !== today) {
                    const prev = chainTierCache;
                    try {
                        const res = computeTierOverrides(container, subjects, injectionLedger, CHAIN_H, CHAIN_THETA, { rendering: true });
                        // 只在“已有基线且档位变了”时落 tier-change（首算 = 基线，不刷事件）
                        if (prev) {
                            for (const [id, mode] of res.map) {
                                const before = prev.map.get(id);
                                if (before && before !== mode)
                                    appendEvent(config.containerRoot, 'tier-change', { id, from: before, to: mode, reason: 'chain' });
                            }
                        }
                        chainTierCache = { day: today, map: res.map };
                    }
                    catch (e) {
                        logger.warn(`[P6] 档位计算失败（本轮退回旧渲染）：${e instanceof Error ? e.message : String(e)}`);
                    }
                }
                tierOverrides = chainTierCache?.map;
            }
            const result = config.personaMode === 'summary'
                ? renderHotSummaryDetailed(container, { maxChars, scopeContext, ...(tierOverrides ? { tierOverrides } : {}) })
                : renderHotBlockDetailed(container, { maxChars, scopeContext, ...(tierOverrides ? { tierOverrides } : {}) });
            hotIncludedIds = result.includedIds;
            return { text: result.text, included: result.includedIds.length, omitted: result.omittedIds.length };
        };
        // ── 【D2 · E6】两条**非写入型**失效触发（2026-10-09）────────────────────
        // ① 到期边界：某条常驻记忆带 valid_to/expires，到点就该消失 —— 而**没有任何写入发生**。
        //    此前要等"下一次别的写入"顺带置脏（真身实测：a36 过期 14 天仍 active）。
        // ② 外部改盘：index.json 被脚本/别的进程重写（真身**发生过 11 次**），此前进程毫无察觉。
        // 成本纪律（C1/C6）：装配期只付**一次 statSync + 若干整数比较**；
        //    边界在编译时算一次并缓存，⛔ 不每轮重算全量。
        let nextBoundary = null;
        const refreshBoundary = () => {
            nextBoundary = computeNextBoundary(container.getIndex().entries, Date.now());
        };
        const initialBudget = resolveBudgetChars();
        const currentHotResult = compileHot(initialBudget);
        refreshBoundary();
        hotCacheText = currentHotResult.text;
        hotCacheDay = dayKey(new Date());
        hotCacheBudget = initialBudget;
        hotCacheDirty = false;
        logger.info(`hot 记忆已编译 (${currentHotResult.included} 条, ${currentHotResult.text.length}/${initialBudget || '不限'} 字符` +
            (config.dynamicBudget
                ? `, 动态预算=on(窗口 ${config.contextWindow}, 已采样 ${tokenBudget.snapshot().samples} 次)`
                : ', 动态预算=off') +
            (currentHotResult.omitted ? `, 省略 ${currentHotResult.omitted} 条` : '') + ')');
        // 条数软上限：仅告警，不熔断（字符硬预算才是把关的那道）
        const hotEntryCount = container.getIndex().hot_order.length;
        if (hotEntryCount > config.maxHotEntries) {
            logger.warn(`hot_order 条数 ${hotEntryCount} 超过软上限 ${config.maxHotEntries}，建议收敛常驻条目（字符硬预算仍由 hotMaxChars 把关）`);
        }
        ctx.systemPrompt.section({
            name: 'memory-container:hot',
            order: 10,
            text: () => {
                // 预算也参与缓存判定：预算缩小后必须重算，否则会沿用超预算的旧文本
                const budgetChars = resolveBudgetChars();
                // ── 注入契约层的记账点（2026-09-30）──────────────────────────
                // hot 是 stable 段：只在**已登记的原因**下才允许变——
                //   ① 写入置脏（hotCacheDirty）
                //   ② 预算字符数变化（hotCacheBudget !== budgetChars）
                // 命中缓存且预算未变 → 字节必须与上一轮相同，否则装配账本记一条契约违反。
                // 两个"变了"的标志位都要传到 observe：**变了不算违规，偷偷变才算。**
                // 【D2 · E6】非写入型失效：这两条必须在**命中缓存之前**判 ——
                // 否则一条到期的常驻记忆会一直被注入，直到碰巧有别的写入把它顶掉。
                if (!hotCacheDirty && boundaryPassed(nextBoundary, Date.now())) {
                    hotCacheDirty = true;
                    logger.info(`hot 段重算：到期边界已到（${new Date(nextBoundary).toISOString()}）`);
                }
                if (!hotCacheDirty && revisionProbe.changed()) {
                    // 盘上的索引被别人改了（真身发生过 11 次）⇒ 重载索引再重算，
                    // 否则我们继续按内存里那份旧投影投递。verify:false = 与写事务同档，只重放不折平。
                    try {
                        container.load({ verify: false });
                        hotCacheDirty = true;
                        logger.info('hot 段重算：检测到 index.json 被外部修改，已重载索引');
                    }
                    catch (error) {
                        logger.warn(`检测到 index.json 被外部修改，但重载失败：${String(error)}`);
                    }
                }
                if (!hotCacheDirty && hotCacheText !== null && hotCacheBudget === budgetChars && hotCacheDay === dayKey(new Date())) {
                    const rendered = escapeTemplate(hotCacheText);
                    assemblyLedger.observe('memory-container:hot', { chars: rendered.length, expected: true });
                    appendEvent(config.containerRoot, 'render', { section: 'hot', chars: rendered.length });
                    // 【C1】面①命中缓存也是**真的投递了**（它每轮都在系统提示词里）⇒ 如实记录。
                    // 按轮去重 ⇒ 同一轮装配多次只落一条事件；面①**不计唤起**（名单投递，fresh 对它无意义）。
                    injectionLedger.recordDelivery({
                        face: 'hot', ids: hotIncludedIds, sessionId: currentSessionId, turn: currentTurn,
                    });
                    return rendered;
                }
                const expectedChange = hotCacheDirty || hotCacheBudget !== budgetChars;
                try {
                    const fresh = compileHot(budgetChars);
                    hotCacheText = fresh.text;
                    hotCacheDay = dayKey(new Date());
                    hotCacheBudget = budgetChars;
                    hotCacheDirty = false;
                    hotFallbackStreak = 0;
                    refreshBoundary(); // 重算完就重算边界（下一次到点才有意义）
                    injectionLedger.recordDelivery({
                        face: 'hot', ids: hotIncludedIds, sessionId: currentSessionId, turn: currentTurn,
                    });
                    const rendered = escapeTemplate(fresh.text);
                    assemblyLedger.observe('memory-container:hot', {
                        chars: rendered.length,
                        expected: expectedChange,
                    });
                    appendEvent(config.containerRoot, 'render', { section: 'hot', chars: rendered.length });
                    return rendered;
                }
                catch (error) {
                    hotCacheDirty = true; // 下一轮强制重算，绝不静默沿用
                    hotFallbackStreak += 1;
                    const message = `hot 装配重算失败（连续 ${hotFallbackStreak} 次）：${String(error)}`;
                    if (hotFallbackStreak >= 3)
                        logger.error(`${message} —— 已回退上一份文本，请检查容器`);
                    else
                        logger.warn(`${message} —— 回退上一份文本`);
                    const rendered = hotCacheText !== null ? escapeTemplate(hotCacheText) : '';
                    assemblyLedger.observe('memory-container:hot', { chars: rendered.length, expected: true });
                    appendEvent(config.containerRoot, 'render', { section: 'hot', chars: rendered.length });
                    return rendered;
                }
            },
        });
    }
    // ── 路由段（**走 context() 通道，不进系统提示词**）────────────────────
    // ⚠️ 这是 MemoryV1.1-Exact 唯一一处"当年让 V1.2 出事"的代码，所以边界写死在这里：
    //
    //   缓存单元 = **整条系统提示词（按字节）**。section / order / 位置都不改变这个单元。
    //   把每轮都变的东西放进任何 section，宿主只能二选一：整份 replace（全价）或 append 副本。
    //   `context()` 走的是**会话尾部自替换快照**——不碰系统提示词，文本没变还自动跳过。
    //
    //   V1.2 当年的实现是 `ctx.systemPrompt.section({ order: 50 })`，代价实测：
    //   36 轮 182 次调用里被追加 43 份副本（每份 19,980 字符），上下文 760,628 token 里
    //   约 53% 是同一份提示词的重复，每轮漏计 8,007~12,771 token。
    //
    //   ⇒ 这一段的通道由 `src/injection.ts` 的契约表声明并自检（volatile + runtimeContext），
    //     `auditContract()` 会把"volatile 走 systemPrompt"当成错误报出来。
    if (router) {
        let routeCacheText = '';
        ctx.systemPrompt.context({
            name: 'memory-container:route',
            order: 50,
            text: () => {
                const t0 = Date.now();
                if (!routeQuery) {
                    recordRouteRound(null, 0, Date.now() - t0, 'empty-query');
                    return '';
                }
                try {
                    // ⛔ 作用域上下文必须传（2026-10-09 安全修复）：
                    //    此前这里是不带参数的 `router.route(routeQuery)`，于是动态段走的召回
                    //    完全不知道当前作用域 —— 面①（hot 段，见下方 compileHot）**一直传了**，
                    //    面②却不传，同一个插件两个投递面对作用域的态度不一致。
                    // ── 【E3 接线】真 fresh：由**投递账本 + 当前轮次/会话**算出"距上次被想起多久" ──
                    // 开关默认关（`freshFromTurnClock=false`）⇒ 不注入取值器 ⇒ 逐字回到 `fresh = pri`。
                    // ⛔ 没有这一段的话，那个开关打开也是**静默空转**（改了配置却什么也没发生）。
                    const freshLookup = config.freshFromTurnClock
                        ? (item) => {
                            try {
                                const e = elapsed({
                                    sessionId: currentSessionId,
                                    turn: currentTurn,
                                    now: new Date(),
                                    last: injectionLedger.lastDeliveryOf(item.meta.id) ?? undefined,
                                    lastAccessed: item.meta.last_accessed,
                                });
                                return freshOf({ elapsed: e });
                            }
                            catch (error) {
                                // 取值失败 ⇒ 回落 pri（score.ts 的约定：返回 null）。⛔ 不许把整轮打分带崩。
                                logger.warn(`fresh 取值失败，回落 pri：${String(error)}`);
                                return null;
                            }
                        }
                        : undefined;
                    const result = router.route(routeQuery, { scopeContext, freshLookup });
                    // 【P1】candidates 埋点：每轮路由的候选池与切掉数（只读观测）
                    try {
                        appendEvent(config.containerRoot, 'candidates', {
                            session: currentSessionId, turn: currentTurn,
                            main: result.main.length, candidates: result.candidates.length,
                            scanned: result.stats?.scanned, capped: result.stats?.capped,
                            gateIn: result.stats?.gateIn,
                            ids: result.candidates.slice(0, 20).map((c) => c.meta.id),
                        });
                    }
                    catch { /* 观测口不拖垮装配 */ }
                    if (result.main.length === 0) {
                        recordRouteRound(result, 0, Date.now() - t0, 'empty-main');
                        return '';
                    }
                    // 涌现层标记（移植自 V1.2，PRD §③ 要求）：
                    // directed 有 query 相关性背书；emergent 只是"顺着 tag 想到的"——
                    // 不区分就等于让模型把弱相关当事实用。置信度取 gate 未过线的降权系数。
                    const lines = result.main.map((e) => {
                        if (e.origin !== 'emergent')
                            return `- ${e.meta.id} ${e.meta.title}：${e.meta.summary ?? ''}`;
                        const conf = e.gatePass ? 0.6 : 0.4;
                        return `- 【联想提示，可能不准确】${e.meta.id} ${e.meta.title}：${e.meta.summary ?? ''}（置信度${conf}，来源${e.meta.source || '未知'}）`;
                    });
                    // ── 【C2 · 唤起 ≡ 注入】──────────────────────────────────────────
                    // 记账必须发生在**这里**：只有渲染完才知道"到底谁被投出去了"。
                    // 旧实现由路由自己 `touchAll(main ∪ candidates)` —— 候选区（被考虑但没被注入）
                    // 也被算成唤起，把语料扫平（实测 10 次路由覆盖 92% 语料）。
                    // 现在：**候选区只读不写**；面②的真注入按宿主轮次号去重后计数。
                    const delivered = result.main.map((e) => e.meta.id);
                    const { touchIds } = injectionLedger.recordDelivery({
                        face: 'route', ids: delivered, sessionId: currentSessionId, turn: currentTurn,
                    });
                    if (touchIds.length > 0)
                        router?.touchEntries(touchIds, new Date());
                    routeCacheText = `【本轮唤起】\n${lines.join('\n')}`;
                    try {
                        noteInjection(currentSessionId, routeCacheText);
                    }
                    catch { /* 收据失败不影响装配 */ }
                    const rendered = escapeTemplate(routeCacheText);
                    assemblyLedger.observe('memory-container:route', { chars: rendered.length, expected: true });
                    appendEvent(config.containerRoot, 'render', { section: 'route', chars: rendered.length });
                    recordRouteRound(result, rendered.length, Date.now() - t0, null);
                    return rendered;
                }
                catch (error) {
                    // 路由失败不得影响装配：本轮不注入动态层，下一轮再试
                    recordRouteRound(null, routeCacheText ? routeCacheText.length : 0, Date.now() - t0, 'error', String(error).slice(0, 200));
                    logger.warn(`路由装配失败：${String(error)}（本轮不注入动态层）`);
                    return routeCacheText ? escapeTemplate(routeCacheText) : '';
                }
            },
        });
    }
}
export { name, inject, Config, apply };
