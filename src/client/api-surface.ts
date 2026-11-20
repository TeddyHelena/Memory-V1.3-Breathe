/**
 * **注入面的构造**（客户端所有 HTTP 的**唯一出口**）。
 *
 * ## 为什么把它从 `index.ts` 抽出来（2026-10-14）
 * 对抗验证 E 打出一个**在沙箱里永远看不见**的 bug：`apiFetch` **已经剥掉了**
 * `{ ok, data }` 外壳（返回 `body.data`），而 `decayState/decaySweep/decayRollback`
 * **又读了一层 `r.data`** ⇒ 恒 `undefined` ⇒ 全取兜底零值。真 HTTP 打真容器：
 * 服务端说"今天归档了 5 条"，面板拿到 0、屏上写"今天无自动归档"、
 * **撤销按钮永远不出现** —— 那条 UI 纪律（"不许静默 + 旁边就是撤销"）一个字没落地。
 *
 * ⛔ 为什么`npm run shoot` 九张截图全是绿的：沙箱注入的是**桩**，桩**绕过了 `apiFetch`**
 *    ⇒ **桩把接线 bug 藏住了**。⇒ 结论：**要判"接线对不对"，必须用真 HTTP + 真注入面**，
 *    不能靠桩。抽出来是为了能这么测（见 `test/client-wiring.test.mjs`）。
 *
 * ⛔ 本文件**不许 import 任何浏览器专有的东西**（window / DOM）—— 它要能在 node 里跑。
 *    前缀与 token 由调用方传进来。
 */
import type { MemoryEntryDetail, MemoryListData, MemoryPanelInjected } from './types-client.ts'
import type { MemoryGraph } from './graph-types.ts'

export interface ApiSurfaceOptions {
  /** 注入的前缀（例 `/api/memory`） */
  prefix: string
  /**
   * 共享 token（空串 = 不带头）。
   * ⚠️ 允许传**函数**：页面注入可能晚于 `apply()`（宿主版本差异）⇒ 每次请求现取，
   *    否则会把"注入还没发生"那一刻的空 token **永久固化**。
   */
  token: string | (() => string)
  /** fetch 实现（默认真局 `fetch`；测试可注入） */
  fetchImpl?: typeof fetch
}

/**
 * 造一份注入面。⛔ 所有方法的返回都必须是**已经剥过壳**的业务数据
 * （宿主统一返回 `{ ok, data?, error? }`，这一层负责剥 + 抛错）。
 */
export function createApiSurface(opts: ApiSurfaceOptions): MemoryPanelInjected {
  const doFetch = opts.fetchImpl ?? fetch
  const tokenOf = typeof opts.token === 'function' ? opts.token : (): string => opts.token as string
  const apiFetch = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const res = await doFetch(`${opts.prefix}${path}`, {
      headers: {
        'content-type': 'application/json',
        ...(tokenOf() ? { 'x-memory-token': tokenOf() } : {}),
      },
      ...init,
    })
    const body = (await res.json()) as { ok: boolean; data?: T; error?: string }
    if (!body.ok) throw new Error(body.error ?? `api ${path} failed (${res.status})`)
    // ⛔ 只剥这一层。下游**不许**再读 `.data` —— 那会恒 undefined 并静默取兜底值
    return body.data as T
  }

  const post = (path: string, body?: unknown): Promise<unknown> =>
    apiFetch(path, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

  return {
    list: () => apiFetch<MemoryListData>('/list'),
    graph: () => apiFetch<MemoryGraph>('/graph'),
    tiers: () => apiFetch<Record<string, string>>('/tiers'),
    chain: () => apiFetch<import('./types-client.ts').MemoryChainData>('/chain'),
    getEntry: (id) => apiFetch<MemoryEntryDetail>(`/entry/${encodeURIComponent(id)}`),
    updateEntry: (id, patch) => apiFetch(`/entry/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(patch) }),
    confirmPending: (id) => post(`/pending/${encodeURIComponent(id)}/confirm`),
    discardPending: (id) => post(`/pending/${encodeURIComponent(id)}/discard`),
    relocate: (id, layer, reason = '') => post(`/entry-relocate/${encodeURIComponent(id)}`, { layer, reason }),
    supersede: (id, by, reason = '') => post(`/entry-supersede/${encodeURIComponent(id)}`, { by, reason }),
    expire: (id, expires) => post(`/entry-expire/${encodeURIComponent(id)}`, { expires }),
    onboarding: () => apiFetch('/onboarding'),
    markOnboarded: () => post('/onboarding'),
    identity: () => apiFetch('/identity'),
    saveIdentity: (fields) => apiFetch('/identity', { method: 'PUT', body: JSON.stringify(fields) }),
    // 【B6】三个衰减端点：⛔ 直接返回 `apiFetch` 的结果（它已经是 data 本身）
    decayState: () => apiFetch('/decay-state'),
    decaySweep: (force = false) => apiFetch('/decay-sweep', { method: 'POST', body: JSON.stringify({ force }) }),
    decayRollback: () => apiFetch('/decay-rollback', { method: 'POST', body: JSON.stringify({}) }),
  }
}
