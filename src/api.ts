/**
 * memory-container HTTP API（设置页「记忆」标签的数据通道）
 *
 * 设计原则（沿用插件既有调度逻辑）：
 *   - 无框架依赖：webServer 是标准 Node http handler，纯手写路由
 *   - fail-fast：解析/读写失败返回结构化错误，不静默吞
 *   - 写路径显式开关：PUT/POST 只在 config.allowEdit=true 时注册，默认只读
 *   - 原子写：所有落盘走 container 的 atomicWrite（tmp + rename）
 *
 * 路由（前缀 config.apiPrefix，默认 /api/memory）：
 *   GET  /list          → 分层列出条目元信息（含 hot_order）
 *   GET  /graph         → 关系图谱数据（节点 + 钩稽边，知识球/平面图的数据源）
 *   GET  /entry/:id     → 单条完整内容（frontmatter + 正文）
 *   PUT  /entry/:id     → 编辑单条（title/content/tags/priority/summary）
 *                        （仅 allowEdit=true 时注册）
 */

import fs from 'node:fs'
import { freshForEntry } from './route/fresh.js'
import { explainDecay, sweepEntries } from './decay.js'
import { loadPins } from './pins.js'
import { runDueSweep, listRollbackBatches, readAudit, readSweepState, resolveGateSnapshot, rollbackBatch, rollbackLastBatch, runSweep } from './decay-sweep.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import type { MemoryContainer } from './container.js'
import { buildMemoryGraph } from './graph.js'
import { isInScope, memoryScope, temporalState } from './policy.js'
import { listFallbackFields } from './contract/fields.js'
import { markOnboarded, onboardingState } from './onboarding.js'
import { seedHotAnchors } from './persona-seed.js'
import { readIdentity, writeIdentity } from './identity.js'
import { makeRevisionProbe } from './hot-invalidation.js'
import type { MemoryScopeContext } from './types.js'
import type { MemoryWriter } from './writer.js'
import { ChainRegistryError, type ChainStore } from './chains.js'

/** 统一的 JSON 响应体 */
interface ApiResponse<T = unknown> {
  ok: boolean
  data?: T
  error?: string
}

/** 按容器现有约定序列化一个条目为前端可读形态 */
function entryView(container: MemoryContainer, id: string) {
  const file = container.readEntry(id)
  if (!file) return null
  const { id: _id, ...frontmatter } = file.frontmatter
  return {
    id,
    ...frontmatter,
    content: file.content,
  }
}

/** 读取请求 body（JSON），超限/非法直接抛错 */
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 512 * 1024) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8')
      if (!raw) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>)
      } catch {
        reject(new Error('invalid json body'))
      }
    })
    req.on('error', reject)
  })
}

/** 发送 JSON 响应 */
function sendJson(res: ServerResponse, status: number, body: ApiResponse): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/** 解析 pathname（去掉 query） */
function pathnameOf(url: string | undefined): string {
  if (!url) return ''
  const q = url.indexOf('?')
  return q >= 0 ? url.slice(0, q) : url
}

/**
 * 构建 memory 数据 API 的 webServer handler。
 * 返回 { handler, routes }：routes 供日志诊断；handler 供 webServer.register。
 */

