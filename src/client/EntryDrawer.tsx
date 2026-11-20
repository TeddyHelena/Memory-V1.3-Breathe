/**
 * 条目抽屉（`#drawer`）—— 逐项照 `01-Memory.html` 的 Agent 页实现
 *
 * ## 原型真值（⛔ 改之前回 `00_记忆系统/docs/V1.3C-Agent页-原型规格.md` 核对）
 * [结构]
 * #drawer
 *   .dhead   #d-id + #d-title + #d-badges + #d-close(×)
 *   .dbody   标题(input) / 摘要(input + i「检索靠它命中，写清『这条是关于什么的』」)
 *            标签(i「回车加一个；共享 ≥2 个标签的条目会在球上连线」) + #d-tags
 *            优先级(number + i「数字越大越靠前」)
 *            正文(i「唯一真源是文件里的这一段；索引是派生的」)
 *                 + #d-md-seg(.seg 预览|编辑) + #d-md-view(.mdbox) / textarea#d-f-content
 *   .ro      kv×6：编号 / 层 / 来源 / 状态 / 衰减 / 来源指针  ＋ .hintline
 *   .dfoot   #d-save 保存 · #d-revert 还原 · #d-state 未改动
 * [/结构]
 * 关键尺寸：`.dhead{padding:13px 18px;border-bottom:1px solid var(--line)}` ·
 * `.dbody{padding:16px 18px 20px}` · `label.f{font-size:12px;color:var(--text2);margin:15px 0 6px}` ·
 * 输入 `13.5px / background:var(--card2) / radius:9px / padding:10px 12px` ·
 * 只读区 `.ro{background:var(--card2);radius:10px;padding:12px 14px}` ·
 * `.kv{display:flex;gap:9px;font-size:12px;color:var(--text2);margin:3px 0}` + `b{color:var(--text);flex:0 0 66px}` ·
 * `.dfoot{padding:12px 18px;border-top:1px solid var(--line);display:flex;gap:9px;align-items:center}` ·
 * `.seg{display:inline-flex;background:var(--card2);radius:8px;padding:2px}` + `.on{background:var(--bg);font-weight:600;box-shadow:elev1}` ·
 * `.mdbox{background:var(--card2);radius:9px;padding:14px 16px;max-height:360px;overflow:auto;font-size:13px;line-height:1.75}`
 *
 * ## ⚠️ 一条安全纪律（原型注释里写着的）
 * 「**渲染前先整体转义**（见 MD.render），容器正文是数据不是 HTML」——
 * 记忆容器是**数据**，里面完全可能有 `<script>`。本文件先 `escapeHtml` 再拼装，
 * ⛔ 任何"直接把正文塞进 innerHTML / dangerouslySetInnerHTML"的写法都不许出现。
 */

import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'

import type { MemoryEntryDetail } from './types-client.ts'
import { renderMarkdown } from './markdown.ts'

export interface EntryDrawerProps {
  id: string
  getEntry: (id: string) => Promise<MemoryEntryDetail>
  updateEntry: (id: string, patch: Partial<Pick<MemoryEntryDetail, 'title' | 'content' | 'tags' | 'priority' | 'summary'>>) => Promise<MemoryEntryDetail>
  onClose: () => void
  /** 保存成功后通知外面重载列表（真源在盘上，⛔ 不做乐观更新） */
  onChanged: () => void
}

const T = {
  bg: 'var(--dsw-alias-bg-base, #fff)',
  card: 'var(--dsw-specific-sidebar-fill, #f9fafb)',
  card2: 'var(--dsw-specific-selector, #f5f6f7)',
  line: 'var(--dsw-alias-border-l1, rgba(0,0,0,.04))',
  line2: 'var(--dsw-alias-border-l2, rgba(0,0,0,.10))',
  text: 'var(--dsw-alias-label-primary, #0f1115)',
  text2: 'var(--dsw-alias-label-secondary, #61666b)',
  idle: 'var(--dsw-alias-state-idle-primary, #d4d4d4)',
  brand: 'var(--dsw-alias-brand-primary, #0f1115)',
  elev1: 'var(--dsw-shadow-lv1, 0 2px 4px 0 rgba(0,0,0,.05))',
  elevPanel: 'var(--dsw-elevation-panel, 0 0 0 .5px rgba(0,0,0,.10), 0 3px 8px 0 rgba(0,0,0,.03), 0 0 16px 0 rgba(0,0,0,.02))',
} as const

