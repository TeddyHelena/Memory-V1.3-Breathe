/** 3D 旋转知识球：Canvas 手写渲染，零依赖。自转 + 拖拽旋转 + 滚轮缩放 + hover 高亮 + 点击选中。 */

import { useEffect, useRef } from 'react'
import type { GraphLink, GraphNode } from './graph-types.ts'
import { displayTitle } from './entry-text.ts'
import {
  axisAngle, bucketByLayer, layoutSphereLayers, projectNode,
  quatMul, type Quat, type SphereNode,
} from './graph-math.ts'
import { labelColor, labelSecondaryColor, strokeColor } from './theme.ts'

/** 层 → 颜色（与平面图一致） */
const LAYER_COLORS: Record<GraphNode['layer'], string> = {
  hot: '#f59e0b',
  longterm: '#3b82f6',
  archive: '#94a3b8',
  pending: '#a855f7',
}

/** 边类型 → 颜色 */
const LINK_COLORS: Record<GraphLink['type'], string> = {
  hot: '#f59e0b',
  group: '#818cf8',
  tag: 'rgba(148, 163, 184, 0.45)',
}

export interface Graph3DProps {
  nodes: GraphNode[]
  links: GraphLink[]
  /** 搜索命中节点 id 集合（未命中节点变暗） */
  highlight?: ReadonlySet<string> | null
  /** 当前选中的节点 id */
  selectedId?: string | null
  onSelect: (id: string) => void
}

/** 球体旋转控制（鼠标拖拽增量） */
interface DragState {
  lastX: number
  lastY: number
}

/** 每帧自转速度（弧度/帧）——慢速，约 2.7°/秒 */
const AUTO_ROTATE_SPEED = 0.0008

/** 球体基础半径（相对画布短边） */
/**
 * 球的基准半径 ÷ min(画布宽, 画布高)。
 *
 * 这个数是**量出来的**，不是调的（2026-10-10）：
 *   把原型截图与我们的截图用同一套方法量球直径占卡片高的比例——
 *   **原型 51.1% / 我们 70.0%**（当时比值 0.16）⇒ 0.16 × (51.1/70.0) ≈ 0.117 ⇒ 取 0.12 —— 但 Teddy 看实机说"还是太小"，0.16 又说"太大" ⇒ **取中 0.14**。
 * （量表有误差：我是按截图上估的裁剪框量的，不是精确框选。最终以他眼睛为准。）
 * 一串的来历：0.25（照原型抄）→ 0.20 → 0.16（Teddy：太大）→ 0.12（量出来的，Teddy：太小）
 * → 0.14 → 0.155 → **0.18（Teddy 直接给的值）**。
 * ⛔ 下次要动它，先量两张图再动，或者让他给数 —— 别自己拍。
 */
const BASE_RADIUS_RATIO = 0.18

/** 相机焦距（相对单位深度 ±1.7，越大透视越平缓） */
const FOCAL = 4.5

/** 投影后节点（带 3D 位置与 2D 屏幕坐标） */
interface ProjectedSphere {
  sn: SphereNode
  x: number
  y: number
  depth: number
  radius: number
}

