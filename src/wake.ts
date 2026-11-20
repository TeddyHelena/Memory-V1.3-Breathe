/**
 * 「唤醒」转场的**节奏层**（特效层另说）。
 *
 * 规格：`docs/wake-transition-spec.md`（抽自原型 10-10 定稿，⛔ 不凭记忆）。
 *
 * ## 两条硬规矩（原型踩过坑写的注释，这里照办）
 * ① **基础节奏不许挂 rAF** —— 原型实测：rAF 被节流 ⇒ 点"完成"看到纹丝不动的画面，**且不报错**。
 *    ⇒ 这里只用 `setTimeout` + CSS transition。特效层（canvas 粒子/飞行）才用 rAF，且**与节奏解耦**。
 * ② **时长只有一处**：CSS 的 `--fx-slide` 由 `TL.slide` 写进去，
 *    ⛔ 不在 CSS 里写死秒数（原型原话："TL 和 CSS 各写各的…又是一次'时间线错位'"）。
 *
 * 本文件是**纯逻辑**（不碰 DOM、不碰 canvas）⇒ 可单测、可断言顺序。
 */

/** 原型的时间线常量，**照抄不改**（`TL.speed` 是唯一的总旋钮） */
export const TL = {
  /** ★★ 总速度旋钮 ★★ —— 嫌快调小（0.8 = 整体慢 25%），嫌慢调大。**只改这一个数** */
  speed: 1.0,
  /** 大字由半透明提到实心 */
  solid: 240,
  /** ★ 停顿 —— 让眼睛看清"唤醒"这两个字。仪式感就是从这一段来的 */
  hold: 560,
  /** 画布从 DOM 手里接过这个字（接缝看不出来） */
  handoff: 150,
  /** 炸开 + 飞行。原型注：1050 太快 —— 弹簧的"前段"才是眼睛读到的速度 */
  flight: 1500,
  /** 整体回弹（落定后整团晃一下再稳） */
  settle: 320,
  /** 换场后右侧卡片滑入（含蒙版收掉） */
  slide: 1150,
} as const

/** 整场转场的总时长（**含 slide 本身**）—— 调度与测试都用它，⛔ 别各自算 */
export function wakeDuration(speed = TL.speed): number {
  const steps = wakeSchedule(speed)
  const start = steps.at(-1)!.at          // switch 与 slide 同刻
  return start + ms('slide', speed)
}

/** 按 `speed` 缩放后的毫秒数（`speed` 越大越快） */
export function ms(key: Exclude<keyof typeof TL, 'speed'>, speed = TL.speed): number {
  return Math.round(TL[key] / normalizedSpeed(speed))
}

/**
 * **把 `speed` 收敛到合法区间**（2026-10-14 对抗验证 F 修）。
 *
 * 修前 `ms()` 直接用传进来的 `speed` 做除数：
 *   · `speed = 0` / `NaN` / `Infinity` ⇒ 六步 `at` 全是 `NaN`
 *     ⇒ `setTimeout(fn, NaN)` 当 0 处理 ⇒ **整场转场静默消失**（不报错、只是没了）
 *   · `speed` 过大（≥15）⇒ `flight` 极短 ⇒ `springFor` 那边显式欧拉**发散**（实测超调 1e+47%）
 * ⇒ 这里夹到 `[0.25, 8]`：够用（4 倍慢 ~ 8 倍快），且保证下游拿到的是**有限正数**。
 */
function normalizedSpeed(speed: number): number {
  if (!Number.isFinite(speed) || speed <= 0) return TL.speed
  return Math.min(8, Math.max(0.25, speed))
}

export interface WakeStep {
  /** 从开始算起的时刻（毫秒） */
  at: number
  /** 这一步做什么（纯描述，供调度与测试断言） */
  what: 'solid' | 'handoff' | 'flight' | 'settle' | 'slide' | 'switch'
}

/**
 * 节奏表（**顺序与间隔就是规格**）。
 * ⛔ 改这里 = 改仪式感，先跟 作者 说。
 */
export function wakeSchedule(speed = TL.speed): WakeStep[] {
  const solid = ms('solid', speed)
  const hold = ms('hold', speed)
  const handoff = ms('handoff', speed)
  const flight = ms('flight', speed)
  const settle = ms('settle', speed)
  const slide = ms('slide', speed)
  let t = 0
  const out: WakeStep[] = []
  out.push({ at: t, what: 'solid' }); t += solid
  t += hold;      out.push({ at: t, what: 'handoff' }); t += handoff
  out.push({ at: t, what: 'flight' }); t += flight
  out.push({ at: t, what: 'settle' }); t += settle
  // 换场（同页切视图）与"卡片滑入"**同一时刻开始**：
  // 先切过去，卡片再滑进来 —— 所以 slide 的 at 是**起点**，不是终点。
  out.push({ at: t, what: 'switch' })
  out.push({ at: t, what: 'slide' })
  return out.sort((a, b) => a.at - b.at)
}

export interface WakeHandle {
  /** ⛔ 唯一入口：跳过与异常都走它（规格第 6 点：异常路径走同一个 cleanup） */
  cleanup: () => void
  /** 立刻结束并直达终点（点一下/按键 = 跳过） */
  skip: () => void
}

/**
 * 跑一次转场。
 * @param onStep 每一步的回调（渲染层用它切换视觉状态）
 * @param onDone 到达终点（视图已切换完）——**保证只调一次**
 *
 * ⛔ 规格第 7 点：**跳过监听要延后一拍**（否则"点击开始"的那一次点击会把自己当成跳过）。
 */
export function runWake(onStep: (s: WakeStep) => void, onDone: () => void, speed = TL.speed): WakeHandle {
  const timers: Array<ReturnType<typeof setTimeout>> = []
  let finished = false
  const finish = (): void => {
    if (finished) return
    finished = true
    for (const t of timers) clearTimeout(t)
    timers.length = 0
    onDone()
  }
  for (const step of wakeSchedule(speed)) {
    timers.push(setTimeout(() => onStep(step), step.at))
  }
  const total = wakeDuration(speed) + 50
  timers.push(setTimeout(finish, total))
  return { cleanup: finish, skip: finish }
}
