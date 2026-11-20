/**
 * 面板沙箱入口（**只给截图对照用**，不进 profile、不发布）
 *
 * 用途：把 `MemoryPanel` 用 **mock 注入**挂起来 ⇒ 截图台能拍**我们自己的面板**，
 * 与原型 `01-Memory.html` 的同状态图**逐张并排**（这是五轮里唯一缺的那半）。
 *
 * ⛔ 这里的数据全是假的（mock），**不连容器、不发请求**；⛔ 不改动任何生产行为。
 */

import ReactDOM from 'react-dom'

import { MemoryPanel } from './MemoryPanel.tsx'
import { WakeOverlay } from './WakeOverlay.tsx'
import type { MemoryEntryDetail, MemoryEntryMeta, MemoryListData, MemoryPanelInjected } from './types-client.ts'
import type { MemoryGraph } from './graph-types.ts'

const mk = (id: string, layer: MemoryEntryMeta['layer'], title: string, status: string, decay: string, tags: string[], pri = 60, updated = '2026-10-08'): MemoryEntryMeta => ({
  id, layer, title, tags, priority: pri, updated, summary: `${title} 的摘要`, file: `${layer}/${id}.md`,
  scope: 'global', temporal_state: 'active', visible_in_current_scope: true, status, decay_type: decay,
})

const ENTRIES: MemoryEntryMeta[] = [
  mk('h01', 'hot', '作者 事实锚点-核心', 'active', 'recent', ['人格', '锚点'], 98),
  mk('h02', 'hot', '称呼方式', 'active', 'recent', ['人格'], 95),
  mk('h03', 'hot', '助手 身份核心', 'active', 'recent', ['人格', '身份'], 96),
  mk('p20', 'longterm', '跨层常驻样例', 'active', 'core', ['常驻'], 90),
  mk('l44', 'longterm', '窗口壳修复·点叉后台运行', 'active', 'recent', ['Harness', '窗口'], 70, '2026-08-31'),
  mk('l57', 'longterm', '容器多写入通道一致性教训', 'active', 'recent', ['容器', '教训'], 80, '2026-09-14'),
  mk('p07', 'longterm', '已过期样例（画空心）', 'expired', 'process', ['过期'], 60, '2026-09-25'),
  mk('a03', 'archive', '归档样例', 'active', 'recent', ['归档'], 55, '2026-09-01'),
  mk('p31', 'pending', '候选样例（不进图）', 'active', 'recent', ['候选'], 60),
]

const LIST: MemoryListData = {
  schema: 'harness-memory-container/12', generated_at: new Date().toISOString(),
  entry_count: ENTRIES.length, hot_order: ['h01', 'h02', 'h03'], allowEdit: true, entries: ENTRIES,
}

/** 故意带**表格 + 粗体**：正好验"渲染器支不支持表格"那条（作者 当场抓过） */
const CONTENT = `# 事实锚点

| 项 | 内容 |
|---|---|
| 姓名 | 小林 |
| 称呼 | 小林 / 阿青 / **老哥** |

正文在这里。`

const DETAIL = (id: string): MemoryEntryDetail => ({
  id, layer: ENTRIES.find((e) => e.id === id)?.layer ?? 'longterm',
  title: ENTRIES.find((e) => e.id === id)?.title ?? id,
  tags: ENTRIES.find((e) => e.id === id)?.tags ?? [], priority: 60, updated: '2026-10-08',
  summary: '摘要', content: CONTENT, status: 'active', source: 'mock', source_session: 'sandbox',
})

const GRAPH: MemoryGraph = {
  hot_order: ['h01', 'h02', 'h03'],
  nodes: ENTRIES.filter((e) => e.layer !== 'pending').map((e) => ({
    id: e.id, layer: e.layer, status: e.status, title: e.title, tags: e.tags, priority: e.priority, updated: e.updated, summary: e.summary,
  })),
  links: [
    // ⚠️ 字段真名是 `type`（`'hot' | 'group' | 'tag'`）—— 我第一版写成 `kind`，
    //    于是 Graph3D 拿到 undefined 颜色，在 `color.replace(...)` 上**整块崩掉**。
    { source: 'h01', target: 'h02', type: 'hot' },
    { source: 'h02', target: 'h03', type: 'hot' },
    { source: 'l44', target: 'l57', type: 'tag' },
  ],
}

