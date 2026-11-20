/**
 * Agent 镜头右栏（1:1 原型 01-Memory.html）：我的记忆 / 还能读到多少 / 状态 / 层 /
 * 每层平均完整度 / 最近写入。全部读真实 entries + tiers；不造假数据。
 */
import type { ReactNode } from 'react'
import type { MemoryEntryMeta } from './types-client.ts'
import { displayTitle, isTombstone } from './entry-text.ts'

const T = {
  card: 'var(--dsw-specific-sidebar-fill, #f9fafb)',
  card2: 'var(--dsw-specific-selector, #f5f6f7)',
  bg: 'var(--dsw-alias-bg-base, #fff)',
  line: 'var(--dsw-alias-border-l1, rgba(0,0,0,.04))',
  text: 'var(--dsw-alias-label-primary, #0f1115)',
  text2: 'var(--dsw-alias-label-secondary, #61666b)',
  brand: 'var(--dsw-alias-brand-primary, #0f1115)',
  elev: 'var(--dsw-elevation-panel, 0 0 0 .5px rgba(0,0,0,.10), 0 3px 8px rgba(0,0,0,.03))',
} as const
const RES = ['full', 'snapshot', 'outline', 'forgotten'] as const
const RES_LABEL: Record<string, string> = { full: '完整', snapshot: '快照', outline: '轮廓', forgotten: '遗忘' }
const RES_COLOR: Record<string, string> = { full: '#22c55e', snapshot: '#f59e0b', outline: '#94a3b8', forgotten: '#d4d4d4' }
const LAYERS = [
  { key: 'hot' as const, label: '热', color: '#f59e0b' },
  { key: 'longterm' as const, label: '长期', color: '#3b82f6' },
  { key: 'archive' as const, label: '归档', color: '#94a3b8' },
]

const card: React.CSSProperties = { background: T.card, borderRadius: 16, padding: '14px 16px', boxShadow: T.elev }
const h: React.CSSProperties = { fontSize: 13, fontWeight: 600, color: T.text, marginBottom: 10 }
const sub: React.CSSProperties = { fontSize: 11.5, color: T.text2 }
const big: React.CSSProperties = { fontSize: 21, fontWeight: 600, color: T.text, lineHeight: 1.2 }

export interface AgentSideProps {
  entries: MemoryEntryMeta[]
  hotOrder: string[]
  tiers: Record<string, string>
  linkCount: number
  decay: { lastCount: number; rolledBack: boolean } | null
  onRollback: () => void
  onOpen: (id: string) => void
}

