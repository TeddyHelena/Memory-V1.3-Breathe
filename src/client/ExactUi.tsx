/** exact 01-Memory.html iframe：逻辑宽度=面板宽+原页 rail 280（rail 移出面板），高度=面板高；不缩放、外层不滚。 */
import { useEffect, useRef, useState, type ReactNode } from 'react'

/**
 * 宿主注入的全局读一次。
 *
 * ⚠️ 不能在 render 时直接读：宿主的 `webserver/index-inject` 可能在 iframe 挂载**之后**才跑，
 * 那一刻读到空串会把空 token 永久固化进 iframe 地址 —— 服务端返回 401，
 * 表现为面板里露出一截 JSON（2026-11-20 实测）。
 * 所以这里改成「等注入」：轮询到 token 出现再挂 iframe；等不到就给明确提示，不把 401 露出来。
 */
function readGlobal(name: string): string {
  const v = (globalThis as Record<string, unknown>)[name]
  return typeof v === 'string' ? v : ''
}

const WAIT_MS = 5000
const POLL_MS = 100

export function ExactUi(): ReactNode {
  const box = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 1320, h: 1000 })
  // null = 还在等；'' = 等超时仍未注入；非空 = 可以挂 iframe
  const [token, setToken] = useState<string | null>(null)
  const [prefix, setPrefix] = useState<string>('/api/memory')

  useEffect(() => {
    let done = false
    const started = Date.now()
    const tick = (): void => {
      if (done) return
      const t = readGlobal('__DSH_MEMORY_TOKEN__')
      const p = readGlobal('__DSH_MEMORY_API_PREFIX__')
      if (p) setPrefix(p)
      if (t) {
        done = true
        setToken(t)
        return
      }
      if (Date.now() - started >= WAIT_MS) {
        done = true
        setToken('')
        return
      }
      window.setTimeout(tick, POLL_MS)
    }
    tick()
    return () => { done = true }
  }, [])

  useEffect(() => {
    const el = box.current
    if (!el) return
    const fit = () => setSize({ w: Math.max(900, el.clientWidth), h: Math.max(320, el.clientHeight) })
    fit()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : null
    ro?.observe(el)
    return () => ro?.disconnect()
  }, [])

  return (
    <div ref={box} style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', background: 'var(--dsw-alias-bg-base, #fff)' }}>
      {token === null && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--dsw-alias-label-secondary, #61666b)', fontSize: 13 }}>
          正在连接记忆服务…
        </div>
      )}
      {token === '' && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, height: '100%', padding: 24, color: 'var(--dsw-alias-label-secondary, #61666b)', fontSize: 13, textAlign: 'center' }}>
          <div>记忆服务的访问令牌还没注入到页面。</div>
          <div>通常是页面加载早于扩展注入，刷新一次就好。</div>
          <button
            onClick={() => window.location.reload()}
            style={{ font: 'inherit', fontSize: 13, padding: '7px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', background: 'var(--dsw-alias-brand-primary, #0f1115)', color: 'var(--dsw-alias-bg-base, #fff)' }}
          >
            刷新页面
          </button>
        </div>
      )}
      {token !== null && token !== '' && (
        <iframe
          title='记忆'
          src={`${prefix}/ui?t=${encodeURIComponent(token)}&onboarded=0.9.0`}
          style={{
            position: 'absolute', left: -280, top: 0, width: size.w + 280, height: size.h,
            border: 0, display: 'block',
          }}
        />
      )}
    </div>
  )
}
