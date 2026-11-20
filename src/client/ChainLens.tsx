/**
 * 记忆链（1:1 结构）：根「我」→ 系统 → 项目 → 环；左时间线、右环详情。
 * 数据来自真实 entries/tiers；系统按日期段映射（V1.1/V1.2/V1.3），不伪造合成 CHAIN。
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { MemoryChainData, MemoryEntryMeta } from './types-client.ts'
import { displayTitle, isTombstone } from './entry-text.ts'

const T = {
  card: 'var(--dsw-specific-sidebar-fill, #f9fafb)',
  bg: 'var(--dsw-alias-bg-base, #fff)',
  card2: 'var(--dsw-specific-selector, #f5f6f7)',
  line: 'var(--dsw-alias-border-l1, rgba(0,0,0,.04))',
  line2: 'var(--dsw-alias-border-l2, rgba(0,0,0,.10))',
  text: 'var(--dsw-alias-label-primary, #0f1115)',
  text2: 'var(--dsw-alias-label-secondary, #61666b)',
  elev: 'var(--dsw-elevation-panel, 0 0 0 .5px rgba(0,0,0,.10), 0 3px 8px rgba(0,0,0,.03))',
} as const
const RES_LABEL: Record<string, string> = { full: '完整', snapshot: '快照', outline: '轮廓', forgotten: '遗忘' }
const RES_COLOR: Record<string, string> = { full: '#22c55e', snapshot: '#f59e0b', outline: '#94a3b8', forgotten: '#d4d4d4' }
const card: React.CSSProperties = { background: T.card, borderRadius: 16, boxShadow: T.elev }

function sysOf(date: string): string {
  const d = date.slice(0, 10)
  if (d < '2026-10-01') return 'MemoryV1.1'
  if (d < '2026-10-20') return 'MemoryV1.2'
  return 'MemoryV1.3'
}

export interface ChainLensProps {
  entries: MemoryEntryMeta[]
  hotOrder: string[]
  tiers: Record<string, string>
  chain?: MemoryChainData | null
  onOpen: (id: string) => void
}

export function ChainLens({ entries, hotOrder, tiers, chain, onOpen }: ChainLensProps): ReactNode {
  const byId = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries])
  const hot = hotOrder.map((id) => byId.get(id)).filter(Boolean) as MemoryEntryMeta[]
  const rest = entries.filter((e) => e.layer !== 'hot' && e.layer !== 'pending')
  const tierOf = (e: MemoryEntryMeta): string => tiers[e.id] ?? (isTombstone(e) ? 'forgotten' : 'full')

  const systems = useMemo(() => {
    if (chain?.subjects?.length) {
      const sys = chain.subjects.filter((s) => s.kind === 'system')
      if (sys.length) return sys.map((s) => [s.name, rest] as const)
    }
    const map = new Map<string, MemoryEntryMeta[]>()
    for (const e of rest) {
      const k = sysOf(e.updated ?? '')
      const arr = map.get(k) ?? []
      arr.push(e)
      map.set(k, arr)
    }
    return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
  }, [rest, chain])
  const [sys, setSys] = useState(systems[0]?.[0] ?? '')
  const sysEntries = systems.find(([k]) => k === sys)?.[1] ?? systems[0]?.[1] ?? []
  const projects = useMemo(() => {
    const map = new Map<string, MemoryEntryMeta[]>()
    if (chain?.subjects?.length) {
      const bySession = new Map(chain.subjects.filter((s) => s.kind === 'conversation' && s.session_id).map((s) => [s.session_id as string, s.name]))
      for (const e of sysEntries) {
        const sid = chain.entrySessions[e.id]
        const k = (sid && bySession.get(sid)) || '史前/未归'
        const arr = map.get(k) ?? []
        arr.push(e)
        map.set(k, arr)
      }
    } else {
      for (const e of sysEntries) {
        const k = (e.tags ?? [])[0] || '未分组'
        const arr = map.get(k) ?? []
        arr.push(e)
        map.set(k, arr)
      }
    }
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length)
  }, [sysEntries, chain])
  const [proj, setProj] = useState(projects[0]?.[0] ?? '')
  const projEntries = projects.find(([k]) => k === proj)?.[1] ?? projects[0]?.[1] ?? []
  const rings = useMemo(() => {
    const map = new Map<string, MemoryEntryMeta[]>()
    for (const e of projEntries) {
      const d = (e.updated ?? '').slice(0, 10) || '—'
      const arr = map.get(d) ?? []
      arr.push(e)
      map.set(d, arr)
    }
    return [...map.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1))
  }, [projEntries])
  const [ring, setRing] = useState(rings[0]?.[0] ?? '')
  useEffect(() => { if (systems.length && !systems.some(([k]) => k === sys)) setSys(systems[0][0]) }, [systems, sys])
  useEffect(() => { if (projects.length && !projects.some(([k]) => k === proj)) setProj(projects[0][0]) }, [projects, proj])
  useEffect(() => { if (rings.length && !rings.some(([d]) => d === ring)) setRing(rings[0][0]) }, [rings, ring])
  const ringEntries = rings.find(([d]) => d === ring)?.[1] ?? rings[0]?.[1] ?? []

  const hotGroups = useMemo(() => {
    const map = new Map<string, MemoryEntryMeta[]>()
    for (const e of hot) {
      const k = (e.tags ?? [])[0] || '人格'
      const arr = map.get(k) ?? []
      arr.push(e)
      map.set(k, arr)
    }
    return [...map.entries()]
  }, [hot])

  return (
    <div style={{ flex: '1 1 auto', minWidth: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* 根「我」 */}
      <div style={{ ...card, padding: '13px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 9 }}>
          <b style={{ fontSize: 13 }}>根「我」</b>
          <span style={{ fontSize: 11.5, color: T.text2 }}>{hot.length} 条人格锚点 · 一条链，分 {hotGroups.length} 个侧面 · H = ∞ 不衰减</span>
          <span style={{ marginLeft: 'auto', fontSize: 11, color: T.text2 }}>不是 Subject 链上的一环，和下面分开看</span>
        </div>
        <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap' }}>
          {hotGroups.map(([g, list]) => (
            <div key={g} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ fontSize: 11, color: T.text2, minWidth: 50 }}>{g}</span>
              {list.map((e, i) => (
                <span key={e.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  {i > 0 && <span style={{ color: T.text2, fontSize: 10 }}>→</span>}
                  <button onClick={() => onOpen(e.id)} title={displayTitle(e)} style={{ fontFamily: 'inherit', fontSize: 11.5, border: `1px solid ${T.line2}`, background: T.bg, borderRadius: 999, padding: '2px 9px', color: T.text, cursor: 'pointer' }}>
                    <i style={{ display: 'inline-block', width: 6, height: 6, borderRadius: 999, background: RES_COLOR[tierOf(e)] ?? '#94a3b8', marginRight: 5 }} />{displayTitle(e).slice(0, 10) || e.id}
                  </button>
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* 系统 / 项目 */}
      <div style={{ ...card, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11.5, color: T.text2 }}>系统</span>
        {systems.map(([k, list]) => (
          <button key={k} data-sys={k} onClick={() => { setSys(k); setProj('') }} style={{ fontFamily: 'inherit', fontSize: 11.5, border: 'none', borderRadius: 8, padding: '3px 9px', cursor: 'pointer', background: sys === k ? T.bg : 'transparent', color: sys === k ? T.text : T.text2, fontWeight: sys === k ? 600 : 400, boxShadow: sys === k ? '0 1px 3px rgba(0,0,0,.08)' : 'none' }}>
            {k} <span style={{ opacity: .7 }}>{list.length}</span>
          </button>
        ))}
        <span style={{ width: 1, height: 16, background: T.line2 }} />
        <span style={{ fontSize: 11.5, color: T.text2 }}>项目</span>
        {projects.map(([k, list]) => (
          <button key={k} data-proj={k} onClick={() => setProj(k)} style={{ fontFamily: 'inherit', fontSize: 11.5, border: 'none', borderRadius: 8, padding: '3px 9px', cursor: 'pointer', background: proj === k ? T.bg : 'transparent', color: proj === k ? T.text : T.text2, fontWeight: proj === k ? 600 : 400, boxShadow: proj === k ? '0 1px 3px rgba(0,0,0,.08)' : 'none' }}>
            {k} <span style={{ opacity: .7 }}>{list.length}</span>
          </button>
        ))}
      </div>

      {/* 左时间线 + 右详情 */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.25fr 1fr', gap: 10, minHeight: 0 }}>
        <div style={{ ...card, padding: '13px 15px', minHeight: 300 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <b style={{ fontSize: 13 }}>{proj || '未分组'}</b>
            <span style={{ fontSize: 11, color: T.text2 }}>{rings.length} 个环 · {projEntries.length} 条 · 最近 {rings[0]?.[0] ?? '—'}</span>
          </div>
          <div style={{ display: 'flex', gap: 6, overflowX: 'auto', padding: '15px 2px 6px' }}>
            {rings.map(([d, list], i) => {
              const t = tierOf(list[0])
              return (
                <button key={d} data-ring={d} onClick={() => setRing(d)} title={`${d} · ${list.length} 条`} style={{ flex: '0 0 auto', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'inherit' }}>
                  {i > 0 && <span style={{ display: 'none' }} />}
                  <span style={{ width: 10 + Math.round(6 * Math.sqrt(list.length)), height: 10 + Math.round(6 * Math.sqrt(list.length)), borderRadius: '50%', background: RES_COLOR[t] ?? '#94a3b8', opacity: ring === d ? 1 : .55, boxShadow: ring === d ? `0 0 0 2px ${T.bg}, 0 0 0 4px ${RES_COLOR[t] ?? '#94a3b8'}` : 'none' }} />
                  <span style={{ fontSize: 10, color: T.text2 }}>{d.slice(5)}</span>
                  <span style={{ fontSize: 9.5, color: T.text2 }}>{RES_LABEL[t] ?? t}</span>
                </button>
              )
            })}
          </div>
          <div style={{ borderTop: `1px solid ${T.line}`, marginTop: 10, paddingTop: 8, fontSize: 11.5, color: T.text2, lineHeight: 1.8 }}>
            <div>候选不进链 · hot 是根「我」· 只有人工提及才回血</div>
          </div>
        </div>
        <div style={{ ...card, padding: '13px 15px', minHeight: 300 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
            <b style={{ fontSize: 13 }}>{ring ? `${ring} 那次` : '选一个环'}</b>
            {ring && <span style={{ fontSize: 10.5, color: T.text2, background: T.card2, borderRadius: 999, padding: '1px 8px' }}>{RES_LABEL[tierOf(ringEntries[0])] ?? '—'}</span>}
            <span style={{ marginLeft: 'auto', fontSize: 10.5, color: T.text2 }}>{ringEntries.length} 条</span>
          </div>
          {ringEntries.map((e) => (
            <button key={e.id} onClick={() => onOpen(e.id)} style={{ display: 'block', width: '100%', textAlign: 'left', border: 'none', borderTop: `1px solid ${T.line}`, background: 'transparent', padding: '8px 0', cursor: 'pointer', fontFamily: 'inherit' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                <span style={{ fontSize: 10.5, color: T.text2, fontFamily: 'ui-monospace,Menlo,monospace' }}>{e.id}</span>
                <span style={{ fontSize: 12.5, color: isTombstone(e) ? T.text2 : T.text, textDecoration: isTombstone(e) ? 'line-through' : 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayTitle(e)}</span>
              </div>
              <div style={{ fontSize: 11, color: T.text2, marginTop: 3 }}>{e.summary || '（无摘要）'}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
