/** exact 01-Memory.html iframe：逻辑宽度=面板宽+原页 rail 280（rail 移出面板），高度=面板高；不缩放、外层不滚。 */
import { useEffect, useRef, useState, type ReactNode } from 'react'

export function ExactUi(): ReactNode {
  const g = globalThis as Record<string, unknown>
  const prefix = typeof g.__DSH_MEMORY_API_PREFIX__ === 'string' ? g.__DSH_MEMORY_API_PREFIX__ : '/api/memory'
  const token = typeof g.__DSH_MEMORY_TOKEN__ === 'string' ? g.__DSH_MEMORY_TOKEN__ : ''
  const src = `${prefix}/ui?t=${encodeURIComponent(token)}&onboarded=0.9.0`
  const box = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 1320, h: 1000 })
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
      <iframe
        title='记忆'
        src={src}
        style={{
          position: 'absolute', left: -280, top: 0, width: size.w + 280, height: size.h,
          border: 0, display: 'block',
        }}
      />
    </div>
  )
}
