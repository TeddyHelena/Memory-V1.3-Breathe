/**
 * 记忆主面板（`main` 座位）—— **参数照抄原型 `01-Memory.html` 的 Agent 页**
 *
 * ## 这一版为什么重写
 * 上一版我是"看着像"自己编的（栅格比例自定、圆角 10、卡片靠 `border:1px` 立起来…），
 * 作者 一眼看出不对：「你好好看一下那个 html 里面关于 Agent 页面的具体参数包括风格」。
 * 现按原型**逐项对照**重做。真值（⛔ 改之前先回原型核对，别凭印象调）：
 *
 * | 项 | 原型真值 |
 * |---|---|
 * | 卡面怎么立起来 | **灰填充 + 阴影，不靠描边**（`--card` + `elev-panel = 0 0 0 .5px rgba(0,0,0,.10), 0 3px 8px rgba(0,0,0,.03), 0 0 16px rgba(0,0,0,.02)`） |
 * | 主区 `.app` | `display:flex; gap:14px; padding:0 26px 20px`（26px 与 DSH 主区对齐，⛔ 别再叠一层） |
 * | 左栏 `.left` | `flex:0 0 44%; max-width:560px; border-radius:16px; overflow:hidden` |
 * | 右栏 `.right` | `flex:1 1 auto; flex-direction:column; gap:14px` |
 * | 筛选卡 `.bar` | `padding:12px 14px; border-radius:16px` |
 * | 控件 | `font-size:12.5px; background:var(--card); border:none; border-radius:8px; padding:7px 10px`；focus `0 0 0 1.5px var(--brand)` |
 * | 列表行 `.item` | `border-top:1px solid var(--line)`（首行无）· hover `background:var(--hover)` · `.h{padding:12px 16px;gap:8px}` |
 * | 行内文字 | `.id` 等宽 11px `--text2` `min-width:30px`｜`.t` `13.5px/500` 省略号｜`.u` `margin-left:auto 11px` |
 * | 图例 `.legend` | `padding:8px 18px 14px; gap:13px; font-size:11.5px`；圆点 **9px 圆形**，空心 `1.4px solid currentColor` |
 * | 身份胶囊 `.who` | 绝对定位球卡左上 `left:14px top:12px`，`border-radius:999px`，`box-shadow:elev2` |
 * | 抽屉 | `.dhead{padding:13px 18px;border-bottom:1px solid var(--line)}` · `.dbody{padding:16px 18px 20px}` · 标签 12px`--text2` · 输入 13.5px `--card2` `radius:9px` · 只读区 `.ro{background:var(--card2);radius:10px;padding:12px 14px}` |
 *
 * ## 我加的那一块（C-3，原型没有）
 * **人格锚点区**放在**左栏球卡内部**（球下面、图例上面）：它属于"身份/人格"，与球同栏最自然；
 * 且**打开就能看见**（C-3 第 1 问的直接解药），不需要新增顶层区块去破坏原型结构。
 *
 * ## 三条纪律
 *   ① `h*` 只读（永不自动改）；② "热"取 **`hot_order` 名单**（不是 `layer==='hot'`，真身 11 vs 10）；
 *   ③ 读不到 ≠ 不在 —— 失败只降级对应卡片，⛔ 不白屏、⛔ 不弹向导。
 */