export function createMemoryApi(container: MemoryContainer, opts: {
  prefix: string
  allowEdit: boolean
  /**
   * ⭐【2026-10-17】每条被投递过几次（来自 InjectionLedger）。
   * 只读端点 `/decay-state`、`/decay-why` 与手动 `/decay-sweep` 必须与启动路径**同一口径**，
   * 否则界面上的"计划动几条"与真身扫描的结论会不一致（两个真源）。
   */
  deliveredCounts?: () => ReadonlyMap<string, number>
  /** 【P7】单生产者：chainJudge=true 时手动扫描也用链级计划（缺省 undefined ⇒ 旧行为） */
  chainPlan?: () => import('./decay.js').DecayPlan | undefined
  /** UI 链镜头：条目档位（缺省 undefined ⇒ 不注册 /tiers） */
  tiers?: () => Record<string, string>
  /** UI 探针：点击/状态事件落点（缺省 undefined ⇒ 不注册 /ui-probe） */
  uiProbe?: (event: unknown) => void
  /** exact UI HTML（缺省 undefined ⇒ 不注册 /ui） */
  uiHtml?: () => string
  /** 认识一下抽卡：服务端模型/模板生成（缺省 undefined ⇒ 不注册 /onboarding/suggest） */
  suggest?: (body: { useHistory?: boolean; count?: number }) => Promise<unknown>
  /** 写操作：pin/unpin（缺省 undefined ⇒ 不注册 /pin） */
  pin?: (id: string, pinned: boolean) => unknown
  /** UI 链镜头：真实 subject 表（缺省 undefined ⇒ 不注册 /chain） */
  subjects?: () => Array<{ id: string; name: string; kind: string; parent: string | null; session_id?: string; last_grown?: string; last_activated?: string }>
  /** Breathe 手动记忆链注册表（独立于条目写锁） */
  chainStore?: ChainStore
  /**
   * 【P1-4 修复 · 2026-10-19】手动扫描的「状态写失败」出口，与启动/tick 同一个出口。
   * 修前手动路不传 ⇒ 闸门没推进、界面回 200 全绿，只有盘上的状态知道它失败了。
   */
  onStateWriteFail?: (e: unknown) => void
  /** 【P2-6 修复】设置后 /decay-sweep 直接返回「不执行」原因，**不跑 runSweep**（不碰闸门）。 */
  sweepDisabledReason?: string
  scopeContext?: MemoryScopeContext
  /**
   * 写入器（V1.0）：提供候选确认/丢弃两条人工转正路径。
   * 不传则不注册 /pending 路由（保持 v0.5 只读语义）。
   */
  writer?: MemoryWriter
  /**
   * 【C-0 · H1】产品版本号 —— 「认识一下」首启判定拿它比对（⛔ 不许再定义第二个号）。
   */
  productVersion?: string
  /**
   * 【C-0 · H1/H2】容器根 —— `.onboarded` 与 `identity/profile.json` 的落点。
   * 不传则不注册 /onboarding 与 /identity（保持只读语义）。
   */
  containerRoot?: string
  /**
   * 共享 token（安全专项 §三-5）：请求须带 `x-memory-token`，否则 401。
   * 空字符串 = 不启用（本地开发/排障用）。token 由插件启动时生成并注入页面。
   */
  token?: string
  /**
   * 是否校验 Host / Origin 头（安全专项 §三-5 · 防 CSRF 与 DNS rebinding）。
   * 默认 true：只接受 loopback 主机名与 loopback Origin。
   */
  guardHost?: boolean
  /**
   * 排障自检数据（V1.1 增量② 配套）：动态预算采样状态 + 压缩接入点解析结果。
   * **只读，不触发任何 LLM 调用**。不传则不注册 /selftest 路由。
   */
  introspect?: () => unknown | Promise<unknown>
  /**
   * 显式触发一次**真实**压缩调用（V1.1 增量② 配套·排障用）。
   * 会产生一次真实 LLM 请求，故只在显式 POST 时执行；不传则不注册该路由。
   */
  compressProbe?: (overrides?: {
    maxTokens?: number
    model?: string
    /** 待压文本（评测用）；缺省走探针内置样本，保持既有行为不变 */
    text?: string
    /** 压缩指令（评测用）；缺省走探针内置指令 */
    instruction?: string
  }) => Promise<{
    inputChars: number
    outputChars: number
    output: string
    latencyMs?: number
    model?: string
    maxTokens?: number
  }>
}) {
  const { prefix, allowEdit, scopeContext = {}, writer, token = '', guardHost = true } = opts
  const normPrefix = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix

  /** 允许的主机名（loopback 家族）。带端口也接受（按 `hostname:port` 比较 hostname 部分）。 */
  const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

  /**
   * 请求准入校验。返回 null 表示放行，否则返回 { status, error }。
   *
   * 三层（对应安全专项 §三-5）：
   *   ① Host 校验 → 防 DNS rebinding（恶意域名解析到 127.0.0.1 时 Host 会是攻击者域名）
   *   ② Origin/Referer 校验 → 防 CSRF（跨站 JS，含 `form method=POST` 这种 simple request）
   *   ③ token → 挡「本机任意进程」（它得先能读到 token 才能调）
   *
   * 边界（诚实标注）：三层都挡不住「能读本机文件 + 能发本机请求」的攻击者——
   * 他既能读容器明文，也能读 token。鉴权提高的是门槛，不是"安全了"。
   */
  function admit(req: IncomingMessage, method: string): { status: number; error: string } | null {
    if (guardHost) {
      const hostHeader = String(req.headers.host ?? '')
      // ⚠️ fail-closed：**缺 Host 也拒**（2026-09-15 扫描发现）。
      // 原实现写的是 `if (hostHeader) { ...校验... }`——缺 Host 就整层跳过，
      // 而 HTTP/1.0 请求本来就不带 Host，等于给出一条绕过 DNS rebinding 防护的路。
      // 合法调用方（DSH GUI、curl、本机脚本）**都会带 Host**，所以拒掉缺失值不误伤任何人。
      if (!hostHeader) {
        return { status: 403, error: '缺少 Host 头（已开启 Host 校验时不允许无 Host 请求）' }
      }
      const hostname = hostHeader.replace(/:\d+$/, '').toLowerCase()
      if (!LOOPBACK_HOSTS.has(hostname)) {
        return { status: 403, error: `拒绝非本机 Host: ${hostHeader}（防 DNS rebinding）` }
      }
      const origin = req.headers.origin ?? req.headers.referer
      if (origin) {
        try {
          const originHost = new URL(String(origin)).hostname.toLowerCase()
          if (!LOOPBACK_HOSTS.has(originHost)) {
            return { status: 403, error: `拒绝非本机来源: ${String(origin)}（防 CSRF）` }
          }
        } catch {
          return { status: 403, error: `来源头无法解析: ${String(origin)}` }
        }
      }
      // Origin 缺失时**不拒**：本地脚本（curl / memory-cli）本就不带 Origin，
      // 而浏览器发跨站写请求必然带 Origin，所以缺 Origin 不是有效的 CSRF 信号。
      // 这一层的边界如实标注：它挡浏览器，不挡非浏览器客户端——后者由 token 挡。
      void method
    }
    if (token) {
      // iframe 的 /ui 页面用查询参数带 token（iframe 不能自定义请求头）；其余路由仍只认 header
      let queryOk = false
      try { const u = new URL(String(req.url), 'http://127.0.0.1'); queryOk = u.pathname.endsWith('/ui') && u.searchParams.get('t') === token } catch { /* ignore */ }
      const provided = req.headers['x-memory-token']
      const value = Array.isArray(provided) ? provided[0] : provided
      if (value !== token && !queryOk) {
        return { status: 401, error: '缺少或错误的 x-memory-token' }
      }
    }
    return null
  }

  /** 相对路由 → 命中者；未命中返回 undefined（交给 404） */
  const routes: Array<{
    method: string
    path: string
    handler: (req: IncomingMessage, res: ServerResponse, rest: string) => Promise<void> | void
  }> = []

  // ═══ 【C-0 · H3】应答前的修订检查 ═══════════════════════════════════════
  // 为什么必须有：插件持有内存索引，而**容器可能被别的通道改过**（CLI / 直接编辑文件 /
  // 另一次装配）。l57 那两次事故就是这一类：插件拿旧索引应答，甚至把旧索引整份写回。
  // 这里复用 D2 的修订探针（D2 只管 hot 段重算，这里管 **HTTP 应答的读数**）。
  // ⛔ 纪律：**我们自己写盘之后必须 rebaseline 销账**，否则每次写完白跑一次重载。
  const indexPath = opts.containerRoot ? path.join(opts.containerRoot, 'index.json') : null
  // ⛔ 必须把**增量日志**一并交给探针：写入可能只落它、不落 index.json
  //   （修前只盯 index.json ⇒ `ensureFresh()` 对增量写永远返回 false ⇒ 读路径拿旧索引应答且无报错）
  const revision = indexPath && opts.containerRoot
    ? makeRevisionProbe(indexPath, [path.join(opts.containerRoot, 'index.delta.jsonl')])
    : null
  /**
   * ⛔ **构建时就登记基线**（2026-10-14 修 · 真因抓出来了）。
   *
   * `makeRevisionProbe` 的基线是**懒登记**的：第一次 `changed()` 时若 `known === null`，
   * 它把"当前状态"登记为基线并返回 `false`。后果（实测复现）：
   *   ① 建 API（known=null）→ ② **别的实例/CLI 改了盘**（l57 那类多通道写）
   *   → ③ 第一次读端点调 `ensureFresh()` ⇒ 把**改完之后**的状态登记成基线 ⇒ 返回 false
   *   ⇒ **那次改动永远不被发现**，读路径一直拿旧索引应答（而且没有任何报错）。
   * ⇒ 在**构建那一刻**就把基线钉死：此后任何写入都落在"之后"，一定能被发现。
   */
  try { revision?.rebaseline() } catch { /* 登记失败不影响启动（读路径仍按旧行为） */ }
  const ensureFresh = (): boolean => {
    if (!revision) return false
    let changed = false
    try { changed = revision.changed() } catch { return false }
    if (!changed) return false
    try {
      container.load({ verify: false })
      revision.rebaseline()
      return true
    } catch {
      // 重载失败 ⇒ 沿用旧索引应答（⛔ 不许因为盘上坏了就把整条读路径打死）
      return false
    }
  }
  /** 自己写完盘 ⇒ 立刻销账（否则下一次读会白跑一次重载） */
  const afterOwnWrite = (): void => { try { revision?.rebaseline() } catch { /* 销账失败不影响写结果 */ } }

  // ── 【C-0 · H1】GET/POST /onboarding —— 「认识一下」的状态（唯一真源=容器文件）──
  if (opts.containerRoot && opts.productVersion) {
    const root = opts.containerRoot
    const version = opts.productVersion
    // 【可观测性 · 2026-10-26】/diag：只读诊断（token 同其他路由）
    routes.push({
      method: 'GET',
      path: '/diag',
      handler: (_req, res) => {
        try {
          const idx = container.getIndex()
          let version = 'unknown'
          try { version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8')).version } catch { /* 包外运行 */ }
          sendJson(res, 200, { ok: true, data: { version, entries: idx.entries.length, hotOrder: idx.hot_order.length, schema: idx.schema } })
        } catch (e) {
          sendJson(res, 500, { ok: false, error: (e instanceof Error ? e.message : 'diag failed') })
        }
      },
    })
    routes.push({
      method: 'GET',
      path: '/onboarding',
      handler: (_req, res) => { sendJson(res, 200, { ok: true, data: onboardingState(root, version) }) },
    })
    if (opts.suggest) {
      routes.push({
        method: 'POST',
        path: '/onboarding/suggest',
        handler: async (req, res) => {
          try {
            const body = await readJsonBody(req)
            const data = await opts.suggest!(body ?? {})
            sendJson(res, 200, { ok: true, data })
          } catch (error) {
            sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : 'suggest failed' })
          }
        },
      })
    }
    routes.push({
      method: 'POST',
      path: '/onboarding',
      handler: async (_req, res) => {
        const state = markOnboarded(root, version)
        // 首次安装完成后种 9 条 hot 人格锚点（空容器才种）
        let seeded: unknown = null
        try {
          seeded = seedHotAnchors({ container, writer: opts.writer, identity: readIdentity(root) })
        } catch (error) {
          try { opts.log?.warn?.(`[onboarding] hot 锚点种子失败：${String(error)}`) } catch { /* ignore */ }
        }
        sendJson(res, 200, { ok: true, data: { ...state, seeded } })
      },
    })

    // ── 【C-0 · H2】GET/PUT /identity —— 身份档案（原子写 + 白名单）──────────
    routes.push({
      method: 'GET',
      path: '/identity',
      handler: (_req, res) => { sendJson(res, 200, { ok: true, data: readIdentity(root) }) },
    })
    if (opts.allowEdit) {
      routes.push({
        method: 'PUT',
        path: '/identity',
        handler: async (req, res) => {
          const body = await readJsonBody(req)
          const profile = writeIdentity(root, body ?? {})
          sendJson(res, 200, { ok: true, data: profile })
        },
      })
    }
  }

  // GET /list —— 分层列表
  routes.push({
    method: 'GET',
    path: '/list',
    handler: (_req, res) => {
      ensureFresh()   // 【H3】盘上变了先重载再答（l57 那类"拿旧索引应答"的根因）
      const index = container.getIndex()
      // ── 元数据化（压测评审清单 #2）────────────────────────────
      // 原实现在这里对**每个条目** readEntry()，只为拿 scope / scope_id 等小标量——
      // 2000 条时单次请求实测 1645ms（O(n) 全量读盘）。
      // 现在：这些字段已进索引，直接读索引即可；**仅对索引缺字段的旧条目回退读文件**
      // （回填后走零读盘路径，见 scripts/backfill-index.mjs）。
      // 回退判据**来自字段注册表**（V1.3-A · G1）：原先这里硬编码两个字段名
      // （`scope === undefined || status === undefined`）—— 加字段时没人记得改这里，
      // 于是新字段的漂移从"有兜底"变成"无兜底"，而**代码里看不出这个区别**。
      // 现在：`listFallbackFields()` 按契约声明算，缺哪些就补哪些。
      const drifted = index.entries.filter((e) => listFallbackFields(e as unknown as Record<string, unknown>).length > 0)
      // 只读真正缺字段的那些，且每条最多读一次
      const fileCache = new Map<string, ReturnType<typeof container.readEntry>>()
      for (const e of drifted) fileCache.set(e.id, container.readEntry(e.id))

      const entries = index.entries.map((e) => {
        const file = fileCache.get(e.id) ?? null
        // scope 优先取索引；索引缺失时用文件回退（旧条目）
        const scope = e.scope ?? (file ? memoryScope(file.frontmatter) : 'global')
        const scopeId = e.scope_id ?? file?.frontmatter.scope_id
        // temporalState 是纯函数：喂它"由索引拼出的最小 frontmatter"即可，无需完整 frontmatter
        const stateSource = {
          ...(file?.frontmatter ?? {}),
          status: e.status ?? file?.frontmatter.status,
          valid_from: e.valid_from ?? file?.frontmatter.valid_from,
          valid_to: e.valid_to ?? file?.frontmatter.valid_to,
          expires: e.expires ?? file?.frontmatter.expires,
          superseded_by: e.superseded_by ?? file?.frontmatter.superseded_by,
        } as Parameters<typeof temporalState>[0]
        return {
          id: e.id,
          layer: e.layer,
          title: e.title,
          tags: e.tags,
          priority: e.priority,
          updated: e.updated,
          summary: e.summary,
          file: e.file,
          scope,
          scope_id: scopeId,
          temporal_state: temporalState(stateSource),
          // 可见性判定复用 policy.utils——**不在 api 层另写一套**（作用域是安全边界，只许一处实现）
          visible_in_current_scope: isInScope(
            { scope, scope_id: scopeId, status: e.status } as Parameters<typeof isInScope>[0],
            scopeContext,
          ),
          // source 族**不在索引里，也不被设置页列表使用**（只有详情页用，走 /entry/:id）。
          // 为它们回退读文件等于把刚省下的全量读盘又加回来——所以：未读文件时如实返回 undefined，
          // 响应结构不变（字段仍在，值为空），不破坏既有调用方的字段读取。
          source: file?.frontmatter.source,
          source_line: file?.frontmatter.source_line,
          // 候选视图据此隐藏「转正」按钮（已丢弃的候选仍留在 pending 目录里作为墓碑）
          status: e.status ?? file?.frontmatter.status,
          memory_type: e.memory_type ?? file?.frontmatter.memory_type,
          // 【C-2 第2轮】decay_type 加进列表：Agent 页每行的 chip 行与"衰减："统计都要它。
          // 它在契约里是 mirror ⇒ 索引里就有，索引缺的旧条目才回退读文件（与上面几项同一套兜底）。
          decay_type: e.decay_type ?? file?.frontmatter.decay_type,
          // 【作者 拍的口径】陈旧 = **超过半衰期** —— 与 E3 走**同一套**算法（⛔ 不另写一遍）：
          //   fresh = 2^(-t/H)，H 取 FRESH_PARAMS.halfLifeDay（跨会话 30 天）；
          //   t 取 `last_accessed`（每次读取都会写，实测 112/112 有值 ⇒ 数据是活的）。
          // fresh < 0.5 ⇔ t > H ⇒ 陈旧 ⇒ 球上画半透明、行里标注。
          // ⚠️ **回归记录（2026-10-10 实测炸过）**：`fresh.ts` 的 `freshOf` 对**非有限**的半衰期是
            // **抛错**的（`if (!Number.isFinite(H)) throw`），而 `core` 的半衰期是 `Infinity`
            // ⇒ 只要有**一条** core 条目，整个 `/list` 就 500/400（实测：面板直接打不开列表）。
            // ⇒ core 必须在**调 freshOf 之前**处理掉：不衰减 ⇒ fresh 恒 1。
            fresh: freshForEntry(e.last_accessed ?? file?.frontmatter.last_accessed, e.decay_type ?? file?.frontmatter.decay_type),
        }
      })
      sendJson(res, 200, {
        ok: true,
        data: {
          schema: index.schema,
          generated_at: index.generated_at,
          entry_count: entries.length,
          hot_order: index.hot_order,
          allowEdit,
          entries,
        },
      })
    },
  })

  // POST /ui-probe —— UI 点击探针（写文件，调试用）
  if (opts.uiProbe) {
    routes.push({
      method: 'POST',
      path: '/ui-probe',
      handler: async (req, res) => {
        try {
          const body = (await readJsonBody(req)) ?? {}
          opts.uiProbe!(body)
          sendJson(res, 200, { ok: true })
        } catch (e) {
          sendJson(res, 500, { ok: false, error: e instanceof Error ? e.message : 'probe failed' })
        }
      },
    })
  }

  // GET /ui —— exact 01-Memory.html（iframe 用；查询 token 已由 admit 放行）
  if (opts.uiHtml) {
    routes.push({
      method: 'GET',
      path: '/ui',
      handler: (_req, res) => {
        try {
          const html = opts.uiHtml!()
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          res.end(html)
        } catch (e) {
          sendJson(res, 500, { ok: false, error: e instanceof Error ? e.message : 'ui failed' })
        }
      },
    })
  }

  // POST /pin/:id —— UI 桥：钉住/取消钉住（真实 pins.json）
  if (opts.pin) {
    routes.push({
      method: 'POST',
      path: '/pin/',
      handler: async (req, res, rest) => {
        try {
          const body = (await readJsonBody(req)) ?? {}
          const pinned = body.pinned !== false
          opts.pin!(rest, pinned)
          sendJson(res, 200, { ok: true, data: { id: rest, pinned } })
        } catch (e) {
          sendJson(res, 500, { ok: false, error: e instanceof Error ? e.message : 'pin failed' })
        }
      },
    })
  }

  // GET /chain —— UI 链镜头：真实 subjects + 条目 session 映射 + 档位
  if (opts.subjects) {
    routes.push({
      method: 'GET',
      path: '/chain',
      handler: (_req, res) => {
        ensureFresh()
        try {
          const subjects = opts.subjects!()
          const entrySessions: Record<string, string> = {}
          for (const e of container.getIndex().entries) {
            const f = container.readEntry(e.id)
            const sid = f?.frontmatter?.source_session
            if (typeof sid === 'string' && sid) entrySessions[e.id] = sid
          }
          sendJson(res, 200, { ok: true, data: { subjects, entrySessions, tiers: opts.tiers?.() ?? {} } })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : 'chain failed' })
        }
      },
    })
  }

  // Breathe 手动记忆链注册表：GET 只读；写操作受 allowEdit + token/Host/Origin 保护。
  if (opts.chainStore) {
    const store = opts.chainStore
    const chainError = (res: ServerResponse, error: unknown): void => {
      const code = error instanceof ChainRegistryError ? error.code : ''
      const status = code === 'CHAIN_INVALID' ? 400
        : code === 'CHAIN_CONFLICT' ? 409
          : code === 'CHAIN_NOT_FOUND' ? 404
            : code === 'CHAIN_LOCK_BUSY' ? 409 : 500
      sendJson(res, status, { ok: false, error: error instanceof Error ? error.message : 'chain operation failed' })
    }
    const decodeChainParam = (res: ServerResponse, raw: string, label: string): string | null => {
      try { return decodeURIComponent(raw.replace(/^\//, '')) }
      catch { sendJson(res, 400, { ok: false, error: `${label} 编码非法` }); return null }
    }
    routes.push({
      method: 'GET',
      path: '/chains/audit',
      handler: (_req, res) => {
        try {
          const rows = store.readAudit()
          const rolledBack = new Set(rows.map((row) => row.rollbackOf).filter((batch): batch is string => typeof batch === 'string'))
          const current = { version: 1 as const, chains: store.list() }
          const data = rows.slice(-100).map((row) => ({
            ...row,
            canRollback: row.action !== 'rollback' && row.action !== 'migrate' && !rolledBack.has(row.batch)
              && JSON.stringify(row.after) === JSON.stringify(current),
          }))
          sendJson(res, 200, { ok: true, data: { records: data } })
        } catch (error) { chainError(res, error) }
      },
    })
    routes.push({
      method: 'GET',
      path: '/chains',
      handler: (_req, res) => {
        ensureFresh()
        try {
          const chains = store.list()
          const counts = new Map(chains.map((c) => [c.id, 0]))
          for (const meta of container.getIndex().entries) {
            // hot 是根「我」，pending 仍是候选；没有 source_session 的历史记忆留在「史前/未归」。
            if (meta.layer === 'hot' || meta.layer === 'pending') continue
            const file = container.readEntry(meta.id)
            const fm = file?.frontmatter
            if (typeof fm?.source_session !== 'string' || !fm.source_session) continue
            const tags = Array.isArray(fm.tags) ? fm.tags : (meta.tags ?? [])
            const owner = store.assignment(tags, chains)
            if (owner) counts.set(owner.id, (counts.get(owner.id) ?? 0) + 1)
          }
          sendJson(res, 200, { ok: true, data: { chains: chains.map((c) => ({ ...c, count: counts.get(c.id) ?? 0 })) } })
        } catch (error) { chainError(res, error) }
      },
    })
    if (allowEdit) {
      routes.push({
        method: 'POST',
        path: '/chains',
        handler: async (req, res) => {
          try {
            const body = await readJsonBody(req)
            if (Object.keys(body).some((key) => key !== 'name' && key !== 'tag') || typeof body.name !== 'string') {
              sendJson(res, 400, { ok: false, error: '新建链只接受 { name: string, tag?: string }' })
              return
            }
            const chain = store.create(body.name, body.tag)
            sendJson(res, 201, { ok: true, data: chain })
          } catch (error) { chainError(res, error) }
        },
      })
      routes.push({
        method: 'PATCH',
        path: '/chains/',
        handler: async (req, res, rest) => {
          const id = decodeChainParam(res, rest, '链 ID')
          if (id === null) return
          try {
            const body = await readJsonBody(req)
            if (Object.keys(body).some((key) => key !== 'name') || typeof body.name !== 'string') {
              sendJson(res, 400, { ok: false, error: '改名只接受 { name: string }' })
              return
            }
            const chain = store.rename(id, body.name)
            sendJson(res, 200, { ok: true, data: chain })
          } catch (error) { chainError(res, error) }
        },
      })
      routes.push({
        method: 'DELETE',
        path: '/chains/',
        handler: (_req, res, rest) => {
          const id = decodeChainParam(res, rest, '链 ID')
          if (id === null) return
          try {
            store.delete(id)
            sendJson(res, 200, { ok: true, data: { id, deleted: true, memoriesDeleted: false } })
          } catch (error) { chainError(res, error) }
        },
      })
      routes.push({
        method: 'POST',
        path: '/chains/rollback/',
        handler: (_req, res, rest) => {
          const batch = decodeChainParam(res, rest, '批次 ID')
          if (batch === null) return
          try {
            store.rollback(batch)
            sendJson(res, 200, { ok: true, data: { batch, rolledBack: true } })
          } catch (error) { chainError(res, error) }
        },
      })
    }
  }

  // GET /tiers —— UI 链镜头：真实 Breathe 档位（只读；不触发模型）
  if (opts.tiers) {
    routes.push({
      method: 'GET',
      path: '/tiers',
      handler: (_req, res) => {
        ensureFresh()
        try {
          sendJson(res, 200, { ok: true, data: opts.tiers!() })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : 'tiers failed' })
        }
      },
    })
  }

  // GET /graph —— 关系图谱数据（【H3】应答前先做修订检查：见 ensureFresh）
  routes.push({
    method: 'GET',
    path: '/graph',
    handler: (_req, res) => {
      ensureFresh()   // 【H3】盘上索引变了先重载再答
      try {
        const graph = buildMemoryGraph(container)
        sendJson(res, 200, { ok: true, data: graph })
      } catch (error) {
        sendJson(res, 500, {
          ok: false,
          error: error instanceof Error ? error.message : 'graph build failed',
        })
      }
    },
  })

  // GET /entry/:id —— 单条完整内容
  routes.push({
    method: 'GET',
    path: '/entry/',
    handler: (_req, res, rest) => {
      const id = rest
      if (!id) {
        sendJson(res, 400, { ok: false, error: '缺少条目 id' })
        return
      }
      const view = entryView(container, id)
      if (!view) {
        sendJson(res, 404, { ok: false, error: `条目不存在: ${id}` })
        return
      }
      sendJson(res, 200, { ok: true, data: view })
    },
  })

  // PUT /entry/:id —— 编辑（仅 allowEdit）
  if (allowEdit) {
    routes.push({
      method: 'PUT',
      path: '/entry/',
      handler: async (req, res, rest) => {
        const id = rest
        if (!id) {
          sendJson(res, 400, { ok: false, error: '缺少条目 id' })
          return
        }
        let body: Record<string, unknown>
        try {
          body = await readJsonBody(req)
        } catch (error) {
          sendJson(res, 400, {
            ok: false,
            error: error instanceof Error ? error.message : 'invalid body',
          })
          return
        }
        const patch: Record<string, unknown> = {}
        if (body.title !== undefined) {
          if (typeof body.title !== 'string') {
            sendJson(res, 400, { ok: false, error: 'title 必须是字符串' })
            return
          }
          patch.title = body.title
        }
        if (body.content !== undefined) {
          if (typeof body.content !== 'string') {
            sendJson(res, 400, { ok: false, error: 'content 必须是字符串' })
            return
          }
          patch.content = body.content
        }
        if (body.tags !== undefined) {
          if (!Array.isArray(body.tags) || !body.tags.every((t) => typeof t === 'string')) {
            sendJson(res, 400, { ok: false, error: 'tags 必须是字符串数组' })
            return
          }
          patch.tags = body.tags as string[]
        }
        if (body.priority !== undefined) {
          if (typeof body.priority !== 'number') {
            sendJson(res, 400, { ok: false, error: 'priority 必须是数字' })
            return
          }
          patch.priority = body.priority
        }
        if (body.summary !== undefined) {
          if (typeof body.summary !== 'string') {
            sendJson(res, 400, { ok: false, error: 'summary 必须是字符串' })
            return
          }
          patch.summary = body.summary
        }
        if (Object.keys(patch).length === 0) {
          sendJson(res, 400, { ok: false, error: '没有可更新的字段' })
          return
        }
        try {
          // ⚠️ 必须走 writer.edit（事务 + 写锁 + 持锁后重读索引），不得直接调
          // container.updateEntryAndSaveIndex——那是不带锁的旁路，会把内存里的旧索引
          // 整份落盘、静默抹掉别的通道刚写的条目（2026-09-15 收尾轮复现）。
          const entry = container.getIndex().entries.find((e) => e.id === id)
          if (!entry) {
            sendJson(res, 404, { ok: false, error: `条目不存在: ${id}` })
            return
          }
          if (writer) {
            writer.edit(id, patch)
          } else {
            // 无 writer（只读装配）时不应到达：allowEdit 与 writer 同源，这里兜底直改
            const updated = container.updateEntryAndSaveIndex(id, patch)
            if (!updated) {
              sendJson(res, 404, { ok: false, error: `条目不存在: ${id}` })
              return
            }
          }
          const view = entryView(container, id)
          sendJson(res, 200, { ok: true, data: view })
        } catch (error) {
          sendJson(res, 500, {
            ok: false,
            error: error instanceof Error ? error.message : 'update failed',
          })
        }
      },
    })
  }

  // ── V1.0：候选区人工转正路由 ─────────────────────────────
  // POST /pending/:id/confirm   → 转正（默认 longterm；opinion 会自动进 hot_order）
  // POST /pending/:id/discard   → 丢弃（写墓碑，不进正式记忆）
  //
  // ⚠️ 开关一致性（安全专项 §三-5 点出，2026-09-15 修）：
  //   本路由是**写路径**，必须与 PUT /entry/:id 同受 allowEdit 管。
  //   此前它只判 writer 是否存在、不判 allowEdit —— 等于 candidate 转正/丢弃绕过了写开关。
  //   当时的理由是「候选必须有人工出口，不能因开关关闭而永久积压」；但那是**只读容器**的语义，
  //   与「写开关」冲突时应以开关为准：allowEdit=false ⇒ 容器整体不可经 HTTP 写。
  //   需要人工转正时走 CLI（文件级，不经 HTTP），出口依然存在。
  if (writer && allowEdit) {
    routes.push({
      method: 'POST',
      path: '/pending/',
      handler: async (_req, res, rest) => {
        const segments = rest.split('/').filter(Boolean)
        const [id, action] = segments
        const target = decodeURIComponent(id ?? '')
        if (!target || (action !== 'confirm' && action !== 'discard')) {
          sendJson(res, 400, { ok: false, error: '用法: POST /pending/:id/confirm 或 /pending/:id/discard' })
          return
        }
        try {
          const outcome = action === 'confirm'
            ? writer.confirm(target)
            : writer.discard(target)
          sendJson(res, 200, { ok: true, data: outcome })
        } catch (error) {
          const message = error instanceof Error ? error.message : 'pending action failed'
          const notFound = message.includes('ENTRY_NOT_FOUND')
          sendJson(res, notFound ? 404 : 400, { ok: false, error: message })
        }
      },
    })
  }

  // ── 衰减扫描（B6 接线）────────────────────────────────────────────
  // ⚠️ 这三个路由必须注册在**请求分发之外**（`if (method === ...)` 那一层里注册等于没有：
  //    注册要等分发才执行，而分发又靠 `routes.find` 找它们）。
  //    ✅ 2026-10-14 复核：母本 `2e9dbed` 里它们是**可达**的（静态数深度 + 线上 POST 三条全 200），
  //    本轮把它们与 `entry-*` 三个路由的位置理顺、缩进对齐，**行为不变**（属整理，不是修 bug）。
  // GET  /decay-state    —— 面板那行「今天自动归档 M 条 · 撤销」要的数据
  // POST /decay-sweep    —— 跑一次（一天最多一次；force 可强制）
  // POST /decay-rollback —— 撤销**最近一批**（按审计反向搬回）
  // ⚠️ 判定在 decay.ts（纯函数、七条测试）；执行走 w.relocate（单一写入通道）。
  // ✅ 启动时自动跑一次的钩子**已接**：`index.ts` 的 apply()（B6，2026-10-10）；
  //    门槛口径 2026-10-14 改为"当地自然日一次 + 最小间隔 6h"（Breathe-R1，见 docs/decay-design.md「时机」）。
  routes.push({
    method: 'GET',
    path: '/decay-state',
    handler: (_req, res) => {
      const root = opts.containerRoot ?? ''
      const st = root ? readSweepState(root) : null
      const audit = root ? readAudit(root) : []
      const batch = st?.lastBatch ?? ''
      const rolledBack = batch ? audit.some((r) => r.batch === batch && r.rolledBack) : false
      sendJson(res, 200, { ok: true, data: { lastAt: st?.lastAt ?? null, lastCount: st?.lastCount ?? 0, batch, rolledBack } })
    },
  })

  routes.push({
    method: 'POST',
    path: '/decay-sweep',
    handler: async (req, res) => {
      const root = opts.containerRoot
      if (!root || !writer) { sendJson(res, 400, { ok: false, error: '没有容器根目录或写入器' }); return }
      if (opts.sweepDisabledReason) {
        // ⛔ 不调 runSweep：它会在 finally 推进 lastAutoAt ⇒ 一次“不搬”的点击饿掉当天启动的 due
        sendJson(res, 200, { ok: true, data: { ran: false, archived: [], blocked: 0, reason: opts.sweepDisabledReason } })
        return
      }
      const body = (await readJsonBody(req)) ?? {}
      ensureFresh()
      /**
       * ⛔ **非强制的手动扫描必须走 `runDueSweep`**（2026-10-14 架构主线一修）：
       * 修前这里直接 `runSweep` 且**不传 `snap`** ⇒ 它内部**裸读状态文件**、没有审计兜底，
       * 而启动路径走的是 `resolveGateSnapshot`（**带审计兜底 + 损坏检测**）
       * ⇒ **状态文件损坏时两边结论不同**（启动会拦/兜，界面按钮却当"首次运行"照跑）。
       * ⇒ 现在：闸门只有一份实现；`force` 才绕过闸门（那是明确要绕的语义）。
       */
      const manualPlan = opts.chainPlan?.()
      // 【并发修复 · 2026-10-19】pins.json 坏 ⇒ loadPins fail-closed 抛错；手动路也不能 500 裸崩
      let manualPins
      try { manualPins = loadPins(root) } catch (e) {
        sendJson(res, 500, { ok: false, error: `pins.json 不可读（fail-closed，拒绝扫描）：${e instanceof Error ? e.message : String(e)}` })
        return
      }
      // 【P1-4 修复】手动路必须有与启动/tick **同一份** roster（hot_order）：
      //   修前第 3 参传 undefined ⇒ 在册常驻条目失去 roster-anchor ⇒ 手动按钮能把常驻条目归档。
      const manualEntries = () => sweepEntries(container.getIndex().entries, undefined, container.getIndex().hot_order, opts.deliveredCounts?.())
      const out = body.force === true ? runSweep({
        root,
        ...(manualPlan ? { planOverride: manualPlan } : {}),
        entries: manualEntries(),
        pins: manualPins,
        relocate: (id, layer, o) => writer!.relocate(id, layer, o),
        force: true,
        ...(opts.onStateWriteFail ? { onStateWriteFail: opts.onStateWriteFail } : {}),
        // 【G3 · 对抗验证 B 第 7 条】手动路径也要后置校验：
        //   修前只有启动路径传了 `readLayer` ⇒ 同一漂移下启动路径当场点名、手动路径回 200 全绿。
        //   ⛔ `readLayer` 仍是**可选**依赖（不传 = fail-open，既有测试主动钉住这个形状）；
        //      `out.verified` 如实告诉调用方"这次校验了没有"。
        readLayer: (id) => container.getIndex().entries.find((e) => e.id === id)?.layer,
      }) : runDueSweep({
        root,
        ...(manualPlan ? { planOverride: manualPlan } : {}),
        entries: manualEntries(),
        pins: manualPins,
        relocate: (id, layer, o) => writer!.relocate(id, layer, o),
        ...(opts.onStateWriteFail ? { onStateWriteFail: opts.onStateWriteFail } : {}),
        readLayer: (id) => container.getIndex().entries.find((e) => e.id === id)?.layer,
      })
      sendJson(res, 200, { ok: true, data: out })
    },
  })

  routes.push({
    method: 'GET',
    path: '/decay-why',
    /**
     * 【#7 · 2026-10-14】**为什么这条没退场？**
     * 只读、当场算、零存储增长。判据有 6 个拦点 + 1 个"健康不该退"，
     * 这个端点把整条判定链走一遍给人话结论（含 gap：离阈值还差多少）。
     * 用法：GET /decay-why?id=l63
     * ⚠️ query 从 `req.url` 自己解析 —— 分发链传进来的 `rest` 是 pathname，
     *    **query 已经在上面被切掉了**（`pathnameOf` 只取 path）。
     */
    handler: (req, res) => {
      let id = ''
      let wantNow = false
      try {
        const u = new URL(req.url ?? '', 'http://x')
        id = (u.searchParams.get('id') ?? '').trim()
        wantNow = u.searchParams.get('at') === 'now'
      } catch { /* ignore */ }
      if (!id) { sendJson(res, 400, { ok: false, error: '缺 id 参数（用法：/decay-why?id=l63）' }); return }
      /**
       * 【D5 · 对抗验证 D 修】id 校验放宽到**与容器一致**。
       * 修前写死 `^[a-zA-Z0-9_-]{1,64}$` —— 比容器严得多：容器收 `a.b` / `a:b` / `中文` / 70 字符，
       * 而端点一律 400 ⇒ "任何 id 都有答案"这句话不成立。
       * 现在只挡**真正危险**的形态（路径穿越 / 控制字符 / 超长），其余放行。
       */
      if (id.length > 128 || /[/\\\u0000-\u001f]|\.\./.test(id)) {
        sendJson(res, 400, { ok: false, error: `id 形状非法（含路径分隔/控制字符或超长）：${id.slice(0, 40)}` }); return
      }
      // 【D3 · 对抗验证 D 修】盘上变了先重载再答（与 /list /graph 同一条纪律：⛔ 不拿旧索引应答）
      ensureFresh()
      /**
       * 【D4 · 对抗验证 D 修】**把时点锚说清楚**。
       * 修前锚的是**墙钟**，于是它其实在答"**现在**会不会退"，而函数名/文档是"**为什么这条没退场**"
       * （= 上次扫描为什么没退）—— 8 天前的扫描 + 今天的墙钟 ⇒ 结论对不上当次扫描。
       * 现在：默认锚 **上次扫描时刻**（答"上次为什么没退"），`?at=now` 可切回墙钟（答"现在会不会退"）。
       * ⛔ 两种都如实标在返回里（`anchorKind` / `anchorAt`），不许让人猜是哪一种。
       */
      const root = opts.containerRoot
      const gate = root ? resolveGateSnapshot(root, Date.now()) : null
      const lastAt = gate && typeof gate.snap.lastAt === 'number' ? gate.snap.lastAt : null
      const anchorAt = !wantNow && lastAt !== null ? lastAt : Date.now()
      const anchorKind = !wantNow && lastAt !== null ? 'last-scan' : 'now'
      const data = explainDecay(sweepEntries(container.getIndex().entries, anchorAt, undefined, opts.deliveredCounts?.()), id)
      sendJson(res, 200, { ok: true, data: { ...data, anchorAt, anchorKind } })
    },
  })

  routes.push({
    method: 'GET',
    path: '/decay-batches',
    /**
     * 【只读】列出**可以回滚的批次** —— 让"支持指定批次"这个能力真的可用。
     * 只说"能按批次撤"而没有地方查批次号 ⇒ 那能力等于没有（本轮自查时发现：
     * `listRollbackBatches` 加了导出、却没有任何生产调用方 —— 正是死代码门禁要拦的那类）。
     */
    handler: (_req, res) => {
      const root = opts.containerRoot
      if (!root) { sendJson(res, 400, { ok: false, error: '没有容器根目录' }); return }
      sendJson(res, 200, { ok: true, data: { batches: listRollbackBatches(root) } })
    },
  })

  routes.push({
    method: 'POST',
    path: '/decay-rollback',
    handler: async (req, res) => {
      const root = opts.containerRoot
      if (!root || !writer) { sendJson(res, 400, { ok: false, error: '没有容器根目录或写入器' }); return }
      try {
        const body = (await readJsonBody(req)) ?? {}
        // 【2026-10-14】可选 `batch`：指定撤**哪一批**。
        //   修前只能撤最近一批 ⇒ 更早的（**包括 G1 自愈补回来的记录**）永远撤不了。
        //   不传 = 旧行为（撤最近一批），⛔ 既有调用方与 UI 一行不用改。
        const want = typeof body.batch === 'string' ? body.batch.trim() : ''
        if (want && !/^sweep-\d{8,}/.test(want)) {
          sendJson(res, 400, { ok: false, error: `batch 形状非法（应为 sweep-<时间戳>）：${want}` }); return
        }
        /**
         * ⛔ **先重载再动手**（本仓纪律：盘上变了先重载 —— 见 `/decay-why` 与 `/list` 同款处理）。
         * 实测踩过：回滚的幂等判断读的是**本进程的索引**，而索引可能是旧的
         * （例：扫描由**另一个 container 实例**完成）⇒ 索引里条目**还在 longterm**
         * ⇒ 幂等判断以为"已经撤过了" ⇒ **整批被跳过、一条不撤、还报成功**（测试当场抓到）。
         */
        ensureFresh()
        // ⛔ 必须传 readLayer：回滚的**幂等**靠它（条目已在目标层就跳过，⛔ 不抛）
        //   —— 不传的话"搬完但标记没落"那条路径重试会撞「已在 longterm 层」⇒ 永久 500（对抗验证 C 的第 2 条）
        const readLayer = (id: string): string | undefined => container.getIndex().entries.find((e) => e.id === id)?.layer
        const out = want
          ? rollbackBatch({ root, batch: want, relocate: (id, layer, o) => writer!.relocate(id, layer, o), readLayer })
          : rollbackLastBatch({ root, relocate: (id, layer, o) => writer!.relocate(id, layer, o), readLayer })
        afterOwnWrite()   // ⛔ 我们自己写了盘 ⇒ 立刻销账（否则下一次读白跑一次重载）
        sendJson(res, 200, { ok: true, data: { ...out, count: out.rolledBack.length } })
      } catch (e) {
        sendJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    },
  })

  // ── 排障自检（V1.1 增量② 配套）──────────────────────────────────
  // 为什么需要它：动态预算的采样状态与压缩接入点的解析结果**只进日志**，
  // 在宿主里没有观察窗口 —— 没有这个端点，"预算是否真的在采样""压缩是否真的可达"
  // 就只能靠"看起来没问题"。自检端点把这两件事变成可 curl 的事实。
  // 安全：与其它路由共用同一套三层准入（Host / Origin / token）；GET 只读、绝不触发 LLM。
  if (opts.introspect) {
    routes.push({
      method: 'GET',
      path: '/selftest',
      handler: async (_req, res) => {
        try {
          sendJson(res, 200, { ok: true, data: await opts.introspect!() })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : 'introspect failed' })
        }
      },
    })
  }
  if (opts.compressProbe) {
    routes.push({
      method: 'POST',
      path: '/selftest/compress',
      handler: async (req, res) => {
        // 允许用 query 覆盖 maxTokens / model（排障用）：
        //   POST /selftest/compress?maxTokens=4096
        //   POST /selftest/compress?model=<name>
        // 让"试不同额度/模型"不必改配置重启。
        const q = (req.url ?? '').indexOf('?')
        const qs = new URLSearchParams(q >= 0 ? (req.url ?? '').slice(q + 1) : '')
        const rawMax = qs.get('maxTokens')
        // body 可传 text / instruction（评测用）；query 仍可覆盖 maxTokens / model。
        // 不传 body 时行为与原实现完全一致。
        const body = await readJsonBody(req).catch(() => ({} as Record<string, unknown>))
        const overrides = {
          ...(typeof body.text === 'string' ? { text: body.text } : {}),
          ...(typeof body.instruction === 'string' ? { instruction: body.instruction } : {}),
          ...(rawMax !== null && Number.isFinite(Number(rawMax)) ? { maxTokens: Number(rawMax) } : {}),
          ...(qs.get('model') ? { model: qs.get('model')! } : {}),
          ...(typeof body.maxTokens === 'number' ? { maxTokens: body.maxTokens } : {}),
          ...(typeof body.model === 'string' && body.model ? { model: body.model } : {}),
        }
        try {
          sendJson(res, 200, { ok: true, data: await opts.compressProbe!(overrides) })
        } catch (error) {
          // 压缩失败不是"服务端故障"：如实回错误（降级语义由调用方决定）
          sendJson(res, 502, { ok: false, error: error instanceof Error ? error.message : 'compress probe failed' })
        }
      },
    })
  }

  /** 入口 handler：路由分发（任何 handler 异常都转 500，绝不外泄崩进程） */
  function handler(req: IncomingMessage, res: ServerResponse): void {
    const pathname = pathnameOf(req.url)
    const method = req.method ?? 'GET'
    if (!pathname.startsWith(normPrefix)) {
      sendJson(res, 404, { ok: false, error: 'not found' })
      return
    }
    // 准入校验前置：Host / Origin / token 三层，任一不过直接拒，不进路由
    const denied = admit(req, method)
    if (denied) {
      sendJson(res, denied.status, { ok: false, error: denied.error })
      return
    }
    const rest = pathname.slice(normPrefix.length)
    const run = (promise: Promise<void> | void): void => {
      void Promise.resolve(promise).catch((error) => {
        sendJson(res, 500, {
          ok: false,
          error: error instanceof Error ? error.message : 'internal error',
        })
      })
    }
    // GET /list
    // ⛔ 这里原先写的是 `routes[0]` —— **靠数组下标**找路由。
    // 2026-10-10 实测后果：C-0 往数组里插了四条新路由，下标 0 不再是 /list，
    // 于是 `GET /list` 开始**返回 onboarding 的数据**（端点静默串味，没有任何报错）。
    // 现在与其它路由一致：按 path + method 找。加了源码级判据挡住这类回归。
    if (method === 'GET' && rest === '/list') {
      const route = routes.find((r) => r.path === '/list' && r.method === 'GET')
      if (route) { run(route.handler(req, res, '')); return }
    }
    // ── 衰减扫描三条（B6）：**注册了还必须加进这条分发链**，否则 404
    //    （2026-10-10 实测：路由注册了、分发链忘了加 ⇒ 一直 404，而 /list 正常 ⇒ 极易误判成"没部署"）
    if (method === 'GET' && rest === '/decay-state') {
      const route = routes.find((r) => r.path === '/decay-state' && r.method === 'GET')
      if (route) { run(route.handler(req, res, '')); return }
    }
    if (method === 'POST' && rest === '/decay-sweep') {
      const route = routes.find((r) => r.path === '/decay-sweep' && r.method === 'POST')
      if (route) { run(route.handler(req, res, '')); return }
    }
    if (method === 'POST' && rest === '/decay-rollback') {
      const route = routes.find((r) => r.path === '/decay-rollback' && r.method === 'POST')
      if (route) { run(route.handler(req, res, '')); return }
    }
    // 【#7】GET /decay-why?id=xxx —— ⛔ 同样必须接进分发链（不接就是 404，10-10 踩过）
    if (method === 'GET' && rest === '/decay-why') {
      const route = routes.find((r) => r.path === '/decay-why' && r.method === 'GET')
      if (route) { run(route.handler(req, res, '')); return }
    }
    // 【只读】GET /decay-batches —— 同上，⛔ 不接分发链就是 404
    if (method === 'GET' && rest === '/decay-batches') {
      const route = routes.find((r) => r.path === '/decay-batches' && r.method === 'GET')
      if (route) { run(route.handler(req, res, '')); return }
    }
    // GET /graph
    if (method === 'POST' && rest === '/ui-probe') {
      const route = routes.find((r) => r.path === '/ui-probe' && r.method === 'POST')
      if (route) return void route.handler(req, res, '')
    }
    if (method === 'GET' && rest === '/ui') {
      const route = routes.find((r) => r.path === '/ui' && r.method === 'GET')
      if (route) return void route.handler(req, res, '')
    }
    if (method === 'POST' && rest.startsWith('/pin/')) {
      const route = routes.find((r) => r.path === '/pin/' && r.method === 'POST')
      if (route) return void route.handler(req, res, rest.slice('/pin/'.length))
    }
    if (method === 'GET' && rest === '/chain') {
      const route = routes.find((r) => r.path === '/chain' && r.method === 'GET')
      if (route) return void route.handler(req, res, '')
    }
    if (rest === '/chains/audit' && method === 'GET') {
      const route = routes.find((r) => r.path === '/chains/audit' && r.method === 'GET')
      if (route) { run(route.handler(req, res, '')); return }
    }
    if (rest === '/chains') {
      const route = routes.find((r) => r.path === '/chains' && r.method === method)
      if (route) { run(route.handler(req, res, '')); return }
    }
    if (rest.startsWith('/chains/rollback/')) {
      const route = routes.find((r) => r.path === '/chains/rollback/' && r.method === method)
      if (route) { run(route.handler(req, res, rest.slice('/chains/rollback/'.length))); return }
    }
    if (rest.startsWith('/chains/')) {
      const route = routes.find((r) => r.path === '/chains/' && r.method === method)
      if (route) { run(route.handler(req, res, rest.slice('/chains/'.length))); return }
    }
    if (method === 'GET' && rest === '/tiers') {
      const route = routes.find((r) => r.path === '/tiers' && r.method === 'GET')
      if (route) return void route.handler(req, res, '')
    }
    if (method === 'GET' && rest === '/diag') {
      const route = routes.find((r) => r.path === '/diag' && r.method === 'GET')
      if (route) return void route.handler(req, res, '')
    }
    if (method === 'GET' && rest === '/graph') {
      const route = routes.find((r) => r.path === '/graph' && r.method === 'GET')
      if (route) {
        run(route.handler(req, res, ''))
        return
      }
    }
    // GET/PUT /entry/:id —— 按 path 匹配，不按 method 首匹配
    if (rest.startsWith('/entry/')) {
      const entryId = decodeURIComponent(rest.slice('/entry/'.length))
      const route = routes.find((r) => r.path === '/entry/' && r.method === method)
      if (route) {
        run(route.handler(req, res, entryId))
        return
      }
    }
    // ═══ 【C-0 · H5/H6】三个状态机动作的出口 ═══════════════════════════════
  // 原型自己标注"未开工"的正是这三个（升 hot / 降归档 / 取代 / 标记过期）——
  // 它们要动分层与状态机，所以此前**一个 API 都没有**。
  // 实现全部复用既有原语：`writer.relocate`（H5）与 `writer.edit`（H6），⛔ 不新造写路径。
  if (opts.writer && opts.allowEdit) {
    const w = opts.writer

    // POST /entry/:id/relocate —— body: { layer, reason? }（升 hot / 降归档 / 进归档）


    routes.push({
      method: 'POST',
      path: '/entry-relocate/',
      handler: async (req, res, rest) => {
        const id = decodeURIComponent((rest ?? '').replace(/^\//, ''))
        const body = (await readJsonBody(req)) ?? {}
        const layer = String(body.layer ?? '')
        if (!['hot', 'longterm', 'archive'].includes(layer)) {
          sendJson(res, 400, { ok: false, error: `layer 非法：${layer}（只接受 hot / longterm / archive）` })
          return
        }
        const out = w.relocate(id, layer as 'hot' | 'longterm' | 'archive', {
          operator: String(body.operator ?? 'ui'),
          reason: String(body.reason ?? ''),
        })
        afterOwnWrite()
        sendJson(res, 200, { ok: true, data: out })
      },
    })

    // POST /entry/:id/supersede —— body: { by, reason? }（写 status + superseded_by）
    routes.push({
      method: 'POST',
      path: '/entry-supersede/',
      handler: async (req, res, rest) => {
        const id = decodeURIComponent((rest ?? '').replace(/^\//, ''))
        const body = (await readJsonBody(req)) ?? {}
        const by = String(body.by ?? '')
        if (!by) { sendJson(res, 400, { ok: false, error: '缺少 by（被谁取代）—— 取代链必须留痕' }); return }
        // ⛔ 自取代必须挡住（2026-10-14 对抗验证 E）：`by === id` 会把这条**自己取代自己**
        //   ⇒ `status: 'superseded'` ⇒ **永久退出注入**，而且取代链指向自己、后人看不懂。
        //   修前这里只查了"非空"与"存在"，没查"不是自己"。
        if (by === id) {
          sendJson(res, 400, { ok: false, error: `不能自己取代自己（by 与 id 相同：${by}）—— 那会让这条永久退出注入且取代链自指` })
          return
        }
        if (!container.getIndex().entries.some((e) => e.id === by)) {
          sendJson(res, 400, { ok: false, error: `by 指向的条目不存在：${by}` })
          return
        }
        const out = w.edit(id, { status: 'superseded', superseded_by: by })
        afterOwnWrite()
        sendJson(res, 200, { ok: true, data: out })
      },
    })

    // POST /entry-activate/:id —— 人工提及：真实落 last_accessed/access_count
    routes.push({
      method: 'POST',
      path: '/entry-activate/',
      handler: async (_req, res, rest) => {
        const id = decodeURIComponent((rest ?? '').replace(/^\//, ''))
        try {
          const out = w.activate(id)
          afterOwnWrite()
          sendJson(res, 200, { ok: true, data: out })
        } catch (e) {
          sendJson(res, 400, { ok: false, error: e instanceof Error ? e.message : 'activate failed' })
        }
      },
    })

    // POST /entry/:id/expire —— body: { expires, reason? }（**expires 是唯一到期口径**）
    routes.push({
      method: 'POST',
      path: '/entry-expire/',
      handler: async (req, res, rest) => {
        const id = decodeURIComponent((rest ?? '').replace(/^\//, ''))
        const body = (await readJsonBody(req)) ?? {}
        const expires = String(body.expires ?? '')
        if (!expires) { sendJson(res, 400, { ok: false, error: '缺少 expires（如 2026-10-31）' }); return }
        if (!/^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/.test(expires) || Number.isNaN(Date.parse(expires))) {
          sendJson(res, 400, { ok: false, error: `expires 形状非法（应为日期/ISO 时间）：${expires}` }); return
        }
        const out = w.edit(id, { expires })
        afterOwnWrite()
        sendJson(res, 200, { ok: true, data: out })
      },
    })
  }

  // POST /pending/:id/confirm|discard —— 候选人工转正（writer 存在时才注册）
    if (method === 'POST' && rest.startsWith('/entry-activate/')) {
      const route = routes.find((r) => r.path === '/entry-activate/' && r.method === 'POST')
      if (route) return void route.handler(req, res, rest.slice('/entry-activate/'.length))
    }
    if (method === 'POST' && rest.startsWith('/pending/')) {
      const route = routes.find((r) => r.path === '/pending/' && r.method === 'POST')
      if (route) {
        run(route.handler(req, res, rest.slice('/pending/'.length)))
        return
      }
    }
    // 【C-0】GET/POST /onboarding —— 「认识一下」状态
    if (method === 'POST' && rest === '/onboarding/suggest') {
      const route = routes.find((r) => r.path === '/onboarding/suggest' && r.method === 'POST')
      if (route) { void route.handler(req, res, ''); return }
    }
    if ((method === 'GET' || method === 'POST') && rest === '/onboarding') {
      const route = routes.find((r) => r.path === '/onboarding' && r.method === method)
      if (route) { run(route.handler(req, res, '')); return }
    }
    // 【C-0】GET/PUT /identity —— 身份档案
    if ((method === 'GET' || method === 'PUT') && rest === '/identity') {
      const route = routes.find((r) => r.path === '/identity' && r.method === method)
      if (route) { run(route.handler(req, res, '')); return }
    }
    // 【C-0】POST /entry-{relocate,supersede,expire}/:id —— 状态机与分层动作
    for (const kind of ['relocate', 'supersede', 'expire']) {
      const head = `/entry-${kind}/`
      if (method === 'POST' && rest.startsWith(head)) {
        const route = routes.find((r) => r.path === head && r.method === 'POST')
        if (route) { run(route.handler(req, res, rest.slice(head.length - 1))); return }
      }
    }
    // GET /selftest —— 排障自检（只读，不触发 LLM）
    if (method === 'GET' && rest === '/selftest') {
      const route = routes.find((r) => r.path === '/selftest' && r.method === 'GET')
      if (route) {
        run(route.handler(req, res, ''))
        return
      }
    }
    // POST /selftest/compress —— 显式触发一次真实压缩调用（会产生 LLM 请求）
    if (method === 'POST' && rest === '/selftest/compress') {
      const route = routes.find((r) => r.path === '/selftest/compress' && r.method === 'POST')
      if (route) {
        run(route.handler(req, res, ''))
        return
      }
    }
    sendJson(res, 404, { ok: false, error: `no route: ${method} ${pathname}` })
  }

  return { handler, routes, allowEdit }
}
