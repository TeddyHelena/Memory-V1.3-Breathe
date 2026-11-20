/**
 * 列表的一行（`#list .item`）—— 逐项照原型 `01-Memory.html`
 *
 * ## 三种交互（原型里是分开的，⛔ 别混）
 *   ① **点行** → **行内展开**（`.item.open .detail`）：解释三行 + 正文预览 + 动作按钮行；
 *   ② **点「编辑」** → 开**抽屉**（`#drawer`，见 `EntryDrawer.tsx`）；
 *   ③ 行 hover → 「编辑」按钮显形（展开时常显）。
 *   ⚠️ 我第一版只做了"点行开抽屉" —— 少了一整套交互（第 1 轮对照 A1）。
 *
 * ## 行内展开里有什么（第 1 轮对照 A2/A3/A4）
 *   · **元信息三行**：`来源指针` / `这条从哪来` / `读取效果`
 *     —— 这三行是**可解释性**：用户能看出"它为什么会被检索到 / 为什么不会"；
 *   · **正文预览** `.mdbox`（比抽屉矮一档，max-height 260）；
 *   · **动作按钮行**：标记过期 / 取代 / 升 hot / 降归档
 *     —— 原型上写着「需要新写通道 · 未开工」，**我们现在四个通道都有了**（C-0），所以直接兑现。
 *
 * ## chip 行（A5）
 *   状态（活跃=绿）· 衰减（核心/常规/快衰/未标）· 来源 · **全部标签** —— 原型里每行都有一整行。
 */

import { useCallback, useState, type CSSProperties, type ReactNode } from 'react'

import type { MemoryEntryDetail, MemoryEntryMeta, MemoryPanelInjected } from './types-client.ts'
import { renderMarkdown } from './markdown.ts'
import { displayTitle, isTombstone, safeTitle } from './entry-text.ts'

/** Breathe 衰减曲线（真实：用 updated + decay_type 算 state；不编趋势） */
function Sparkline({ entry }: { entry: MemoryEntryMeta }): ReactNode {
  const updated = Date.parse(entry.updated ?? '')
  const age = Number.isFinite(updated) ? Math.max(0, (Date.now() - updated) / 86400000) : 0
  const H = entry.decay_type === 'process' ? 7 : entry.decay_type === 'core' ? Infinity : 30
  const state = Number.isFinite(H) ? Math.pow(2, -age / H) : 1
  const W = 150, Hh = 30, pad = 2
  const sx = (d: number) => pad + (W - pad * 2) * (d / Math.max(1, H))
  const sy = (v: number) => pad + (Hh - pad * 2) * (1 - v)
  const pts: string[] = []
  const span = Number.isFinite(H) ? H * 1.15 : Math.max(age * 1.2, 30)
  for (let i = 0; i <= 32; i++) { const d = span * i / 32; pts.push(`${sx(d).toFixed(1)},${sy(Number.isFinite(H) ? Math.pow(2, -d / H) : 1).toFixed(1)}`) }
  return (
    <svg width={W} height={Hh} viewBox={`0 0 ${W} ${Hh}`} style={{ display: 'block' }} aria-hidden>
      {[0.5, 0.25, 0.0625].map((v) => <line key={v} x1={pad} y1={sy(v)} x2={W - pad} y2={sy(v)} stroke="#c7cede" strokeWidth=".8" strokeDasharray="2 3" />)}
      <polyline points={pts.join(' ')} fill="none" stroke="#3b82f6" strokeWidth="1.5" />
      <line x1={sx(age)} y1={pad} x2={sx(age)} y2={Hh - pad} stroke="#0f1115" strokeWidth=".8" strokeDasharray="2 2" opacity=".35" />
      <circle cx={sx(age)} cy={sy(state)} r="3" fill="#0f1115" />
    </svg>
  )
}

export interface EntryRowProps {
  entry: MemoryEntryMeta
  /** Breathe 真实档位（服务端未启用时 undefined ⇒ 不显示） */
  tier?: string
  /** 是否展开（行内） */
  open: boolean
  onToggle: () => void
  /** 点「编辑」→ 开抽屉 */
  onEdit: () => void
  getEntry: (id: string) => Promise<MemoryEntryDetail>
  relocate: MemoryPanelInjected['relocate']
  expire: MemoryPanelInjected['expire']
  /** 【对账抓到的缺口】候选层：转正 / 丢掉 —— 通道一直有，但组件里从没有调用点 */
  confirmPending: MemoryPanelInjected['confirmPending']
  discardPending: MemoryPanelInjected['discardPending']
  /** 【同】取代：原来按钮是 disabled（要挑"被谁取代"）⇒ 等于没入口；现在给就地输入 */
  supersede: MemoryPanelInjected['supersede']
  /** 动完通知外面重载 */
  onChanged: (note: string) => void
}