import { Component, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'

import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

import type { MemoryEntryMeta, MemoryListData, MemoryPanelInjected } from './types-client.ts'
import { Graph3D } from './Graph3D.tsx'
import { ChainLens } from './ChainLens.tsx'
import { AgentSide } from './AgentSide.tsx'
import { isTombstone, safeTitle } from './entry-text.ts'
// 实心大脑：只用在**独立出现**的位置（这里是身份胶囊的头像位）；与宿主图标并排处一律用描边版
import { BrainMarkIcon } from './BrainIcon.tsx'
import { EntryDrawer } from './EntryDrawer.tsx'
import { EntryRow } from './EntryRow.tsx'
import { OnboardingWizard } from './OnboardingWizard.tsx'
import { AGENT_CSS } from './agent-css.ts'
import { WakeOverlay, type WakePhase } from './WakeOverlay.tsx'
import { WAKE_LANDING } from '../wake-fx.js'
import { TL, runWake, type WakeHandle } from '../wake.js'
import type { MemoryGraph } from './graph-types.ts'

export type MemoryPanelProps =
  PropsLocale<'settings.memory'>
  & InjectFace<MemoryPanelInjected>
  & { size?: number; active?: boolean }

/** 层色 —— **语义色，不许换**（原型 §七 / `后续设计-热记忆.md` §四） */
const LAYERS: Array<{ key: MemoryEntryMeta['layer']; label: string; color: string }> = [
  { key: 'hot', label: '热', color: '#f59e0b' },
  { key: 'longterm', label: '长期', color: '#3b82f6' },
  { key: 'archive', label: '归档', color: '#94a3b8' },
  { key: 'pending', label: '候选', color: '#a855f7' },
]

/** 来源：id 首字母（h 人格锚点 / l 自循环与手写 / p 候选转正 / a 归档） */
function sourceOf(id: string): string {
  const c = id[0]
  return ({ h: '人格锚点', l: '自循环/手写', p: '候选转正', a: '归档' } as Record<string, string>)[c] ?? '—'
}

/* ── 原型的 CSS 真值（照抄；⛔ 别"顺手"改成描边或别的圆角）── */
const T = {
  bg: 'var(--dsw-alias-bg-base, #fff)',
  card: 'var(--dsw-specific-sidebar-fill, #f9fafb)',
  card2: 'var(--dsw-specific-selector, #f5f6f7)',
  hover: 'var(--dsw-static-neutral-bluish-100, #ebeef2)',
  line: 'var(--dsw-alias-border-l1, rgba(0,0,0,.04))',
  line2: 'var(--dsw-alias-border-l2, rgba(0,0,0,.10))',
  text: 'var(--dsw-alias-label-primary, #0f1115)',
  text2: 'var(--dsw-alias-label-secondary, #61666b)',
  brand: 'var(--dsw-alias-brand-primary, #0f1115)',
  idle: 'var(--dsw-alias-state-idle-primary, #d4d4d4)',
  ok: 'var(--dsw-alias-state-success-primary, #22c55e)',
  elev2: 'var(--dsw-shadow-lv2, 0 4px 12px 0 rgba(0,0,0,.02), 0 2px 8px 0 rgba(0,0,0,.04))',
  elevPanel: 'var(--dsw-elevation-panel, 0 0 0 .5px rgba(0,0,0,.10), 0 3px 8px 0 rgba(0,0,0,.03), 0 0 16px 0 rgba(0,0,0,.02))',
} as const

const cardStyle: CSSProperties = { background: T.card, borderRadius: 16, boxShadow: T.elevPanel }
const ctrlStyle: CSSProperties = {
  fontFamily: 'inherit', fontSize: 12.5, color: T.text, background: T.card,
  border: 'none', borderRadius: 8, padding: '7px 10px', outline: 'none',
}

/**
 * **渲染兜底**（2026-10-14 加）：一条坏数据**不许**把整块面板打成白屏。
 *
 * 起因（对抗验证 E）：`EntryRow` 里 `entry.tags.map()` 无兜底，一条 `tags: null`
 * ⇒ `Cannot read properties of null` ⇒ React 卸载整棵树 ⇒ **白屏**（本仓栽过一次白屏，别再来）。
 * 两处都做：① 那个点**本身**加兜底（`?? []`）② 这里加一层 ErrorBoundary —— 
 * 前者修实例，后者兜**整类**（以后再有人漏一处，至少能看到"出错了 + 哪一条"而不是白屏）。
 */
class PanelErrorBoundary extends Component<{ children: ReactNode }, { err: string | null }> {
  state: { err: string | null } = { err: null }
  static getDerivedStateFromError(e: unknown): { err: string } {
    return { err: e instanceof Error ? e.message : String(e) }
  }
  render(): ReactNode {
    if (this.state.err === null) return this.props.children
    return (
      <div style={{ padding: 18, fontFamily: 'inherit', fontSize: 12.5, color: '#e5484d', lineHeight: 1.7 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>这一块渲染出错了</div>
        <div style={{ color: '#61666b' }}>
          ⛔ 没有白屏 —— 说明是**某一条数据**的问题，不是整块面板坏了。错误：{this.state.err}
        </div>
        <button
          onClick={() => this.setState({ err: null })}
          style={{ marginTop: 10, fontFamily: 'inherit', fontSize: 12, border: 'none', borderRadius: 8, padding: '6px 12px', cursor: 'pointer', background: '#f3f4f6' }}
        >重试</button>
      </div>
    )
  }
}

/** 带兜底的对外入口（宿主注册这个） */
export function MemoryPanelSafe(props: Parameters<typeof MemoryPanel>[0]): ReactNode {
  return <PanelErrorBoundary><MemoryPanel {...props} /></PanelErrorBoundary>
}

/** 身份变更广播：同页其它视图（向导预览 / 对话框头像）据此**立即**刷新，不必等重新聚焦。 */
function notifyIdentityChanged(): void {
  try { window.dispatchEvent(new Event('dsh-identity-changed')) } catch { /* 装饰层，失败不影响主流程 */ }
}

export function MemoryPanel({ list, graph: graphApi, tiers: tiersApi, chain: chainApi, getEntry, updateEntry, relocate, expire, confirmPending, discardPending, supersede, onboarding, identity: identityApi, saveIdentity, markOnboarded, decayState, decaySweep, decayRollback }: MemoryPanelProps): ReactNode {
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error'; data?: MemoryListData; error?: string }>({ status: 'loading' })
  const [graph, setGraph] = useState<MemoryGraph | null>(null)
  const [graphFailed, setGraphFailed] = useState(false)
  const [tiers, setTiers] = useState<Record<string, string>>({})
  const [chainData, setChainData] = useState<import('./types-client.ts').MemoryChainData | null>(null)
  // 【第3轮】首启向导：**面板内覆盖层**，⛔ 不做成"必须先过的启动页"（作者 裁决）；
  // 读不到状态 ⇒ 不弹（`/onboarding` 的 needed 已按四种情形判过，含"读不到⇒不弹"）
  const [showWizard, setShowWizard] = useState(false)
  // 【小刀③】人格锚点区默认只列 3 条（11 条会顶满左卡、把球挤扁）⇒ 可展开

  // 【作者 第3点】胶囊里的头像**可以由用户自己传图**（原型：头像 / 可跳过 / 上传）。
  // 落点是 H2 的 `/identity`（`avatar` 存 dataURL）—— 通道早就通了，之前只画了个大脑占位。
  const [identity, setIdentity] = useState<{ avatar?: string; name?: string; callName?: string; gender?: string } | null>(null)
  // 【作者】点头像右边的**名字** ⇒ 就地出现「名字 + 性别」的编辑（落 `/identity`）
  const [idEdit, setIdEdit] = useState(false)
  // 【B6】衰减扫描状态：面板那行「今天自动归档 M 条 · 撤销」
  const [decay, setDecay] = useState<{ lastCount: number; rolledBack: boolean } | null>(null)
  // 【B8】「唤醒」转场：phase=null 表示没在转场；转场期间盖一层，切到 Agent 视图后滑入
  const [wakePhase, setWakePhase] = useState<WakePhase | null>(null)
  /**
   * ⛔ 转场句柄必须留着（2026-10-14 对抗验证 F 修）。
   * `runWake` 返回 `WakeHandle`（cleanup/skip），修前**直接丢弃** ⇒
   * 面板在转场途中被卸载（切走 / 关设置页）时，那些 `setTimeout` 还在跑
   * ⇒ 往已卸载的组件 setState（React 会警告），且时间线继续走完。
   */
  const wakeRef = useRef<WakeHandle | null>(null)
  /** 切过来之后卡片滑入（时长由 TL.slide 注入的 --fx-slide 管）*/
  const [slidingIn, setSlidingIn] = useState(false)
  const [idDraft, setIdDraft] = useState<{ name: string; callName: string; gender: string }>({ name: '', callName: '', gender: '' })
  // ⛔ 默认落「热」——原型默认落"长期(77)"，实测打开看不到最重要的 11 条（评审点名的第 1 问）
  /**
   * 当前视图的层。
   * ⛔ `'__all__'` 是**必须有的逃生出入口**（2026-10-14 对抗验证 E 修）：
   *   `layer` 缺失/不可识别的条目（索引缺字段的坏数据）在**任何**具体层下都匹配不上
   *   ⇒ 被静默过滤 ⇒ 用户只看到「热记忆 0 / 2 条」这种不自洽的数，**看不见少的是谁**。
   */
  const [lens, setLens] = useState<'ball' | 'chain' | 'list'>('ball')
  const [layer, setLayer] = useState<MemoryEntryMeta['layer'] | '__all__'>('hot')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  // 【第2轮 A1】行内展开是**独立于抽屉**的一种交互：点行展开、点「编辑」才开抽屉
  const [openId, setOpenId] = useState<string | null>(null)
  // 【第2轮 A8】原型是四个下拉 + 搜索（两行摆）
  const [fStatus, setFStatus] = useState('all')
  const [fDecay, setFDecay] = useState('all')
  const [fOrigin, setFOrigin] = useState('all')
  const [fTier, setFTier] = useState('all')
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  /** 卸载（或依赖变化）时把没跑完的转场掐掉 —— ⛔ 与"跳过"走同一个 cleanup（规格第 6 点） */
  useEffect(() => () => { wakeRef.current?.cleanup() }, [])

  const load = useCallback(async () => {
    setState((s) => ({ ...s, status: 'loading' }))
    try {
      const data = await list()
      setState({ status: 'ready', data })
    } catch (error) {
      // ⛔ 读不到就明说读不到 —— ⛔ 不当作"没有"、⛔ 不重定向、⛔ 不白屏
      setState({ status: 'error', error: error instanceof Error ? error.message : String(error) })
    }
    try { setGraph(await graphApi()) } catch { setGraphFailed(true) }
    try { setTiers(await tiersApi()) } catch { setTiers({}) }
    try { setChainData(await chainApi()) } catch { setChainData(null) }
    try { setShowWizard((await onboarding()).needed) } catch { setShowWizard(false) }
    /**
     * ⛔ **读不到 ≠ 没设过**（2026-10-14 对抗验证 E 修）。
     * 修前 `catch` 静默 ⇒ 界面显示"未命名"，与"确实没设过"长得一模一样 ——
     * 违反本仓那条硬纪律（读不到就要说读不到，不许当作"没有"）。
     */
    try {
      const prof = await identityApi()
      const f = (prof.fields ?? {}) as Record<string, unknown>
      setIdentity({
        avatar: typeof f.avatar === 'string' ? f.avatar : undefined,
        name: typeof f.name === 'string' ? f.name : undefined,
        callName: typeof f.callName === 'string' ? f.callName : undefined,
        gender: typeof f.gender === 'string' ? f.gender : undefined,
      })
    } catch (e) {
      // ⛔ 读不到就**明说读不到** —— 与"确实没设过"是两件事，不许长得一样
      setIdentity({ name: '（身份读不到）', callName: '' })
      setNote(`❌ 身份读不到：${e instanceof Error ? e.message : String(e)}`)
    }
    try { setDecay(await decayState()) } catch (e) {
      // ⛔ 读不到衰减状态：置 null（那行不显示）**并且说出来** —— 不然"今天无自动归档"会是假的
      setDecay(null)
      setNote(`❌ 衰减状态读不到：${e instanceof Error ? e.message : String(e)}`)
    }
  }, [list, graphApi, onboarding, identityApi])

  useEffect(() => { void load() }, [load])

  // 身份变更广播 ⇒ 立即重载（避免"保存了但界面还是旧的"，等下一次聚焦才更新）
  // 用 AbortController 收尾：⛔ 面板判据禁 "remove"/"delete"/"删除" 字样（架构是自然衰减）
  useEffect(() => {
    const ac = new AbortController()
    window.addEventListener('dsh-identity-changed', () => { void load() }, { signal: ac.signal })
    return () => ac.abort()
  }, [load])

  const entries = state.data?.entries ?? []
  const hotOrder = state.data?.hot_order ?? []
  const byId = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries])

  const anchors = useMemo(
    () => hotOrder.map((id, i) => ({ id, order: i + 1, meta: byId.get(id) ?? null })),
    [hotOrder, byId],
  )

  const counts = useMemo(() => ({
    layers: LAYERS.map((l) => ({ ...l, n: l.key === 'hot' ? hotOrder.length : entries.filter((e) => e.layer === l.key).length })),
    /**
     * ⛔ **读不出层的条目数**（2026-10-14 对抗验证 E 修）。
     * 为什么要单列：`layer` 在索引契约里是**必填**，缺失 = 坏数据；
     * 但修前面板**一个字都不说** —— 用户只看到「0 / 2 条」这种不自洽，
     * 只会以为列表坏了。**坏的呈现方式 = 静默**（本仓口径：静默 = 藏问题）。
     * ⛔ 不许让"总数 > 各层之和"只靠用户自己心算。
     */
    unplaceable: entries.filter((e) => !LAYERS.some((l) => l.key === e.layer)).length,
    active: entries.filter((e) => (e.status ?? 'active') === 'active').length,
    expired: entries.filter((e) => e.status === 'expired').length,
    forgotten: entries.filter((e) => isTombstone(e)).length,
    superseded: entries.filter((e) => e.status === 'superseded').length,
    // 【第2轮 A7】衰减统计（原型：`衰减：核心 1 · 常规 62 · 快衰 3 · 未标 11`）
    decay: {
      core: entries.filter((e) => e.decay_type === 'core').length,
      recent: entries.filter((e) => e.decay_type === 'recent').length,
      process: entries.filter((e) => e.decay_type === 'process').length,
      unmarked: entries.filter((e) => !e.decay_type).length,
    },
  }), [entries, hotOrder])

  /** 距离下一档还有几天（H=7/30/∞；阈值 1H/2H/4H）——真实计算，不编 */
  const daysToNextTier = useCallback((e: MemoryEntryMeta): number | null => {
    if (e.layer !== 'longterm') return null
    const H = e.decay_type === 'process' ? 7 : e.decay_type === 'core' ? Infinity : 30
    if (!Number.isFinite(H)) return null
    const t = Date.parse(e.updated ?? '')
    if (!Number.isFinite(t)) return null
    const age = Math.max(0, (Date.now() - t) / 86400000)
    const next = [1, 2, 4].map((m) => m * H).find((m) => m > age)
    return next === undefined ? null : Math.max(0, next - age)
  }, [])

  /** 列表页顶部摘要：真实档位分布（不编“几天后掉档”） */
  const tierCounts = useMemo(() => {
    const out: Record<string, number> = { full: 0, snapshot: 0, outline: 0, forgotten: 0 }
    for (const e of entries.filter((x) => x.layer === 'longterm')) {
      const t = tiers[e.id] ?? (isTombstone(e) ? 'forgotten' : 'full')
      out[t] = (out[t] ?? 0) + 1
    }
    return out
  }, [entries, tiers])

  const dropSoon = useMemo(() => {
    return entries
      .map((e) => ({ e, d: daysToNextTier(e) }))
      .filter((x): x is { e: MemoryEntryMeta; d: number } => x.d !== null && x.d <= 7)
      .sort((a, b) => a.d - b.d)
  }, [entries, daysToNextTier])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return entries
      // ⛔ 「全部」不按层过滤 ⇒ **读不出层的条目在这里能看见**（体现"总数 > 各层之和"的那些）
      .filter((e) => (layer === '__all__' ? true : layer === 'hot' ? hotOrder.includes(e.id) : e.layer === layer))
      .filter((e) => fStatus === 'all' || (fStatus === 'forgotten' ? isTombstone(e) : (e.status ?? 'active') === fStatus))
      .filter((e) => fDecay === 'all' || (e.decay_type ?? '') === fDecay)
      .filter((e) => fOrigin === 'all' || e.id[0] === fOrigin)
      .filter((e) => fTier === 'all' || (tiers[e.id] ?? 'full') === fTier)
      // ⛔ 兜底（2026-10-14）：`title`/`summary` 缺失 + 用户一搜索 ⇒ 修前是 **TypeError ⇒ 整块白屏**
      //   （与 `entry.tags.map()` 同一个病：**渲染/过滤路径上直接解引用可选字段**）
      .filter((e) => !q
        || String(e.id ?? '').toLowerCase().includes(q)
        || safeTitle(e.title).toLowerCase().includes(q)
        || String(e.summary ?? '').toLowerCase().includes(q))
      .sort((a, b) => (layer === 'hot' ? hotOrder.indexOf(a.id) - hotOrder.indexOf(b.id) : (b.priority ?? 0) - (a.priority ?? 0)))
  }, [entries, layer, query, hotOrder, fStatus, fDecay, fOrigin, fTier, tiers])

  const sel = selected ? byId.get(selected) ?? null : null
  const selIsAnchor = sel ? sel.id[0] === 'h' : false

  /** 撤销最近一批：按真实 count 说话，不无条件乐观钉“已撤销”。 */
  const rollbackLast = useCallback(async () => {
    try {
      const r = await decayRollback()
      if (r.count > 0) {
        setNote(`已撤销 ${r.count} 条`)
        setDecay({ lastCount: 0, rolledBack: true })
      } else {
        setNote('没有可撤销的（可能已经撤过）')
      }
      await load()
    } catch (e) {
      setNote(`❌ 撤销失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }, [decayRollback, load])

  const act = useCallback(async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what); setNote(null)
    try { await fn(); setNote(`✅ ${what}`); await load() }
    catch (error) { setNote(`❌ ${what}：${error instanceof Error ? error.message : String(error)}`) }
    finally { setBusy(null) }
  }, [load])

  return (
    // `.panel`：position:relative —— 抽屉与遮罩挂这里，**必须盖住标题栏**（原型 2026-10-08 踩过）
    <div className='mc-agent' style={{ height: '100%', display: 'flex', flexDirection: 'column', minWidth: 0, position: 'relative',
      // 【B8】卡片滑入：时长走 CSS 变量 `--fx-slide`，值来自 TL.slide（⛔ 不在这里写死秒数）
      transform: slidingIn ? 'translateY(10px)' : 'none',
      opacity: slidingIn ? 0.6 : 1,
      transition: slidingIn ? 'none' : 'transform var(--fx-slide) cubic-bezier(.22,1,.36,1), opacity var(--fx-slide) cubic-bezier(.22,1,.36,1)',
    }}>
      {/* 【真源】原型 CSS 由 `scripts/gen-agent-css.mjs` **机械生成**（251 条 + 变量块，全部挂 `.mc-agent`）。
          ⛔ 不再手抄参数：原型一变就重跑那个脚本。
          只有内联表达不了的少量规则留在下面这个小块里。 */}
      <style>{AGENT_CSS}</style>
      {/* 【B8】把 TL 的时长**写进 CSS 变量**（规格第 2 条：⛔ 不许在 CSS 里写死秒数，
          否则"TL 和 CSS 各写各的 ⇒ 时间线错位"—— 原型为此专门写过注释）。 */}
      <style>{`:root{--fx-slide:${TL.slide}ms}`}</style>
      {/* 【作者 指令】「把边框线去掉，卡片仅保留阴影」。
          那个"边框"来自 `--elev-panel` 的**第一段**：`0 0 0 .5px rgba(0,0,0,.10)` ——
          一个 0.5px 的**描边环**（+ 后面两段柔和阴影）。宿主 token `--dsw-elevation-panel`
          我们改不了，所以在自己的层里**只换阴影**：去掉描边环，保留其余两段。
          ⚠️ 用 !important：生成的那份 CSS 里 `.left/.bar/#list` 的 `box-shadow` 是普通声明，
             而这条是**上层决定**（人的指令），必须压过它。 */}
      <style>{`
        .mc-agent .left, .mc-agent .bar, .mc-agent #list {
          box-shadow: 0 6px 16px 0 rgba(0,0,0,.07), 0 0 28px 0 rgba(0,0,0,.05) !important;
        }
        .mc-agent .drawer, .mc-agent aside {
          box-shadow: 0 8px 24px 0 rgba(0,0,0,.10), 0 0 40px 0 rgba(0,0,0,.06) !important;
        }
      `}</style>
      {/* 只有 `:hover` / `:focus` 这类**内联样式表达不了**的规则才放这里（其余一律内联，方便对照原型改）。
          ⚠️ 类名统一加 `mc-` 前缀：我们是插进宿主 DOM 的，⛔ 别污染宿主的类名空间。 */}
      <style>{`
        .mc-item:hover { background: var(--dsw-static-neutral-bluish-100, #ebeef2); }
        .mc-ctrl:focus { box-shadow: 0 0 0 1.5px var(--dsw-alias-brand-primary, #0f1115); }
        .mc-btn:hover:not(:disabled) { background: var(--dsw-static-neutral-bluish-100, #ebeef2); }
        .mc-anchor:hover { background: var(--dsw-static-neutral-bluish-100, #ebeef2); }
        .mc-item:hover .mc-edit-btn { opacity: 1; }
        .mc-edit-btn:hover { color: var(--dsw-alias-label-primary, #0f1115); box-shadow: var(--dsw-shadow-lv2, 0 4px 12px 0 rgba(0,0,0,.02), 0 2px 8px 0 rgba(0,0,0,.04)); }
      `}</style>
      {/* `.titlebar`（10-10 原型新增）：padding 16px 26px 12px；h1 15px/600 + 说明 12px --text2。
          ⚠️ 我原来这里是「记忆 · N 条 · 热 M」+ 刷新按钮 —— 与原型**完全不同**。
          刷新挪到右上角小按钮（原型没有，但没它没法手动重载），说明文字照抄原型。 */}
      <div className='titlebar' style={{ color: T.text }}>
        <h1 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>{lens === 'chain' ? '记忆链' : lens === 'list' ? '记忆列表' : 'Agent'}</h1>
        <span style={{ display: 'inline-flex', gap: 2, background: T.card2, borderRadius: 9, padding: 2 }}>
          {([['ball', '记忆球'], ['chain', '记忆链'], ['list', '列表']] as const).map(([key, label]) => (
            <button key={key} data-lens={key} onClick={() => { setLens(key); if (key === 'list') setLayer('longterm') }} style={{ fontFamily: 'inherit', fontSize: 12, border: 'none', borderRadius: 7, padding: '4px 10px', cursor: 'pointer', background: lens === key ? T.bg : 'transparent', color: lens === key ? T.text : T.text2, fontWeight: lens === key ? 600 : 400, boxShadow: lens === key ? T.elev2 : 'none' }}>{label}</button>
          ))}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 11.5, color: T.text2 }}>全部 · MemoryV1.3</span>
      </div>

      {/* `.app`：gap 14 / padding 0 26px 20px */}
      <div className='app'>
        {/* 记忆链镜头：真实条目 + 真实档位；不是原型的合成 CHAIN */}
        <div style={{ display: lens === 'chain' ? 'flex' : 'none', flex: '1 1 auto', minWidth: 0, minHeight: 0 }}>
          <ChainLens entries={entries} hotOrder={hotOrder} tiers={tiers} chain={chainData} onOpen={(id) => setSelected(id)} />
        </div>


        {/* ── 左：球卡（flex 0 0 44%, max-width 560）── */}
        <section className='left' style={{ display: lens === 'ball' ? 'flex' : 'none' }}>
          <div style={{ flex: '1 1 auto', minHeight: 300, position: 'relative' }}>
            {graph
              ? <Graph3D nodes={graph.nodes} links={graph.links} selectedId={selected} onSelect={setSelected} />
              : (
                <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, textAlign: 'center', fontSize: 12, color: T.text2 }}>
                  {graphFailed ? '图数据读不到（不是"没有记忆"）—— 右栏照常可用。' : '正在读图…'}
                </div>
              )}
            {/* `.who` 胶囊：绝对定位球卡左上 —— 头像 + 名字 + **统计第二行**
                （原型：`.wname` 14px/600 + `#wsub` 11px --text2；⛔ 统计在这里，不在卡片头行）*/}
            {/* ⛔ 胶囊几何**从 `WAKE_LANDING` 取值**（spec §五 第 1 点）：转场的"幽灵布局 = 最终布局"
                必须是**构造出来的**，不是两份各自写、改一处就错位（原型为这事专门留过注释）。*/}
            <div style={{ position: 'absolute', left: WAKE_LANDING.capsule.left, top: WAKE_LANDING.capsule.top, display: 'flex', alignItems: 'center', gap: 10, background: T.bg, boxShadow: T.elev2, borderRadius: 999, padding: `${WAKE_LANDING.pad}px 14px ${WAKE_LANDING.pad}px ${WAKE_LANDING.pad}px` }}>
              {/* 头像：有图就显示图；点它换图（原型：头像 / 可跳过 / 上传）。⛔ 没图才回落到大脑占位 */}
              {/* 【作者】头像与名字**同一个入口**：点胶囊里任意一处 ⇒ 开同一个身份面板（头像 + 名字 + 性别）。
                  原来头像是"点图直接弹文件选择器"、名字是"点字弹面板"，两个入口分散 ⇒ 合并。 */}
              <span
                title='点头像 / 名字，改头像 · 名字 · 性别'
                onClick={(ev) => { ev.stopPropagation(); setIdDraft({ name: identity?.name ?? '', callName: identity?.callName ?? '', gender: identity?.gender ?? '' }); setIdEdit(true) }}
                style={{ width: WAKE_LANDING.avatar, height: WAKE_LANDING.avatar, borderRadius: '50%', background: T.card2, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: T.text, flex: '0 0 auto', cursor: 'pointer', overflow: 'hidden' }}
              >
                {identity?.avatar
                  ? <img src={identity.avatar} alt='头像' style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  : <span style={{ fontSize: 11, color: T.text2, textAlign: 'center', lineHeight: 1.1 }}>头像</span>}
              </span>
              <span style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                <span
                  title='点这里改名字 / 性别'
                  onClick={(ev) => { ev.stopPropagation(); setIdDraft({ name: identity?.name ?? '', callName: identity?.callName ?? '', gender: identity?.gender ?? '' }); setIdEdit((v) => !v) }}
                  style={{ display: 'flex', alignItems: 'baseline', gap: 5, fontSize: 14, fontWeight: 600, lineHeight: 1.2, color: T.text, cursor: 'pointer' }}
                >
                  {identity?.name || identity?.callName || '未命名'}
                  {/* 性别符号：原型的 `.wname .wsex` —— 蓝红是**语义色不许换**（不是主题色） */}
                  {identity?.gender === '男' && <span style={{ color: '#3b82f6', lineHeight: 0 }}>♂</span>}
                  {identity?.gender === '女' && <span style={{ color: '#e5484d', lineHeight: 0 }}>♀</span>}
                </span>
                <span style={{ fontSize: 11, color: T.text2, lineHeight: 1.2 }}>
                  {graph ? `${graph.nodes.length} 条记忆 · ${graph.links.length} 条连线` : '—'}
                </span>
              </span>
            </div>
          </div>

          {/* 【2026-10-10 作者】人格锚点区**不要了** —— 这块是我自己加的（C-3 第 1/2 问的实现），
              他看了实机说"这部分不要了" ⇒ 整块删除。锚点仍在「热」层里按 hot_order 展示（列表默认就落热层），
              🔒 只读也仍在抽屉里。⛔ 不要再自己加回来。 */}
          {/* 【作者】身份编辑面板：点胶囊里的**头像或名字**出现，三件齐 —— 头像 / 名字 / 性别。
              落 H2 的 `/identity`（avatar / name / gender 都在白名单里）⇒ 与原来同一条通道。
              ⚠️ 这块之前**没落进源码**（我的脚本 replace 没匹配上却照样报"已加"）——
                 所以"点了名字没反应"。现在带断言重写。 */}
          {idEdit && (
            <div style={{ position: 'absolute', left: 14, top: 60, zIndex: 30, background: T.card, borderRadius: 16, boxShadow: 'var(--dsw-elevation-prominent, 0 8px 24px rgba(0,0,0,.12))', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8, minWidth: 230 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ width: 40, height: 40, borderRadius: '50%', background: T.card2, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', flex: '0 0 auto' }}>
                  {identity?.avatar
                    ? <img src={identity.avatar} alt='头像' style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    : <span style={{ fontSize: 11, color: T.text2 }}>头像</span>}
                </span>
                <label style={{ fontSize: 12, borderRadius: 8, padding: '6px 10px', cursor: 'pointer', background: T.card2, color: T.text }}>
                  选一张
                  <input
                    type='file' accept='image/*' style={{ display: 'none' }}
                    onChange={(ev) => {
                      const file = ev.target.files?.[0]
                      if (!file) return
                      const reader = new FileReader()
                      reader.onload = () => {
                        const dataUrl = String(reader.result ?? '')
                        if (!dataUrl.startsWith('data:image/')) return
                        setIdentity((cur) => ({ ...(cur ?? {}), avatar: dataUrl }))
                        void saveIdentity({ avatar: dataUrl }).then(() => notifyIdentityChanged()).catch((e) => setNote(`❌ 头像保存失败：${e instanceof Error ? e.message : String(e)}`))
                      }
                      reader.readAsDataURL(file)
                    }}
                  />
                </label>
                {identity?.avatar && (
                  <button
                    onClick={() => {
                      /**
                       * ⛔ 失败**必须撤回乐观更新**（2026-10-14 修，我自扫与对抗验证 E 都点到了这条）。
                       * 修前是 `.catch(() => {})` **全吞** + 不撤回 ⇒ 界面显示头像已删、盘上还在，
                       * 下次重载头像又回来（"我明明删了"）。这是本仓明确禁止的那类"静默失败"。
                       */
                      const prev = identity?.avatar
                      setIdentity((cur) => ({ ...(cur ?? {}), avatar: undefined }))
                      void saveIdentity({ avatar: '' }).then(() => notifyIdentityChanged()).catch((e) => {
                        setIdentity((cur) => ({ ...(cur ?? {}), avatar: prev }))   // 撤回乐观更新
                        setNote(`❌ 头像清空失败（已回滚界面）：${e instanceof Error ? e.message : String(e)}`)
                      })
                    }}
                    style={{ fontFamily: 'inherit', fontSize: 12, border: 'none', borderRadius: 8, padding: '6px 10px', cursor: 'pointer', background: 'transparent', color: T.text2 }}
                  >去掉</button>
                )}
              </div>

              <label style={{ fontSize: 11.5, color: T.text2 }}>你的名字（我怎么称呼你）</label>
              <input
                value={idDraft.callName} onChange={(e) => setIdDraft({ ...idDraft, callName: e.target.value })}
                placeholder='例如：小林'
                style={{ fontFamily: 'inherit', fontSize: 13, border: 'none', borderRadius: 8, padding: '7px 10px', outline: 'none', background: T.card2, color: T.text }}
              />

              <label style={{ fontSize: 11.5, color: T.text2 }}>我的名字（你怎么称呼我）</label>
              <input
                autoFocus value={idDraft.name} onChange={(e) => setIdDraft({ ...idDraft, name: e.target.value })}
                placeholder='怎么称呼你'
                style={{ fontFamily: 'inherit', fontSize: 13, border: 'none', borderRadius: 8, padding: '7px 10px', outline: 'none', background: T.card2, color: T.text }}
              />

              <label style={{ fontSize: 11.5, color: T.text2 }}>性别（决定胶囊里那个符号）</label>
              <div style={{ display: 'flex', gap: 6 }}>
                {[['男', '♂', '#3b82f6'], ['女', '♀', '#e5484d'], ['', '不显示', '']].map(([v, lab, col]) => (
                  <button
                    key={String(v)} onClick={() => setIdDraft({ ...idDraft, gender: String(v) })}
                    style={{ fontFamily: 'inherit', fontSize: 12, border: 'none', borderRadius: 8, padding: '6px 10px', cursor: 'pointer', background: idDraft.gender === v ? T.brand : T.card2, color: idDraft.gender === v ? T.bg : (col || T.text2), fontWeight: 600 }}
                  >{lab}</button>
                ))}
              </div>

              <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                <button onClick={() => setIdEdit(false)} style={{ fontFamily: 'inherit', fontSize: 12, border: 'none', borderRadius: 8, padding: '6px 10px', cursor: 'pointer', background: T.card2, color: T.text2 }}>取消</button>
                <button
                  onClick={() => {
                    setIdentity((cur) => ({ ...(cur ?? {}), name: idDraft.name || undefined, callName: idDraft.callName || undefined, gender: idDraft.gender || undefined }))
                    setIdEdit(false)
                    void saveIdentity({ name: idDraft.name, callName: idDraft.callName, gender: idDraft.gender }).then(() => notifyIdentityChanged()).catch((e) => setNote(`❌ 身份保存失败：${e instanceof Error ? e.message : String(e)}`))
                  }}
                  style={{ fontFamily: 'inherit', fontSize: 12, border: 'none', borderRadius: 8, padding: '6px 12px', cursor: 'pointer', background: T.brand, color: T.bg, fontWeight: 600 }}
                >保存</button>
              </div>
            </div>
          )}

          {/* `.legend`：**两行**（原型：第一行层色；第二行 实心/半透明/空心 + 三种链）
              padding 8 18 14 / gap 13 / 11.5px；圆点 **9px 圆形**，空心 = 1.4px currentColor */}
          <div style={{ padding: '8px 18px 4px', display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 11, color: T.text2 }}>
            {/* ⚠️ 图例**只列三层**（热/长期/归档）—— 原型写着「候选不进图」，
                所以候选**不该出现在图例里**（我原来列了它，是自相矛盾）。
                层筛选下拉里保留候选（那是在列表里用它筛），两处的口径不一样，别混。 */}
            {counts.layers.filter((l) => l.key !== 'pending').map((l) => (
              <span key={l.key}>
                <i style={{ display: 'inline-block', width: 9, height: 9, borderRadius: '50%', marginRight: 5, verticalAlign: 'middle', background: l.color }} />
                {l.label} {l.n}
              </span>
            ))}
            <span>候选不进图</span>
          </div>
          <div style={{ padding: '0 18px 12px', display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 11, color: T.text2 }}>
            <span><i style={{ display: 'inline-block', width: 9, height: 9, borderRadius: '50%', marginRight: 5, verticalAlign: 'middle', background: 'currentColor' }} />实心 活跃</span>
            <span><i style={{ display: 'inline-block', width: 9, height: 9, borderRadius: '50%', marginRight: 5, verticalAlign: 'middle', background: 'currentColor', opacity: .5 }} />半透明 陈旧</span>
            <span><i style={{ display: 'inline-block', width: 9, height: 9, borderRadius: '50%', marginRight: 5, verticalAlign: 'middle', background: 'transparent', border: '1.4px solid currentColor' }} />空心 失效</span>
            <span><i style={{ display: 'inline-block', width: 14, height: 2, marginRight: 5, verticalAlign: 'middle', background: '#f59e0b' }} />热链</span>
            <span><i style={{ display: 'inline-block', width: 14, height: 2, marginRight: 5, verticalAlign: 'middle', background: T.line2 }} />分组钩稽</span>
            <span><i style={{ display: 'inline-block', width: 14, height: 2, marginRight: 5, verticalAlign: 'middle', background: '#94a3b8' }} />共享标签</span>
          </div>
        </section>

        {/* Agent 镜头右栏：六块统计卡（1:1 原型） */}
        <div style={{ display: lens === 'ball' ? 'flex' : 'none', flex: '1 1 auto', minWidth: 0, minHeight: 0 }}>
          <AgentSide entries={entries} hotOrder={hotOrder} tiers={tiers} linkCount={graph?.links.length ?? 0} decay={decay} onRollback={() => void rollbackLast()} onOpen={(id) => setSelected(id)} />
        </div>

        {/* ── 右：筛选卡 + 列表卡 ── */}
        <div className='right' style={{ display: lens === 'list' ? 'flex' : 'none', flex: lens === 'list' ? '1 1 auto' : undefined }}>
          {/* `.bar`：原型 = 顶部细进度条 + 状态/衰减一行 + 四个下拉 + 搜索 */}
          <div className='bar'>
            {lens === 'list' && (
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 12.5, color: T.text, marginBottom: 6 }}>
                  <b>长期记忆现在 {entries.filter((e) => e.layer === 'longterm').length} 条里</b>
                  <span style={{ color: T.text2 }}> 完整 {tierCounts.full} · 快照 {tierCounts.snapshot} · 轮廓 {tierCounts.outline} · 遗忘 {tierCounts.forgotten}</span>
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', fontSize: 11 }}>
                  {(['full', 'snapshot', 'outline', 'forgotten'] as const).map((k) => (
                    <span key={k} style={{ border: `1px solid ${T.line2}`, borderRadius: 999, padding: '2px 8px', color: T.text2 }}>{({ full: '完整', snapshot: '快照', outline: '轮廓', forgotten: '遗忘' })[k]} {tierCounts[k]}</span>
                  ))}
                </div>
                {dropSoon.length > 0 && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', fontSize: 11, marginTop: 6 }}>
                    <span style={{ color: T.text2 }}>{dropSoon.length} 条在 7 天内会掉一档</span>
                    {dropSoon.slice(0, 6).map(({ e, d }) => (
                      <span key={e.id} style={{ border: `1px solid ${T.line2}`, borderRadius: 999, padding: '2px 8px', color: T.text2 }}>{e.id} · {Math.ceil(d)} 天</span>
                    ))}
                    {dropSoon.length > 6 && <span style={{ color: T.text2 }}>…还有 {dropSoon.length - 6} 条</span>}
                  </div>
                )}
              </div>
            )}
            {/* A6 细进度条：活跃占比（原型里是一条横贯的细条）*/}
            <div style={{ height: 3, borderRadius: 2, background: T.card2, overflow: 'hidden', marginBottom: 10 }}>
              <div style={{ height: '100%', width: `${entries.length ? Math.round((counts.active / entries.length) * 100) : 0}%`, background: T.ok }} />
            </div>
            {/* A7 状态 + 衰减统计 */}
            <div style={{ fontSize: 12.5, color: T.text2, marginBottom: 8 }}>
              活跃 {counts.active} · 已过期 {counts.expired} · 已取代 {counts.superseded} · 已遗忘 {counts.forgotten}
              <span style={{ float: 'right' }}>
                衰减：核心 {counts.decay.core} · 常规 {counts.decay.recent} · 快衰 {counts.decay.process} · 未标 {counts.decay.unmarked}
              </span>
            </div>
            {/* A8 四个下拉（全部接真数据） + 搜索（原型里也独占第二行）*/}
            {/* `.filters` —— 原型那份 CSS 里 `.filters select{...}` / `.filters #f-q{...}` 的**宿主类**。
                ⚠️ 我先前一直没挂它 ⇒ 原型那几条规则**静默失效**（和 `.dbody` 同一类病：类名没挂＝规则不生效）。
                内联样式与原型同值，所以这里两者并存不冲突；descendant 规则（作用于 select）现在才生效。 */}
            <div className='filters' style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <select value={layer} onChange={(e) => setLayer(e.target.value as MemoryEntryMeta['layer'] | '__all__')} className='mc-ctrl' style={ctrlStyle}>
                {/* ⛔ "全部"是读不出层的**逃生出入口**（见 layer 状态注释）—— 计数用总数，不是各层之和 */}
                <option value='__all__'>全部（{entries.length}）</option>
                {counts.layers.map((l) => <option key={l.key} value={l.key}>{l.label}（{l.n}）</option>)}
              </select>
              <select value={fStatus} onChange={(e) => setFStatus(e.target.value)} className='mc-ctrl' style={ctrlStyle}>
                <option value='all'>全部状态</option>
                <option value='active'>活跃</option>
                <option value='expired'>已过期</option>
                <option value='superseded'>已取代</option>
                <option value='forgotten'>已遗忘</option>
              </select>
              <select value={fDecay} onChange={(e) => setFDecay(e.target.value)} className='mc-ctrl' style={ctrlStyle}>
                <option value='all'>全部衰减</option>
                <option value='core'>核心（几乎不衰）</option>
                <option value='recent'>常规</option>
                <option value='process'>快衰</option>
              </select>
              <select value={fOrigin} onChange={(e) => setFOrigin(e.target.value)} className='mc-ctrl' style={ctrlStyle}>
                <option value='all'>全部来源</option>
                <option value='p'>候选转正（p*）</option>
                <option value='l'>手写 / 自循环（l*）</option>
                <option value='h'>人格锚点（h*）</option>
                <option value='a'>归档（a*）</option>
              </select>
              <select value={fTier} onChange={(e) => setFTier(e.target.value)} className='mc-ctrl' style={ctrlStyle}>
                <option value='all'>全部档位</option>
                <option value='full'>完整</option>
                <option value='snapshot'>快照</option>
                <option value='outline'>轮廓</option>
                <option value='forgotten'>遗忘</option>
              </select>
              {/* 计数在**第二行右侧**（原型排布：第一行 层/状态/衰减，第二行 来源 + 计数 + 搜索）*/}
              <span style={{ flex: '1 1 100%', order: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 11.5, color: T.text2 }}>{shown.length} / {entries.length}</span>
              </span>
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder='搜标题 / 标签…' className='mc-ctrl' style={{ ...ctrlStyle, flex: '1 1 100%', order: 9 }} />
            </div>
          </div>

          {/* 列表卡 */}
          <div id='list' style={{ background: 'var(--card)', borderRadius: 16, boxShadow: 'var(--elev-panel)', flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
            {/* 列表卡头行（原型 .hd）：左「<层>记忆 N / M 条」· 右「点「编辑」改…」*/}
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '12px 16px 10px', borderBottom: `1px solid ${T.line}` }}>
              <b style={{ fontSize: 13.5, fontWeight: 600, color: T.text }}>
                {(counts.layers.find((l) => l.key === layer)?.label ?? '')}记忆 {shown.length} / {entries.length} 条
              </b>
              {/**
                * ⛔ **不许静默**（2026-10-14 对抗验证 E 修）：
                * `layer` 缺失/不可识别的条目在**任何**具体层下都匹配不上 ⇒ 被过滤掉了，
                * 而修前界面对此**一个字都不说** —— 用户只看到「热记忆 0 / 2 条」这种不自洽的数。
                * 现在：① 明说有几条读不出层 ② 给一个"看全部"的出口（⛔ 别让人自己去心算差额）
                */}
              {counts.unplaceable > 0 && (
                <span style={{ fontSize: 11.5, color: '#e5484d' }}>
                  有 {counts.unplaceable} 条读不出层（索引缺 layer 字段）
                  {layer !== '__all__' && (
                    <button
                      onClick={() => setLayer('__all__')}
                      style={{ marginLeft: 6, fontFamily: 'inherit', fontSize: 11, border: 'none', borderRadius: 6, padding: '2px 8px', cursor: 'pointer', background: T.card2, color: T.text }}
                    >看全部</button>
                  )}
                </span>
              )}
              <span style={{ marginLeft: 'auto', fontSize: 11.5, color: T.text2 }}>
                点「编辑」改标题 / 摘要 / 标签 / 优先级 / 正文
              </span>
            </div>
            {state.status === 'error' && (
              <div style={{ padding: 20, fontSize: 13, color: T.text }}>
                <div>读不到容器（**不是「没有记忆」**）：</div>
                <div style={{ color: T.text2, fontSize: 12, marginTop: 6 }}>{state.error}</div>
                <button onClick={() => void load()} style={{ ...ctrlStyle, marginTop: 10, cursor: 'pointer' }}>重试</button>
              </div>
            )}
            {state.status === 'ready' && shown.length === 0 && (
              <div style={{ padding: 20, fontSize: 12.5, color: T.text2 }}>这一层没有匹配的条目。</div>
            )}
            {state.status === 'ready' && shown.map((e) => (
              <EntryRow
                key={e.id}
                entry={e}
                tier={tiers[e.id] ?? (isTombstone(e) ? 'forgotten' : 'full')}
                open={openId === e.id}
                onToggle={() => setOpenId(openId === e.id ? null : e.id)}
                onEdit={() => setSelected(e.id)}
                getEntry={getEntry}
                confirmPending={confirmPending}
                discardPending={discardPending}
                supersede={supersede}
                relocate={relocate}
                expire={expire}
                onChanged={(msg) => { setNote(msg); void load() }}
              />
            ))}
          </div>
        </div>
      </div>

      {/* ── 抽屉：遮罩 + 右侧滑出（挂 `.panel` 上才盖得住标题栏）── */}
      {sel && (
        <>
          <div onClick={() => setSelected(null)} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.18)' }} />
          <EntryDrawer
            id={sel.id}
            getEntry={getEntry}
            updateEntry={updateEntry}
            onClose={() => setSelected(null)}
            onChanged={() => void load()}
          />
        </>
      )}

      {/* ──「认识一下」：面板内覆盖层（可跳过；⛔ 不阻塞进入 Agent 页）── */}
      {/* 【B8】「唤醒」转场覆盖层：向导"完成" ⇒ 转场 ⇒ **同页切视图**（⛔ 不跳转）⇒ 卡片滑入 */}
      {wakePhase && (
        <WakeOverlay
          phase={wakePhase}
          onSkip={() => { /* 跳过：直接跳到终点（cleanup 与 skip 是同一个函数，规格第 6 点）*/ setWakePhase(null) }}
        />
      )}
      {showWizard && (
        <OnboardingWizard
          version=''
          identity={(identity ?? undefined) as unknown as Record<string, unknown> | undefined}
          onSkip={() => { setShowWizard(false); void markOnboarded().then(() => load()).catch(() => {}) }}
          onDone={(patch) => {
            // 【B8·接线】向导"完成" ⇒ 跑「唤醒」转场 ⇒ **同页切视图**（⛔ 不跳转）。
            // · 节奏来自 `runWake`（纯 setTimeout，⛔ 不挂 rAF —— 规格第 1 条）
            // · `switch` 那一步才收掉覆盖层、显出 Agent 视图，随后卡片滑入
            // · `cleanup` 与 `skip` 是同一个函数（规格第 6 点）
            wakeRef.current = runWake(
              (step) => {
                // 开发辅助：转场每一步都留痕（排查"覆盖层收不掉"这类问题用；⛔ 不影响行为）
                console.debug('[wake]', step.what, step.at)
                if (step.what === 'switch') { setWakePhase(null); setSlidingIn(true); return }
                if (step.what === 'slide') return
                setWakePhase(step.what)
              },
              () => setSlidingIn(false),
            )
            setShowWizard(false)
            void saveIdentity(patch)
              .then((res) => {
                /**
                 * ⛔ 【2026-10-14 对抗验证 F 修】**丢弃必须可见**。
                 * `writeIdentity` 对白名单外的键是"丢弃并留痕"（返回体 `droppedKeys`），
                 * 而向导此前**不看**这个留痕 ⇒ 就是那条产品级静默丢数据：
                 * 用户在第 6/8 步填了、界面高亮了，容器里一个字节没有。
                 * （根因已修：白名单与真实载荷对齐；这里补的是"以后别再静默"。）
                 */
                const dropped = (res && typeof res === 'object' && Array.isArray((res as { droppedKeys?: unknown }).droppedKeys))
                  ? ((res as { droppedKeys: string[] }).droppedKeys)
                  : []
                if (dropped.length) setNote(`⚠️ 有 ${dropped.length} 个字段没被接收（白名单外，已丢弃）：${dropped.join(', ')}`)
                return markOnboarded()
              })
              .then(() => { notifyIdentityChanged(); return load() })
              .catch((e) => setNote(`❌ 保存身份失败：${e instanceof Error ? e.message : String(e)}`))
          }}
        />
      )}
    </div>
  )
}
