/**
 * 「唤醒」转场的**视觉层**（节奏在 `src/wake.ts`，特效数学在 `src/wake-fx.ts`，两者都是纯逻辑、有测试）。
 *
 * 规格：`docs/wake-transition-spec.md`。这一层只负责**画**，不负责**何时**。
 * ⛔ 时长一律走 CSS 变量 / 内联 ms（值来自 `TL`），⛔ 不在这里写死秒数。
 *
 * ## 特效层（2026-10-14 补）
 * 修前 `flight` 只是"轻微上浮 + 放大"的 **CSS 近似**，**没有画布**
 * （截图证据：四个 phase 全 `hasCanvas=false`）。现在按 spec 补齐：
 * - `handoff`：**画布从 DOM 手里接过这个字** —— 量出 DOM 字形的 rect 与字体，按同样参数画到画布上，
 *   再把 DOM 那层隐掉（⛔ 顺序不能反：先量后隐，否则量到的是 0×0）
 * - `flight`：字形炸成药粒子，按 `wake-fx` 标定出的弹簧飞向落点（`WAKE_LANDING`）
 * - `settle`：落定后按 `settleBump` **晃一下**
 *
 * ## 两条硬约束
 * ① **节奏层不挂 rAF**（spec §二 第 1 条）—— rAF **只在本文件**（特效层），且与节奏解耦：
 *    节奏由 `runWake` 的 setTimeout 决定，这里只负责"当前相位把画面画成什么样"。
 * ② **异常路径走同一个 cleanup**（spec §五 第 6 点）⇒ 本文件只有**一个** `cleanup()`，
 *    skip / 相位结束 / 组件卸载 / 出错**全走它**，⛔ 不许两套清理逻辑。
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { TL } from '../wake.js'
import {
  FIELD,
  burstAt,
  travelAt,
  landingOffsets,
  landingRect,
  particleField,
  settleBump,
  springFor,
} from '../wake-fx.js'

export type WakePhase = 'solid' | 'handoff' | 'flight' | 'settle' | 'slide'

export interface WakeOverlayProps {
  phase: WakePhase
  /** 点一下 = 跳过（规格第 7 点：监听由调用方**延后一拍**挂，避免把"开始"那次点击当成跳过）*/
  onSkip: () => void
  /**
   * **调参口（可选）**：只给开发页/对照表用，⛔ 生产调用方不传 ⇒ 走下面的常量，行为一字不变。
   * 存在的原因：`spread` / 粒子数这类是**审美参数**，光靠描述定不了，得摆出来给人挑。
   */
  fx?: { spread?: number; particles?: number }
}

/** 字形参数：⛔ 只在这里定义一份，画布与 DOM 两处都从这里取值（否则"接手"那一下会错位） */
const GLYPH = { text: '唤醒', size: 34, weight: 600, letterSpacing: 6 } as const

const T = {
  bg: 'var(--dsw-alias-bg-base, #fff)',
  text: 'var(--dsw-alias-label-primary, #0f1115)',
  text2: 'var(--dsw-alias-label-secondary, #61666b)',
}

/** 粒子数：多了糊、少了空。固定值（⛔ 不随卡片尺寸变 —— spec §五 第 3 点要的是**固定窗口**）*/
const PARTICLES = 170
/** 固定种子：粒子场必须可复现（截图回归的前提，见 `wake-fx.ts` 的 rng 注释）*/
const SEED = 20261014