export function Graph3D({ nodes, links, highlight, selectedId, onSelect }: Graph3DProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  // 渲染状态放 ref（不触发 react 重渲）
  const stateRef = useRef({
    quat: { w: 1, x: 0, y: 0, z: 0 } as Quat,
    zoom: 1,
    dragging: false,
    drag: { lastX: 0, lastY: 0 } as DragState,
    hoveredId: null as string | null,
  })

  // 构建球面节点（每次 nodes 变化重建）
  const sphereNodesRef = useRef<SphereNode[]>([])

  useEffect(() => {
    sphereNodesRef.current = layoutSphereLayers(bucketByLayer(nodes), 1)
  }, [nodes])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const state = stateRef.current
    const dpr = window.devicePixelRatio ?? 1
    let width = 0
    let height = 0
    let rafId = 0
    // 当前帧投影结果（render 写入，hitTest 读取）
    let projected: ProjectedSphere[] = []
    // 画布尺寸的唯一依据＝宿主盒（父元素）。见下方 resize 注释。
    const host = canvas.parentElement ?? canvas

    /**
     * 按宿主盒尺寸定画布：**显式写 px**，不用百分比。
     *
     * 为什么：`height: 100%` 在「祖先链没有确定高度」时会解不出来（百分比高度对
     * auto 高度父级无效），Chromium 直接回落到 canvas 自己的 height 属性——也就是
     * 上一次写进去的 backing store 尺寸。于是画布尺寸自锁定：420px 高的卡片里塞
     * 一个 282px 高的画布，球画在卡片上半格（2026-09-28 实测复现）。
     * 量宿主、写 px，切断这个自引用环。
     */
    const resize = (): void => {
      const rect = host.getBoundingClientRect()
      const nextWidth = Math.round(rect.width)
      const nextHeight = Math.round(rect.height)
      // 宿主不可见（display:none / 未挂载）时保持上一帧尺寸，等 ResizeObserver 再唤
      if (nextWidth < 1 || nextHeight < 1) return
      width = nextWidth
      height = nextHeight
      canvas.style.width = `${nextWidth}px`
      canvas.style.height = `${nextHeight}px`
      canvas.width = Math.max(1, Math.round(nextWidth * dpr))
      canvas.height = Math.max(1, Math.round(nextHeight * dpr))
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(host)

    const nodeById = new Map(nodes.map((n) => [n.id, n]))
    const linkById = new Map<string, GraphLink>()
    for (const link of links) {
      const key = link.source < link.target ? `${link.source}->${link.target}` : `${link.target}->${link.source}`
      linkById.set(key, link)
    }
    const linkKey = (a: string, b: string): string =>
      a < b ? `${a}->${b}` : `${b}->${a}`

    const render = (): void => {
      const rw = width
      const rh = height
      if (rw < 2 || rh < 2) return
      ctx.clearRect(0, 0, rw, rh)
      const baseRadius = Math.min(rw, rh) * BASE_RADIUS_RATIO * state.zoom
      const cx = rw / 2
      const cy = rh / 2
      // 主题取色（明暗自适应；Canvas 每帧重读开销小，直接取）
      const textPrimary = labelColor()
      const textSecondary = labelSecondaryColor()
      const strokeBase = strokeColor(0.3)

      // 旋转球面节点 → 投影（写模块级 projected 供 hitTest）
      projected = sphereNodesRef.current.map((sn) => {
        const p = projectNode(sn, state.quat, rw, rh, baseRadius, FOCAL)
        return { sn, x: p.x, y: p.y, depth: p.depth, radius: p.radius }
      })
      // 按深度排序（远先画）
      projected.sort((a, b) => a.depth - b.depth)

      // 边（先画，在节点之下）
      const hovered = state.hoveredId
      for (const sn of sphereNodesRef.current) {
        const aId = sn.id
        for (const bId of nodeById.keys()) {
          if (aId >= bId) continue
          const link = linkById.get(linkKey(aId, bId))
          if (!link) continue
          const a = projected.find((p) => p.sn.id === aId)
          const b = projected.find((p) => p.sn.id === bId)
          if (!a || !b) continue
          // 深度为负（背面）的边淡化
          const midDepth = (a.depth + b.depth) / 2
          const alpha = 0.25 + 0.75 * Math.max(0, (midDepth + 1) / 2)
          const color = LINK_COLORS[link.type]
          // hover/选中高亮：只亮相关边
          const active = hovered === aId || hovered === bId || selectedId === aId || selectedId === bId
          if (hovered && !active) continue
          if (selectedId && !active && hovered === null) continue
          // 【守卫】未知链类型 ⇒ **降级成中性色**，⛔ 不许把整块面板崩掉。
          // 2026-10-10 实测：mock 把字段写成 `kind`（真名 `type`）⇒ color 为 undefined
          // ⇒ 这一行直接抛 `reading 'replace'`，**整个面板白掉**。
          // 生产里 `type` 是封闭联合类型、不会出现未知值 —— 但"不会出现"和"崩了没人知道"
          // 是两件事，这里按"坏数据也不许拖垮界面"处理（与本仓"读不到 ≠ 不在"同一条纪律）。
          const safe = typeof color === 'string' && color.includes('0.45')
            ? (active ? color.replace('0.45', '0.9') : color)
            : 'rgba(148,163,184,.75)'
          ctx.strokeStyle = safe
          ctx.globalAlpha = active ? Math.max(0.6, alpha) : alpha * 0.5
          ctx.lineWidth = link.type === 'hot' ? 1.5 : 1
          ctx.beginPath()
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(b.x, b.y)
          ctx.stroke()
        }
      }
      ctx.globalAlpha = 1

      // 节点
      for (const p of projected) {
        const node = nodeById.get(p.sn.id)
        if (!node) continue
        const isHovered = hovered === p.sn.id
        const isSelected = selectedId === p.sn.id
        const isHighlighted = highlight == null || highlight.size === 0 || highlight.has(p.sn.id)
        const dimmed = highlight != null && highlight.size > 0 && !isHighlighted
        const connectedToHover = hovered !== null && !isHovered && linkById.has(linkKey(p.sn.id, hovered))

        const color = LAYER_COLORS[node.layer]
        const r = p.radius * (isSelected ? 1.6 : isHovered ? 1.35 : 1)
        // 【B3b】陈旧（超过半衰期）⇒ 半透明 —— 图例那句「半透明 陈旧」**球上这条**也终于有实现了
      // （判据与行内、与宿主 `/list` 完全同源：`fresh < 0.5`，⛔ 不另起一套）
      const staleNode = typeof node.fresh === 'number' && node.fresh < 0.5
      ctx.globalAlpha = dimmed ? 0.15 : isHovered || isSelected || connectedToHover ? 1 : staleNode ? 0.45 : 0.75
        ctx.beginPath()
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
        // 【第4轮 A13】失效条目画**空心**（原型图例：实心 活跃 · 空心 失效）——
        // 判据取**节点状态**，⛔ 不靠颜色深浅暗示（那和"陈旧"的半透明分不开）。
        const dead = node.status === 'expired' || node.status === 'superseded'
        ctx.fillStyle = color
        if (!dead) ctx.fill()
        else {
          ctx.strokeStyle = color
          ctx.lineWidth = 1.4
          ctx.stroke()
        }
        // 描边：主题化（选中白圈，其余主题描边）
        ctx.lineWidth = isSelected ? 2.5 : 1
        ctx.strokeStyle = isSelected || isHovered ? '#ffffff' : strokeBase
        ctx.stroke()
        ctx.globalAlpha = 1

        // 标签：hot 层始终显示，其他层 hover/选中时显示
        // 【第5轮·并排看图抓到的】原来这里写着「hot 层**始终**显示标签」——那是旧设置页的用法。
        // 原型里标签**只在 hover / 选中 / 高亮时**出现；常显会把球变成"散点图 + 文字标签"，
        // 与"球"这个视觉完全冲突。⇒ 去掉 hot 特例。
        if (isHovered || isSelected || connectedToHover) {
          const label = (() => { const t = displayTitle(node); return t.length > 12 ? t.slice(0, 12) + '…' : t })()
          ctx.font = isHovered || isSelected ? '600 13px -apple-system, sans-serif' : '12px -apple-system, sans-serif'
          ctx.fillStyle = isHovered || isSelected ? textPrimary : textSecondary
          ctx.textAlign = 'center'
          // 文字加淡色描边提可读性（浅色背景下深字更清晰）
          ctx.lineWidth = 3
          ctx.strokeStyle = 'rgba(255,255,255,0.6)'
          ctx.strokeText(label, p.x, p.y - r - 6)
          ctx.fillText(label, p.x, p.y - r - 6)
        }
      }
      ctx.globalAlpha = 1
    }

    const tick = (): void => {
      // 自转（未拖拽时）
      if (!state.dragging) {
        const rot = axisAngle(0, 1, 0, AUTO_ROTATE_SPEED)
        state.quat = quatMul(rot, state.quat)
      }
      render()
      rafId = requestAnimationFrame(tick)
    }
    tick()

    // ── 交互 ──
    const toCanvas = (e: PointerEvent): DragState => {
      const rect = canvas.getBoundingClientRect()
      return { lastX: e.clientX - rect.left, lastY: e.clientY - rect.top }
    }
    const hitTest = (px: number, py: number): string | null => {
      // 从后往前（投影已排序），命中最近（半径最大的）节点
      let best: { id: string; dist: number } | null = null
      for (const p of projected) {
        const dx = p.x - px
        const dy = p.y - py
        const hitR = Math.max(p.radius * 1.4, 8)
        const dist = Math.sqrt(dx * dx + dy * dy)
        if (dist <= hitR) {
          if (!best || dist < best.dist) best = { id: p.sn.id, dist }
        }
      }
      return best?.id ?? null
    }

    const onPointerDown = (e: PointerEvent): void => {
      state.dragging = true
      state.drag = toCanvas(e)
      canvas.setPointerCapture(e.pointerId)
    }
    const onPointerMove = (e: PointerEvent): void => {
      const pt = toCanvas(e)
      if (state.dragging) {
        const dx = pt.lastX - state.drag.lastX
        const dy = pt.lastY - state.drag.lastY
        // 拖拽旋转：水平拖拽绕 Y 轴，垂直拖拽绕 X 轴
        const rotY = axisAngle(0, 1, 0, dx * 0.006)
        const rotX = axisAngle(1, 0, 0, dy * 0.006)
        state.quat = quatMul(rotX, quatMul(rotY, state.quat))
        state.drag = pt
      } else {
        const id = hitTest(pt.lastX, pt.lastY)
        if (id !== state.hoveredId) {
          state.hoveredId = id
          canvas.style.cursor = id ? 'pointer' : 'grab'
        }
      }
    }
    const onPointerUp = (e: PointerEvent): void => {
      state.dragging = false
      const pt = toCanvas(e)
      const id = hitTest(pt.lastX, pt.lastY)
      if (id) onSelect(id)
    }
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      state.zoom = Math.min(2.2, Math.max(0.6, state.zoom * (e.deltaY < 0 ? 1.08 : 0.92)))
    }

    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      cancelAnimationFrame(rafId)
      ro.disconnect()
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('wheel', onWheel)
    }
  }, [nodes, links, highlight, selectedId, onSelect])

  return (
    <canvas
      ref={canvasRef}
      style={{ width: '100%', height: '100%', cursor: 'grab', touchAction: 'none', display: 'block' }}
      aria-label="记忆关系知识球"
    />
  )
}