export function AgentSide({ entries, hotOrder, tiers, linkCount, decay, onRollback, onOpen }: AgentSideProps): ReactNode {
  const total = entries.length
  const candidates = entries.filter((e) => e.layer === 'pending').length
  const tierOf = (e: MemoryEntryMeta): string => tiers[e.id] ?? (isTombstone(e) ? 'forgotten' : 'full')
  const resCounts = RES.map((k) => ({ k, n: entries.filter((e) => tierOf(e) === k).length }))
  const status = {
    active: entries.filter((e) => (e.status ?? 'active') === 'active').length,
    stale: entries.filter((e) => typeof e.fresh === 'number' && e.fresh < 0.5).length,
    superseded: entries.filter((e) => e.status === 'superseded').length,
    expired: entries.filter((e) => e.status === 'expired').length,
  }
  const layerRows = LAYERS.map((l) => {
    const list = entries.filter((e) => e.layer === l.key)
    const avg = list.length ? list.reduce((a, e) => a + (typeof e.fresh === 'number' ? e.fresh : 1), 0) / list.length : 0
    return { ...l, n: list.length, avg }
  })
  const recent = [...entries].filter((e) => e.layer !== 'pending').sort((a, b) => (a.updated < b.updated ? 1 : -1)).slice(0, 5)

  return (
    <div style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10, overflow: 'auto', paddingRight: 2 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1.15fr 1fr', gap: 10 }}>
        <div style={card}>
          <div style={h}>我的记忆 <span style={{ ...sub, fontWeight: 400 }}>全部在本机</span></div>
          <div style={{ display: 'flex', gap: 18, alignItems: 'baseline' }}>
            {[{ n: total, l: '条记忆' }, { n: hotOrder.length, l: '人格锚点' }, { n: linkCount, l: '条连线' }, { n: candidates, l: '候选' }].map((x) => (
              <span key={x.l}><b style={big}>{x.n}</b><span style={{ ...sub, marginLeft: 4 }}>{x.l}</span></span>
            ))}
          </div>
        </div>
        <div style={card}>
          <div style={h}>还能读到多少 <span style={{ ...sub, fontWeight: 400 }}>完整 → 遗忘</span></div>
          <div style={{ display: 'flex', height: 7, borderRadius: 4, overflow: 'hidden', background: T.card2, marginBottom: 8 }}>
            {resCounts.map((x) => x.n > 0 && <div key={x.k} style={{ width: `${(x.n / Math.max(1, total)) * 100}%`, background: RES_COLOR[x.k] }} />)}
          </div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 11.5, color: T.text2 }}>
            {resCounts.map((x) => <span key={x.k}><i style={{ display: 'inline-block', width: 7, height: 7, borderRadius: 4, background: RES_COLOR[x.k], marginRight: 4 }} />{RES_LABEL[x.k]} {x.n}</span>)}
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div style={card}>
          <div style={h}>状态</div>
          {[['活跃', status.active], ['陈旧', status.stale], ['已取代', status.superseded], ['已过期', status.expired]].map(([l, n]) => (
            <div key={l} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, color: T.text2, padding: '3px 0' }}><span>{l}</span><b style={{ color: T.text }}>{n}</b></div>
          ))}
          {decay && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, paddingTop: 6, borderTop: `1px solid ${T.line}`, fontSize: 11, color: T.text2 }}>
              {decay.lastCount > 0 && !decay.rolledBack ? (
                <>
                  <span>今天自动归档 {decay.lastCount} 条</span>
                  <button onClick={onRollback} style={{ fontFamily: 'inherit', fontSize: 11, border: 'none', borderRadius: 6, padding: '2px 7px', cursor: 'pointer', background: T.card2, color: T.text }}>撤销</button>
                </>
              ) : <span>{decay.rolledBack ? '今天的自动归档已撤销' : '今天无自动归档'}</span>}
            </div>
          )}
        </div>
        <div style={card}>
          <div style={h}>层 <span style={{ ...sub, fontWeight: 400 }}>球上三个壳</span></div>
          <div style={{ display: 'flex', height: 7, borderRadius: 4, overflow: 'hidden', background: T.card2, marginBottom: 8 }}>
            {layerRows.map((x) => x.n > 0 && <div key={x.key} style={{ width: `${(x.n / Math.max(1, total)) * 100}%`, background: x.color }} />)}
          </div>
          <div style={{ display: 'flex', gap: 12, fontSize: 11.5, color: T.text2 }}>{layerRows.map((x) => <span key={x.key}>{x.label} {x.n}</span>)}</div>
        </div>
      </div>

      <div style={card}>
        <div style={h}>每层的平均完整度 <span style={{ ...sub, fontWeight: 400 }}>state 均值</span></div>
        {layerRows.map((x) => (
          <div key={x.key} style={{ display: 'grid', gridTemplateColumns: '42px 1fr 44px 38px', gap: 8, alignItems: 'center', fontSize: 11.5, color: T.text2, padding: '3px 0' }}>
            <span>{x.label}</span>
            <div style={{ height: 5, borderRadius: 3, background: T.card2 }}><div style={{ height: '100%', width: `${Math.round(x.avg * 100)}%`, background: x.color, borderRadius: 3 }} /></div>
            <b style={{ color: T.text, textAlign: 'right' }}>{x.avg.toFixed(2)}</b>
            <span style={{ textAlign: 'right' }}>{x.n} 条</span>
          </div>
        ))}
      </div>

      <div style={card}>
        <div style={h}>最近写入 <span style={{ ...sub, fontWeight: 400 }}>点一条看全文</span></div>
        {recent.map((e) => {
          const t = tierOf(e)
          return (
            <button key={e.id} onClick={() => onOpen(e.id)} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', border: 'none', borderTop: `1px solid ${T.line}`, background: 'transparent', padding: '7px 0', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit' }}>
              <span style={{ fontSize: 11, color: T.text2, fontFamily: 'ui-monospace,Menlo,monospace', minWidth: 28 }}>{e.id}</span>
              <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayTitle(e)}</span>
              <span style={{ fontSize: 10.5, color: T.text2 }}>{e.updated?.slice(5)}</span>
              <span style={{ fontSize: 10.5, color: RES_COLOR[t] ?? T.text2, background: T.card2, borderRadius: 999, padding: '1px 7px' }}>{RES_LABEL[t] ?? t}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