export function WakeOverlay({ phase, onSkip, fx }: WakeOverlayProps): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const glyphRef = useRef<HTMLDivElement | null>(null)
  const hostRef = useRef<HTMLDivElement | null>(null)
  // solid：大字由**半透明提到实心**（TL.solid）；handoff 起**画布接手** ⇒ DOM 那层隐掉
  const takenOver = phase !== 'solid'

  useEffect(() => {
    const canvas = canvasRef.current
    const host = hostRef.current
    if (!canvas || !host) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const rect = host.getBoundingClientRect()
    canvas.width = Math.max(1, Math.round(rect.width * dpr))
    canvas.height = Math.max(1, Math.round(rect.height * dpr))
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    // ⛔ 先量 DOM 字形，再隐 —— 顺序反了就量到 0×0（接手那一刻会错位）
    const g = glyphRef.current?.getBoundingClientRect()
    const glyph = {
      cx: g && g.width > 0 ? g.left - rect.left + g.width / 2 : rect.width / 2,
      cy: g && g.height > 0 ? g.top - rect.top + g.height / 2 : rect.height / 2,
    }
    // 落点：由**单一定义处** `WAKE_LANDING` 推（spec §五 第 1 点：幽灵布局 = 最终布局）
    //   容器原点 = 宿主左上角（宿主 `inset:0` ⇒ 即球卡范围）
    const land = landingRect({ left: 0, top: 0 })

    // 固定逻辑窗口 → 画布坐标：以字形为中心摆放，⛔ 不用卡片尺寸去缩放（那会让粒子窗口随卡片变）
    const fieldScale = Math.min(1, (rect.width * 0.9) / FIELD.w)
    const fieldW = FIELD.w * fieldScale
    const fieldH = FIELD.h * fieldScale
    // ⛔ 调参口只影响"摆出来看"的那一份；不传就是常量（生产路径不走这里）
    const count = fx?.particles ?? PARTICLES
    const parts = particleField(count, SEED, fx?.spread)
    const targets = landingOffsets(count, SEED)
    // ⛔ 每个粒子**各自的**落点（铺满落点圆），不是全收进圆心 —— 否则末态是个点、
    //    settle 一来变成大圆 = "终点跳"（实测末帧只剩 12 像素，见 wake-fx.ts 的注释）

    // ⛔ 不写死秒数：只从 TL 取，speed 是唯一总旋钮
    const flightMs = TL.flight / TL.speed
    const settleMs = TL.settle / TL.speed
    const spring = springFor(flightMs)
    const color = getComputedStyle(host).getPropertyValue('color') || '#0f1115'

    let raf = 0
    let t0 = performance.now()

    const drawGlyph = (alpha: number): void => {
      ctx.globalAlpha = Math.max(0, Math.min(1, alpha))
      ctx.font = `${GLYPH.weight} ${GLYPH.size}px inherit`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = color
      ctx.fillText(GLYPH.text, glyph.cx, glyph.cy)
      ctx.globalAlpha = 1
    }

    const frame = (now: number): void => {
      const t = now - t0
      ctx.clearRect(0, 0, rect.width, rect.height)
      if (phase === 'handoff') {
        // 接手那一拍：按 DOM 一模一样的字号/字重/字距画 ⇒ 接缝看不出来
        drawGlyph(1)
      } else if (phase === 'flight') {
        // ⛔ **两段接力**（spec：炸开 + 飞行）：
        //    前 28% = 从字形中心炸到各自的场位置；之后才由弹簧拉着飞向落点。
        //    第一版合成一段 ⇒ 实测 150ms 整团已经飘到左上角 = 看着像平移，炸开根本没发生。
        const travel = travelAt(t, flightMs, spring)
        if (travel < 0.5) drawGlyph(1 - travel / 0.5)   // 字形随飞行进度淡出，粒子接上
        for (let i = 0; i < parts.length; i++) {
          const pt = parts[i]
          // ① 炸开：字形中心 → 场位置（每个粒子按自己的 delay 起爆 ⇒ 从中心"炸"出去）
          const b = burstAt(t - pt.delay * flightMs * 0.5, flightMs)
          const fx = glyph.cx + pt.bx * (fieldW / 2) * b
          const fy = glyph.cy + pt.by * (fieldH / 2) * b
          // ② 飞行：炸开的位置 → 它自己的落点（圆面积内均匀）
          const tx = land.x + targets[i].dx * land.r
          const ty = land.y + targets[i].dy * land.r
          const x = fx + (tx - fx) * travel
          const y = fy + (ty - fy) * travel
          // 半径**不要缩没**（末态要能撑住那个圆的视觉尺寸）；只轻微收一点
          ctx.globalAlpha = Math.max(0.35, 1 - 0.4 * travel)
          ctx.beginPath()
          ctx.arc(x, y, Math.max(0.6, pt.size * (1 - 0.15 * travel)), 0, Math.PI * 2)
          ctx.fillStyle = color
          ctx.fill()
        }
        ctx.globalAlpha = 1
      } else if (phase === 'settle') {
        // 落定后**晃一下**（spec："整体回弹 —— 晃一下就稳"）
        const bump = settleBump(t, settleMs)
        ctx.save()
        ctx.translate(land.x, land.y)
        ctx.scale(1 + bump, 1 + bump)
        ctx.translate(-land.x, -land.y)
        ctx.beginPath()
        ctx.arc(land.x, land.y, land.r, 0, Math.PI * 2)
        ctx.fillStyle = color
        ctx.fill()
        ctx.restore()
      }
      raf = requestAnimationFrame(frame)
    }
    t0 = performance.now()
    raf = requestAnimationFrame(frame)

    /** ⛔ **唯一的** cleanup：skip / 相位结束 / 卸载 / 出错全走它（spec §五 第 6 点）*/
    return (): void => {
      cancelAnimationFrame(raf)
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
    }
  }, [phase])

  return (
    <div
      ref={hostRef}
      onClick={onSkip}
      style={{
        position: 'absolute', inset: 0, zIndex: 40, background: T.bg,
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 14,
        cursor: 'pointer',
        transition: `opacity ${TL.handoff}ms ease`,
      }}
      title='点一下跳过'
    >
      {/* 字形：solid 由 DOM 画（半透明 → 实心）；handoff 起**画布接手** ⇒ 这层隐掉 */}
      <div
        ref={glyphRef}
        style={{
          fontSize: GLYPH.size, fontWeight: GLYPH.weight, letterSpacing: GLYPH.letterSpacing,
          color: T.text,
          opacity: takenOver ? 0 : 1,
          transition: `opacity ${TL.solid}ms ease`,
        }}
      >{GLYPH.text}</div>
      {/* ⚠️ 覆盖层**保守判定**（规格第 5 点）：只在 handoff 之后才出现转圈，
          免得"转圈 + 转场"叠着。这里 handoff 阶段显示的是"交接"提示，不是 spinner。 */}
      {phase === 'handoff' && (
        <div style={{ fontSize: 13, color: T.text2, transition: `opacity ${TL.handoff}ms ease` }}>正在交给它…</div>
      )}
      {/* 特效层画布：覆盖整个面板，⛔ 不吃点击（跳过仍由外层 div 负责）*/}
      <canvas
        ref={canvasRef}
        data-wake-canvas
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
      />
      <div style={{ position: 'absolute', bottom: 22, fontSize: 11.5, color: T.text2, opacity: 0.7 }}>
        点一下跳过
      </div>
    </div>
  )
}