const injected: MemoryPanelInjected = {
  list: async () => LIST,
  graph: async () => GRAPH,
  tiers: async () => Object.fromEntries(ENTRIES.map((e) => [e.id, 'full'])),
  chain: async () => ({ subjects: [], entrySessions: {}, tiers: {} }),
  getEntry: async (id) => DETAIL(id),
  updateEntry: async (id) => DETAIL(id),
  confirmPending: async () => ({}),
  discardPending: async () => ({}),
  relocate: async () => ({}),
  supersede: async () => ({}),
  expire: async () => ({}),
  // ⚠️ 特意让向导**开着**：B9 的证据就是拍它（要看到真选项，不是 TODO）
  // ⚠️ 只开**第一次**：走完向导后 load() 会再问一次，若还返回 needed:true 就把向导弹回来
  // ⇒ 转场结束后看不到 Agent 视图（07 那张就拍不到）。沙箱专用行为，⛔ 不影响生产。
  onboarding: async () => {
    const first = !(globalThis as { __sandboxOnboardedOnce?: boolean }).__sandboxOnboardedOnce
    ;(globalThis as { __sandboxOnboardedOnce?: boolean }).__sandboxOnboardedOnce = true
    return { needed: first, version: null, onboardedAt: null, reason: 'sandbox' }
  },
  identity: async () => ({ schema: 'sandbox', fields: {}, updatedAt: null, droppedKeys: [] }),
  saveIdentity: async () => ({}),
  markOnboarded: async () => ({}),
  // 【B6】衰减扫描三件（沙箱里给桩，不发请求）
  // 特意给 3：UI 那条「今天自动归档 M 条 · 撤销」只在 M>0 时走"有撤销按钮"的分支，
  // 而生产首日是 0 ⇒ 那个分支从没被拍过（沙箱补上）
  decayState: async () => ({ lastAt: Date.now() - 3600_000, lastCount: 3, batch: 'sweep-sandbox', rolledBack: false }),
  decaySweep: async () => ({ ran: false, archived: [], blocked: 0 }),
  decayRollback: async () => ({ rolledBack: [], count: 0 }),
}

// 【B8 证据·组件级】沙箱支持 `?wake=<phase>`：直接渲染「唤醒」覆盖层，用于拍那一帧。
// ⛔ 这是**开发页**的能力（不进 profile），⛔ 不改任何生产行为。
const wakePhase = new URLSearchParams(location.search).get('wake') as 'solid' | 'handoff' | 'flight' | 'settle' | 'slide' | null
// 【审美术对照表】`?spread=` / `?particles=` 覆盖特效层的审美参数（⛔ 开发页专用，不进 profile）
//   为什么要它：`spread`（炸开多大）这类**只能看**，光靠描述定不了 —— 摆出来给人挑。
const _fxq = new URLSearchParams(location.search)
// ⛔ 必须夹上限（2026-10-14 对抗验证 F）：`?spread=3` 会让粒子越出单位场、
//    `?particles=1e7` 会在主线程同步卡 1.67 秒 —— 开发页也是要被点开的页面。
const _num = (k: string, lo: number, hi: number): number | undefined => {
  const v = Number(_fxq.get(k))
  return Number.isFinite(v) && v >= lo && v <= hi ? v : undefined
}
const wakeFx = { spread: _num('spread', 0.02, 1), particles: _num('particles', 10, 2000) }

const el = document.getElementById('root')
if (el) {
  // ⚠️ 沙箱是**开发页**：这里把一个 mock 注入面按生产同样形状喂进去。
  //    类型上的窄化用一次断言表达（而不是 any 满天飞）——它只影响这个页，不碰生产路径。
  // mock 注入面 + 一个占位 `t`（沙箱不发请求、不依赖宿主 locale）；
  // 类型窄化只用**一次**断言表达，⛔ 不让 any 满天飞 —— 它只影响这个开发页。
  const props = { ...injected, t: (k: string): string => k }
  // 用 `react-dom` 本体的 render（`react-dom/client` 会被留成 external ⇒ 双击打不开）
  ReactDOM.render(
    wakePhase
      ? <WakeOverlay phase={wakePhase} onSkip={() => {}} fx={wakeFx} />
      : <MemoryPanel {...(props as unknown as Parameters<typeof MemoryPanel>[0])} />,
    el,
  )
}
