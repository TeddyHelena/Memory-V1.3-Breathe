/** memory-container settings tab (browser half): 知识球 / 关系图 / 列表三视图 + 编辑。 */

import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// 【C-2】座位名由**宿主包**声明（⛔ 不自己手写一份 = 第二份手写判据）：
//   · `main`（整屏主面板）← dsh-client-ui-layout
//   · `sidebar.panellist`（侧边栏条目）← dsh-client-ui-sidebar
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { createApiSurface } from './api-surface.ts'
import { MemoryPanelSafe } from './MemoryPanel.tsx'
import { ExactUi } from './ExactUi.tsx'
import { MemoryPanelIcon } from './MemoryPanelIcon.tsx'
import type { MemoryEntryDetail, MemoryListData, MemoryPanelInjected } from './types-client.ts'
import type { MemoryGraph } from './graph-types.ts'
import { en, zh, type MemoryTabLocaleKey } from './locales.ts'

export type { MemoryPanelProps } from './MemoryPanel.tsx'
export type { MemoryPanelIconProps } from './MemoryPanelIcon.tsx'
export type { MemoryEntryDetail, MemoryEntryMeta, MemoryListData, MemoryPanelInjected } from './types-client.ts'
export type { MemoryGraph, GraphNode, GraphLink } from './graph-types.ts'
export type { MemoryTabLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Memory container settings tab copy. */
    'settings.memory': MemoryTabLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.memory'

/** Services required by the Settings registration. */
export const inject = ['slots', 'locale']

/**
 * API 前缀：优先用宿主注入的值（`__DSH_MEMORY_API_PREFIX__`），否则回落默认。
 *
 * 为什么必须注入而不是写死：客户端是独立 bundle，拿不到宿主 config。
 * 写死 `/api/memory` 会让「自定义 apiPrefix」变成**静默坏前端**——
 * 宿主在 `/api/mem2` 上开了路由，客户端却一直打 `/api/memory`，界面全空且没有明确报错。
 */
const DEFAULT_API_PREFIX = '/api/memory'

function resolveApiPrefix(): string {
  const injected = (globalThis as Record<string, unknown>).__DSH_MEMORY_API_PREFIX__
  return typeof injected === 'string' && injected.startsWith('/') ? injected : DEFAULT_API_PREFIX
}

const API_PREFIX = resolveApiPrefix()

/**
 * 共享 token 读取（安全专项 §三-5）。
 *
 * host 侧插件启动时生成 token，并通过宿主 `webserver/index-inject` 写入页面
 * globalThis.__DSH_MEMORY_TOKEN__；本函数把它取出来放进请求头。
 *
 * 三种情形都要能正常工作：
 *   ① 正常（token 已注入）→ 带上头
 *   ② host 侧关掉 token（apiToken: 'off'）→ 页面没有该全局，不带头发请求（服务端也不校验）
 *   ③ 注入未生效（宿主版本差异）→ 同上不带头；此时服务端会返回 401，
 *      错误信息里会说明是缺 token，而不是静默失败
 */
function readInjectedToken(): string {
  const value = (globalThis as Record<string, unknown>).__DSH_MEMORY_TOKEN__
  return typeof value === 'string' ? value : ''
}

/**
 * 【2026-10-14】HTTP 出口**整体搬到 `./api-surface.ts`**（那里能在 node 里跑 ⇒ 能测**真接线**）。
 * 起因：对抗验证 E 发现 `decayState/decaySweep/decayRollback` **二次解包** `r.data`
 * （而 `apiFetch` 已经剥过壳）⇒ 恒取兜底零值 ⇒ **衰减那行 UI 与撤销按钮从来没工作过**。
 * ⛔ 这个 bug 在沙箱里看不见 —— 沙箱注入的是**桩**，桩绕过了 `apiFetch`。
 *    ⇒ 判"接线对不对"必须用**真 HTTP + 真注入面**（见 `test/client-wiring.test.mjs`）。
 */
/** Contribute the Memory tab to the Plugins settings section. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'memory-container: tab dictionaries')

  const t = ctx.locale.bind(NS)

  // ⛔ 传函数不传值：页面注入可能晚于 apply()，传值会把空 token **永久固化**
  const injected = createApiSurface({ prefix: API_PREFIX, token: readInjectedToken })

  const panelInjected = (): MemoryPanelInjected => injected

  // ⛔ 旧的「设置 → 插件 → 记忆」页签**已删除**（作者 2026-10-10："老的记忆页面在内置插件
  // 那里面的记忆页面还没有删除呢"）。主面板接管全部入口；设置页那份是上一代实现，
  // 与主面板并存会变成**两个真源**（同一份数据两套渲染、两套行为）。
  // 想找回它：git show <旧提交>:src/client/MemoryTab.tsx

  // ── 【C-2】侧边栏条目 + 整屏主面板 ────────────────────────────────────────
  // 两个座位用**同一个 id / key = 'memory' 配对**：宿主按 `main` 的 key 选中面板，
  // 侧边栏负责画按钮并从 list 元数据里解析 label（我们只出图标内容 —— 见诉求书 §二）。
  // ⛔ 设置页签**保留**（作者 拍）：两个入口不冲突，主面板是"用"，设置页是"查"。
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: 'memory',
    order: 10,                       // 现有占位：plugins(0) / oauth-subs(5) ⇒ 我们排后面
    label: () => t('panel'),
  }, MemoryPanelIcon))

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: 'memory',
    locale: NS,
    inject: panelInjected,
  }, ExactUi))
}