const inputStyle: CSSProperties = {
  width: '100%', fontFamily: 'inherit', fontSize: 13.5, color: T.text, background: T.card2,
  border: 'none', borderRadius: 9, padding: '10px 12px', outline: 'none', resize: 'vertical',
}
const labelStyle: CSSProperties = { display: 'block', fontSize: 12, color: T.text2, margin: '15px 0 6px' }
const hintStyle: CSSProperties = { fontStyle: 'normal', color: T.idle, fontSize: 11 }

export function EntryDrawer({ id, getEntry, updateEntry, onClose, onChanged }: EntryDrawerProps): ReactNode {
  const [detail, setDetail] = useState<MemoryEntryDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  // 【Teddy】抽屉原来"突然出现"——因为组件是**挂/卸**，没有过渡可播。
  // 做法：挂载时先不带 `open`（原型里 = translateX(102%)，停在屏外），**下一帧**再加 ⇒
  // 浏览器就能播原型那条 `transition: transform .22s`（滑出而不是弹出）。
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const t = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(t)
  }, [])
  const [draft, setDraft] = useState<{ title: string; summary: string; tags: string[]; priority: number; content: string } | null>(null)
  const [tagInput, setTagInput] = useState('')
  const [seg, setSeg] = useState<'view' | 'edit'>('view')   // 原型默认「预览」
  const [saving, setSaving] = useState(false)
  const [state, setState] = useState('未改动')
  const [status2, setStatus2] = useState<string | null>(null)

  const isAnchor = id[0] === 'h'   // 人格锚点：**只读**（永不自动改 ⇒ 也不给一键改）

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const d = await getEntry(id)
        if (!alive) return
        setDetail(d)
        setDraft({
          title: d.title ?? '', summary: d.summary ?? '', tags: [...(d.tags ?? [])],
          priority: Number(d.priority ?? 60), content: d.content ?? '',
        })
        setState('未改动')
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => { alive = false }
  }, [id, getEntry])

  const dirty = useMemo(() => {
    if (!detail || !draft) return false
    return draft.title !== (detail.title ?? '')
      || draft.summary !== (detail.summary ?? '')
      || draft.content !== (detail.content ?? '')
      || draft.priority !== Number(detail.priority ?? 60)
      || draft.tags.join('\u0000') !== (detail.tags ?? []).join('\u0000')
  }, [detail, draft])

  useEffect(() => { if (state !== '保存中') setState(dirty ? '已改动' : '未改动') }, [dirty, state])

  const save = useCallback(async () => {
    if (!detail || !draft) return
    setSaving(true); setState('保存中'); setStatus2(null)
    try {
      await updateEntry(detail.id, {
        title: draft.title, summary: draft.summary, tags: draft.tags,
        priority: draft.priority, content: draft.content,
      })
      const again = await getEntry(detail.id)
      setDetail(again)
      setState('已保存')
      onChanged()
    } catch (e) {
      setState('保存失败')
      setStatus2(e instanceof Error ? e.message : String(e))
    } finally { setSaving(false) }
  }, [detail, draft, updateEntry, getEntry, onChanged])

  const revert = useCallback(() => {
    if (!detail) return
    setDraft({
      title: detail.title ?? '', summary: detail.summary ?? '', tags: [...(detail.tags ?? [])],
      priority: Number(detail.priority ?? 60), content: detail.content ?? '',
    })
    setState('未改动'); setStatus2(null)
  }, [detail])

  const ro = (k: string, v: ReactNode): ReactNode => (
    <div key={k} style={{ display: 'flex', gap: 9, fontSize: 12, color: T.text2, margin: '3px 0' }}>
      <b style={{ color: T.text, fontWeight: 600, flex: '0 0 66px' }}>{k}</b>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v}</span>
    </div>
  )

  return (
    <>
      {/* ⚠️ **并排看图才查出来的**：`markdown.ts` 一直在产出 `class="md-table"` / `md-h` / `md-p`…，
          但**没有任何样式** ⇒ 表格渲染成裸文本、标题和正文一样大。
          这里照抄原型 `.mdbox` 的那套规则（⛔ 类名必须与 markdown.ts 里输出的一致）。 */}
      <style>{`
        .mc-md h1,.mc-md h2,.mc-md h3,.mc-md h4,.mc-md h5,.mc-md h6 { margin:15px 0 8px; font-weight:600; line-height:1.45 }
        .mc-md h1 { font-size:17px } .mc-md h2 { font-size:15px } .mc-md h3 { font-size:13.5px }
        .mc-md h4,.mc-md h5,.mc-md h6 { font-size:13px; color:var(--dsw-alias-label-secondary,#61666b) }
        .mc-md > :first-child { margin-top:0 }
        .mc-md p { margin:0 0 10px }
        .mc-md ul { margin:0 0 10px; padding-left:20px } .mc-md li { margin:2px 0 }
        .mc-md blockquote { margin:0 0 10px; padding:8px 12px; border-left:2px solid var(--dsw-alias-border-l2,rgba(0,0,0,.10)); background:var(--dsw-alias-bg-base,#fff); border-radius:0 8px 8px 0; color:var(--dsw-alias-label-secondary,#61666b) }
        .mc-md pre { background:var(--dsw-alias-bg-base,#fff); border-radius:8px; padding:10px 12px; overflow:auto; font-family:ui-monospace,Menlo,monospace; font-size:12px; margin:0 0 10px }
        .mc-md code { font-family:ui-monospace,Menlo,monospace; font-size:12px; background:var(--dsw-alias-bg-base,#fff); padding:1px 5px; border-radius:5px }
        .mc-md hr { border:none; border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.10)); margin:15px 0 }
        .mc-md table { border-collapse:collapse; width:100%; margin:0 0 10px; font-size:12.5px; background:var(--dsw-alias-bg-base,#fff); border-radius:8px; overflow:hidden }
        .mc-md th,.mc-md td { padding:7px 10px; text-align:left; border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.04)); vertical-align:top }
        .mc-md th { background:var(--dsw-specific-sidebar-fill,#f9fafb); font-weight:600 }
        .mc-md tr:last-child td { border-bottom:none }
        .mc-md a { color:var(--dsw-alias-label-primary,#0f1115); text-decoration:underline }
      `}</style>
    {/* 必须带 open 类：原型 .drawer{transform:translateX(102%)} / .drawer.open{transform:none} —— 少它抽屉就停在屏外（截图里 遮罩有、抽屉没有 就是这个） */}
      <aside className={`drawer${shown ? ' open' : ''}`}>
      {/* dhead */}
      <div className='dhead'>
        <span style={{ fontFamily: 'ui-monospace,Menlo,monospace', fontSize: 11.5, color: T.text2 }}>{id}</span>
        <b style={{ fontSize: 13.5, fontWeight: 600, color: T.text }}>{detail?.title ?? '…'}</b>
        {/* #d-badges：人格锚点必须显眼（它进每一轮前缀，且不会被自动覆盖） */}
        {isAnchor && (
          <span style={{ fontSize: 10.5, color: T.text2, border: `1px solid ${T.line2}`, borderRadius: 4, padding: '0 5px' }}>
            人格锚点 · 只读
          </span>
        )}
        <button onClick={onClose} style={{ marginLeft: 'auto', fontFamily: 'inherit', fontSize: 18, lineHeight: 1, border: 'none', background: 'none', color: T.text2, cursor: 'pointer', padding: '2px 6px', borderRadius: 6 }}>×</button>
      </div>

      {/* `.dbody` */}
      <div className='dbody'>
        {error && <div style={{ fontSize: 12.5, color: T.text }}>读不到这条（不是"没有"）：{error}</div>}
        {!detail && !error && <div style={{ fontSize: 12.5, color: T.text2 }}>读取中…</div>}

        {detail && draft && (isAnchor ? (
          <>
            <div style={{ fontSize: 13.5, color: T.text }}>🔒 人格锚点只读</div>
            <div style={{ fontSize: 12, color: T.text2, marginTop: 8 }}>
              这 11 条进**每一轮**的系统前缀，且**永不自动覆盖** —— UI 不给一键改，要改请手改容器里的文件。
            </div>
            <div className='mc-md' style={{ background: T.card2, borderRadius: 9, padding: '14px 16px', marginTop: 14, fontSize: 13, lineHeight: 1.75, color: T.text }}>
              <div dangerouslySetInnerHTML={{ __html: renderMarkdown(draft.content) }} />
            </div>
          </>
        ) : (
          <>
            {/* 标题 */}
            <label className='f'>标题</label>
            <input type='text' value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />

            {/* 摘要 */}
            <label className='f'>摘要 <i>检索靠它命中，写清「这条是关于什么的」</i></label>
            <input type='text' value={draft.summary} onChange={(e) => setDraft({ ...draft, summary: e.target.value })} />

            {/* 标签 */}
            <label className='f'>标签 <i>回车加一个；共享 ≥2 个标签的条目会在球上连线</i></label>
            <div className='tagbox'>
              {draft.tags.map((tg) => (
                <span key={tg} className='tg'>
                  {tg}
                  <button onClick={() => setDraft({ ...draft, tags: draft.tags.filter((x) => x !== tg) })}>×</button>
                </span>
              ))}
              <input
                value={tagInput} placeholder='加标签…'
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && tagInput.trim()) {
                    const v = tagInput.trim()
                    if (!draft.tags.includes(v)) setDraft({ ...draft, tags: [...draft.tags, v] })
                    setTagInput('')
                  }
                }}
              />
            </div>

            {/* 优先级 */}
            <label className='f'>优先级 <i>数字越大越靠前</i></label>
            <input type='number' value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value) })} />

            {/* 正文 */}
            <label className='f'>正文 <i>唯一真源是文件里的这一段；索引是派生的</i></label>
            <div className='seg'>
              {(['view', 'edit'] as const).map((k) => (
                <button key={k} className={seg === k ? 'on' : ''} onClick={() => setSeg(k)}>{k === 'view' ? '预览' : '编辑'}</button>
              ))}
            </div>
            {seg === 'view' ? (
              <div className='mdbox'>
                {/* ⛔ 先整体转义再拼装 —— 容器正文是数据不是 HTML */}
                <div dangerouslySetInnerHTML={{ __html: renderMarkdown(draft.content) }} />
              </div>
            ) : (
              <textarea
                value={draft.content} rows={12}
                onChange={(e) => setDraft({ ...draft, content: e.target.value })}
              />
            )}
          </>
        ))}

        {detail && (
          <div className='ro'>
            {ro('编号', detail.id)}
            {ro('层', detail.layer)}
            {ro('来源', detail.source ? `${detail.source}${detail.source_line ? `:${detail.source_line}` : ''}` : '—')}
            {ro('状态', detail.status ?? 'active')}
            {ro('衰减', (detail as { decay_type?: string }).decay_type ?? '—')}
            {/* 【B4/B5】把**已经在跑**的数据露出来：访问时间 / 访问次数 / 新鲜度（宿主算好的，⛔ 客户端不重算） */}
            {ro('上次访问', (detail as { last_accessed?: string }).last_accessed?.slice(0, 16).replace('T', ' ') ?? '—')}
            {ro('访问次数', String((detail as { access_count?: number }).access_count ?? '—'))}
            {ro('新鲜度', (() => {
              const f = (detail as { fresh?: number }).fresh
              if (typeof f !== 'number') return '—'
              return `${(f * 100).toFixed(0)}%${f < 0.5 ? '（陈旧：已过半衰期）' : ''}`
            })())}
            {ro('来源指针', [detail.source_session, detail.source_message].filter(Boolean).join(' / ') || '—')}
            <div style={{ fontSize: 11.5, color: T.text2, marginTop: 9, borderTop: '1px solid rgba(0,0,0,.06)', paddingTop: 9 }}>
              <b>这些字段这一版改不了</b> —— 它们要动状态机与分层（升 hot / 降归档 / 取代 / 标记过期走按钮，
              其余属于新写通道）。摆在这里是让你看得见，不是忘了画。
            </div>
          </div>
        )}
      </div>

      {/* `.dfoot` */}
      {detail && !isAnchor && (
        <div className='dfoot'>
          <button id='d-save' onClick={() => void save()} disabled={saving || !dirty}>保存</button>
          <button id='d-revert' onClick={revert} disabled={saving || !dirty}>还原</button>
          <span className='st'>{status2 ?? state}</span>
        </div>
      )}
    </aside>
    </>
  )
}