const T = {
  bg: 'var(--dsw-alias-bg-base, #fff)',
  card: 'var(--dsw-specific-sidebar-fill, #f9fafb)',
  card2: 'var(--dsw-specific-selector, #f5f6f7)',
  line: 'var(--dsw-alias-border-l1, rgba(0,0,0,.04))',
  line2: 'var(--dsw-alias-border-l2, rgba(0,0,0,.10))',
  text: 'var(--dsw-alias-label-primary, #0f1115)',
  text2: 'var(--dsw-alias-label-secondary, #61666b)',
  ok: 'var(--dsw-alias-state-success-primary, #22c55e)',
} as const

/** 来源：id 首字母（与 host 的 id 分段一致） */
const SOURCE_LABEL: Record<string, string> = {
  h: '人格锚点', l: '手写 / 自循环', p: '候选转正', a: '归档',
}
/** 来源解释（"这条从哪来"）—— 原型里就是这么写给人看的 */
function originExplain(id: string): string {
  switch (id[0]) {
    case 'p': return '经**候选区**转正 —— 先被推断出来、再由人确认，才进这里'
    case 'l': return '直接写入或自循环产出 —— **没有经过候选区**'
    case 'h': return '人工维护的**人格锚点** —— 永不自动覆盖，只能手改文件'
    case 'a': return '已归档 —— 不进动态召回，只在归档层可查'
    default: return '来源未标注'
  }
}
const DECAY_LABEL: Record<string, string> = { core: '核心', recent: '常规', process: '快衰' }

/**
 * 读取效果：一句话说清"它参不参与检索"（可解释性那三行的第三行）。
 *
 * ⛔ **判据必须是 `temporal_state`，不是 `status`**（2026-10-14 对抗验证 E 修）。
 *
 * 修前这里按 `status` 判 —— 而**引擎不按它判**：引擎用 `temporalState(valid_to ?? expires)`，
 * 到期只看 `expires`。`/list` **本来就返回 `temporal_state`**，面板却没用它。
 * 实测后果（真身 `a36`）：`status=active` 但 `expires=2026-09-25`（已过 19 天），
 * 引擎 `isInjectable=false`（不注入、不检索），而面板画的是
 * **「活跃 · 正常参与检索」** —— 界面在替引擎撒谎。
 * ⇒ 现在：① 以 `temporal_state` 为准 ② 两个口径**不一致就明说**（那是真身里真实存在的状态，
 *    藏起来比说错更坏）。
 */
function readEffect(e: MemoryEntryMeta): string {
  if (e.layer === 'pending') return '候选区 —— **不进图、不参与检索**'
  const ts = e.temporal_state
  const byStatus = e.status ?? 'active'
  // ① 引擎口径优先
  if (ts === 'expired') return '已过期 —— 到期（expires）起不再注入**也不再被检索**'
  if (ts === 'superseded') return '已被取代 —— 由新条目接管，不再注入'
  if (ts === 'future') return '还没生效（生效时刻在未来）—— 现在不注入'
  if (ts === 'stale') return '过期陈旧 —— 仍在检索面，但排更后'
  // ② 两口径打架：**明说**，别挑一个好看的
  if (ts === 'active' && (byStatus === 'expired' || byStatus === 'superseded')) {
    return `⚠️ **两个口径不一致**：状态标记是「${byStatus}」，但引擎按 expires 判仍然**在注入** —— 以引擎为准`
  }
  if (e.visible_in_current_scope === false) return '不在当前作用域 —— 本工作区看不到'
  return '正常参与检索'
}

const chip: CSSProperties = {
  fontSize: 10.5, lineHeight: 1.6, padding: '1px 8px', borderRadius: 999,
  background: 'var(--dsw-alias-bg-base, #fff)', color: 'var(--dsw-alias-label-secondary, #61666b)',
  whiteSpace: 'nowrap',
}

export function EntryRow({ entry, tier, open, onToggle, onEdit, getEntry, relocate, expire, confirmPending, discardPending, supersede, onChanged }: EntryRowProps): ReactNode {
  const [detail, setDetail] = useState<MemoryEntryDetail | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  /** 取代：就地输入的「由谁取代」（null = 不在输入态）*/
  const [supBy, setSupBy] = useState<string | null>(null)
  const isAnchor = entry.id[0] === 'h'
  const tombstone = isTombstone(entry)
  const shownTitle = displayTitle(entry)

  const ensureDetail = useCallback(async () => {
    if (detail) return
    try { setDetail(await getEntry(entry.id)) } catch { /* 读不到就只显示元信息，⛔ 不炸整行 */ }
  }, [detail, getEntry, entry.id])

  const act = useCallback(async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what)
    try { await fn(); onChanged(`✅ ${entry.id} ${what}`) }
    catch (e) { onChanged(`❌ ${entry.id} ${what}：${e instanceof Error ? e.message : String(e)}`) }
    finally { setBusy(null) }
  }, [entry.id, onChanged])

  // 【作者 口径】陈旧 = 超过半衰期 ⇒ fresh < 0.5；图例那句「半透明 陈旧」现在有实现了
  const stale = typeof entry.fresh === 'number' && entry.fresh < 0.5

  return (
    // ⚠️ 外层必须是原型类名 `.item` —— `.h/.id/.t/.u` 都是 `.item` 的后代选择器，
    //    我第一版留着旧的 `mc-item`，于是那几个类**一条规则都没匹配上**（截图里整行挤成一坨）。
    <div className='item' data-id={entry.id} style={{ position: 'relative', ...(stale ? { opacity: 0.55 } : {}) }} title={stale ? '陈旧（超过半衰期没被访问）' : undefined}>
      {/* ── 行头：**原型的类名**（`.item > .h > .id/.t/.u/.editbtn`）──
          ⛔ 不再内联手抄样式：值由 `agent-css.ts`（机械生成）提供 */}
      <div
        className='h'
        onClick={() => { onToggle(); if (!open) void ensureDetail() }}
      >
        <span className='id'>{entry.id}</span>
        <span className='t'>{shownTitle}</span>
        <span className='u'>{entry.updated}</span>
        <button className='editbtn' onClick={(ev) => { ev.stopPropagation(); onEdit() }}>编辑</button>
      </div>

      {/* ── chip 行：原型的 `.tags > .bg`（状态/衰减/来源各带修饰符）──
          ⚠️ 我第一版把这些 chip 的样式内联手抄、还写成了白底 ⇒ 白卡上看不见。
          原型这里是 `.bg` + `.st-<状态>` / `.dc-<衰减>` / `.origin`，**规则已在生成物里**。 */}
      <div className='tags'>
        <span className={`bg st-${tombstone ? 'expired' : (entry.status ?? 'active')}`} title={tombstone ? '已遗忘（内容已删除）' : (entry.status ?? 'active')}>
          {tombstone ? '已遗忘' : (({ active: '活跃', expired: '已过期', superseded: '已取代' } as Record<string, string>)[entry.status ?? 'active'] ?? entry.status)}
        </span>
        <span className={`bg${entry.decay_type ? ` dc-${entry.decay_type}` : ''}`} title={entry.decay_type ?? '未标'}>
          {DECAY_LABEL[entry.decay_type ?? ''] ?? '未标衰减'}
        </span>
        <span className='bg origin'>{SOURCE_LABEL[entry.id[0] ?? ''] ?? '—'}</span>
        {tier && <span className='bg' title='Breathe 档位'>{({ full: '完整', snapshot: '快照', outline: '轮廓', forgotten: '遗忘' } as Record<string, string>)[tier] ?? tier}</span>}
        {/* ⛔ 兜底：`tags` 可能是 null / 缺字段（真身出现过）——
            修前这里裸 `.map()` ⇒ **一条坏数据让整块面板白屏**（且没有 ErrorBoundary 接住）。
            本仓栽过白屏，别再来一次。 */}
        {(entry.tags ?? []).map((tg) => <span key={tg} className='bg'>{tg}</span>)}
      </div>

      <div className="spark" style={{ position: 'absolute', right: 16, top: 44, opacity: .55, pointerEvents: 'none' }}><Sparkline entry={entry} /></div>

      {/* ── 行内展开（A1）── */}
      {open && (
        <div style={{ margin: '0 16px 14px 54px' }}>
          {/* A2 可解释三行 */}
          <div style={{ display: 'grid', gridTemplateColumns: '66px 1fr', gap: '6px 9px', fontSize: 12, color: T.text2, marginBottom: 12 }}>
            <b style={{ color: T.text, fontWeight: 600 }}>来源指针</b>
            <span>{SOURCE_LABEL[entry.id[0] ?? ''] ?? '—'}{entry.source ? ` · ${entry.source}` : ''}</span>
            <b style={{ color: T.text, fontWeight: 600 }}>这条从哪来</b>
            <span>{originExplain(entry.id)}</span>
            <b style={{ color: T.text, fontWeight: 600 }}>读取效果</b>
            <span>{tombstone ? '已遗忘 —— 内容已删除，只剩一条记录' : readEffect(entry)}</span>
          </div>

          {/* A3 正文预览：比抽屉矮一档（max-height 260）*/}
          <div style={{ background: T.card2, borderRadius: 9, padding: '12px 14px', maxHeight: 260, overflow: 'auto', fontSize: 12.5, lineHeight: 1.7, color: T.text }}>
            {detail
              ? <div dangerouslySetInnerHTML={{ __html: renderMarkdown(detail.content) }} />
              : <span style={{ color: T.text2 }}>正在读正文…</span>}
          </div>

          {/* A4 动作行：原型标"未开工"，我们已有通道 ⇒ 兑现 */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
            {busy && <span style={{ fontSize: 11.5, color: T.text2 }}>{busy}…</span>}
            <button disabled={!!busy || entry.status === 'expired'}
              onClick={() => void act('标记过期', () => expire(entry.id, new Date().toISOString().slice(0, 10)))}
              style={{ fontFamily: 'inherit', fontSize: 12, padding: '4px 11px', borderRadius: 7, border: 'none', background: T.card, color: T.text, cursor: 'pointer' }}>
              标记过期
            </button>
            {/* 取代：链必须留痕 ⇒ 就地输一个"由谁取代"的 id（不假装能做，也不踢去 CLI）*/}
            {supBy === null ? (
              <button disabled={!!busy || entry.status !== 'active'}
                title='取代要先指定「被谁取代」—— 取代链必须留痕'
                onClick={() => setSupBy('')}
                style={{ fontFamily: 'inherit', fontSize: 12, padding: '4px 11px', borderRadius: 7, border: 'none', background: T.card, color: entry.status === 'active' ? T.text : T.text2, cursor: entry.status === 'active' ? 'pointer' : 'not-allowed', opacity: entry.status === 'active' ? 1 : .5 }}>
                取代…
              </button>
            ) : (
              <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
                <span style={{ fontSize: 11.5, color: T.text2 }}>由</span>
                <input autoFocus value={supBy} onChange={(ev) => setSupBy(ev.target.value)} placeholder='新条目 id（如 h03）'
                  style={{ fontFamily: 'inherit', fontSize: 12, border: 'none', borderRadius: 7, padding: '4px 8px', width: 150, background: T.card2, color: T.text, outline: 'none' }} />
                <button disabled={!supBy.trim() || !!busy}
                  onClick={() => void act('取代', () => supersede(entry.id, supBy.trim(), '行内取代'))}
                  style={{ fontFamily: 'inherit', fontSize: 12, padding: '4px 10px', borderRadius: 7, border: 'none', background: T.text, color: T.bg, fontWeight: 600, cursor: 'pointer' }}>
                  确定
                </button>
                <button onClick={() => setSupBy(null)}
                  style={{ fontFamily: 'inherit', fontSize: 12, padding: '4px 8px', borderRadius: 7, border: 'none', background: 'transparent', color: T.text2, cursor: 'pointer' }}>
                  取消
                </button>
              </span>
            )}
            <button disabled={!!busy || entry.layer === 'hot' || isAnchor}
              onClick={() => void act('升 hot', () => relocate(entry.id, 'hot', '行内升 hot'))}
              style={{ fontFamily: 'inherit', fontSize: 12, padding: '4px 11px', borderRadius: 7, border: 'none', background: T.card, color: isAnchor ? T.text2 : T.text, cursor: isAnchor ? 'not-allowed' : 'pointer', opacity: isAnchor ? .5 : 1 }}>
              升 hot
            </button>
            <button disabled={!!busy || entry.layer === 'archive'}
              onClick={() => void act('降归档', () => relocate(entry.id, 'archive', '行内降归档'))}
              style={{ fontFamily: 'inherit', fontSize: 12, padding: '4px 11px', borderRadius: 7, border: 'none', background: T.card, color: T.text, cursor: 'pointer' }}>
              降归档
            </button>
            {/* 候选层：转正 / 丢掉 —— 两个通道一直有，**界面上从来没有入口**（对账脚本抓到的） */}
            {entry.layer === 'pending' && (
              <>
                <button disabled={!!busy} onClick={() => void act('转正', () => confirmPending(entry.id))}
                  style={{ fontFamily: 'inherit', fontSize: 12, padding: '4px 11px', borderRadius: 7, border: 'none', background: T.text, color: T.bg, fontWeight: 600, cursor: 'pointer' }}>
                  转正
                </button>
                <button disabled={!!busy} onClick={() => void act('丢掉', () => discardPending(entry.id))}
                  style={{ fontFamily: 'inherit', fontSize: 12, padding: '4px 11px', borderRadius: 7, border: 'none', background: T.card, color: T.text2, cursor: 'pointer' }}>
                  丢掉
                </button>
              </>
            )}
            {isAnchor && <span style={{ fontSize: 11.5, color: T.text2 }}>人格锚点不参与升降层</span>}
          </div>
        </div>
      )}
    </div>
  )
}
