/**
 * 知识球 / 平面图的纯数学工具：零依赖，纯函数。
 * 球体：fibonacci 球面分布 + 透视投影 + 四元数旋转（自转 + 拖拽）。
 * 平面：简单力导向（斥力 + 弹簧 + 中心约束）。
 */

/** 层类型（与 host types.ts 对齐，client 侧内联避免跨 rootDir 引用） */
export type Layer = 'hot' | 'archive' | 'longterm' | 'pending'

/** 3D 向量 */
export interface Vec3 {
  x: number
  y: number
  z: number
}

/** 球面节点（未投影，3D 坐标） */
export interface SphereNode {
  id: string
  layer: Layer
  /** 球面上位置（单位向量 × 半径） */
  pos: Vec3
}

/** 透视投影后的 2D 点 */
export interface Projected2D {
  x: number
  y: number
  /** 视深（越大越近），用于 z 排序和透明度 */
  depth: number
  /** 屏幕半径（按深度缩放） */
  radius: number
}

/** 简单四元数（用于球体旋转） */
export interface Quat {
  w: number
  x: number
  y: number
  z: number
}

/**
 * 层 → 球壳半径比例（hot 最近、longterm 中层、archive 外层）。
 * pending（候选）单独一圈、贴在球壳最外——语义就是「还没进记忆本体」。
 * 注意：host 侧当前把候选挡在图外（graph.ts），这一圈通常恒空；
 * 留着是为了 client 认得这一层，host 哪天放开也不用动渲染。
 */
const LAYER_RADIUS: Record<Layer, number> = {
  hot: 1.0,
  longterm: 1.35,
  archive: 1.7,
  pending: 1.95,
}

/**
 * 参与绘制的层顺序（内 → 外）。**加新层只改这一处**——
 * 分桶、球面分布、平面环形铺开全读它，别再写死第二张层表。
 */
const LAYER_ORDER: readonly Layer[] = ['hot', 'longterm', 'archive', 'pending']

/**
 * 按层分桶（渲染前置）。未知层就地建桶、**只收不画**，绝不抛异常。
 *
 * 为什么要有兜底：V1.0 的候选层就是在这里炸的——层表写死三个 key，
 * host 多发了 `pending`，`idsByLayer[node.layer].push` 抛 TypeError，
 * 异常被设置页的错误边界接住，整个「记忆」插槽白屏（知识球/平面图/列表一起没）。
 * 类型没跟上就运行时炸，是 tsdown 不查类型的债；这个函数把它堵死在运行时。
 */
export function bucketByLayer(
  nodes: readonly { readonly id: string; readonly layer: string }[],
): Record<string, string[]> {
  const buckets: Record<string, string[]> = {}
  for (const layer of LAYER_ORDER) buckets[layer] = []
  for (const node of nodes) {
    const bucket = buckets[node.layer] ?? (buckets[node.layer] = [])
    bucket.push(node.id)
  }
  return buckets
}

/** fibonacci 球面分布：n 个点在单位球面上均匀分布（golden spiral） */
function fibonacciSphere(n: number): Vec3[] {
  const points: Vec3[] = []
  if (n <= 0) return points
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2
    const radius = Math.sqrt(Math.max(0, 1 - y * y))
    const theta = golden * i
    points.push({
      x: Math.cos(theta) * radius,
      y,
      z: Math.sin(theta) * radius,
    })
  }
  return points
}

/** 把 id 列表按层分组后，每层做 fibonacci 分布，返回球面节点 */
export function layoutSphereLayers(
  idsByLayer: Record<Layer, string[]>,
  baseRadius: number,
): SphereNode[] {
  const result: SphereNode[] = []
  for (const layer of LAYER_ORDER) {
    const ids = idsByLayer[layer]
    if (!ids || ids.length === 0) continue
    const dirs = fibonacciSphere(ids.length)
    const r = baseRadius * LAYER_RADIUS[layer]
    ids.forEach((id, i) => {
      const d = dirs[i]!
      result.push({ id, layer, pos: { x: d.x * r, y: d.y * r, z: d.z * r } })
    })
  }
  return result
}

/** 四元数乘法 */
export function quatMul(a: Quat, b: Quat): Quat {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  }
}

/** 轴角 → 四元数 */
export function axisAngle(ax: number, ay: number, az: number, angle: number): Quat {
  const half = angle / 2
  const s = Math.sin(half)
  return { w: Math.cos(half), x: ax * s, y: ay * s, z: az * s }
}

/** 用四元数旋转向量 */
function rotateVec(q: Quat, v: Vec3): Vec3 {
  const { w, x, y, z } = q
  const { x: px, y: py, z: pz } = v
  // v' = q * v * q⁻¹（q 已归一）
  const ix = w * px + y * pz - z * py
  const iy = w * py + z * px - x * pz
  const iz = w * pz + x * py - y * px
  const iw = -x * px - y * py - z * pz
  return {
    x: ix * w + iw * -x + iy * -z - iz * -y,
    y: iy * w + iw * -y + iz * -x - ix * -z,
    z: iz * w + iw * -z + ix * -y - iy * -x,
  }
}

/** 透视投影：把球面节点（单位坐标）投影到 2D 屏幕。
 * node.pos 是单位球坐标（已乘 layer 半径系数 1/1.35/1.7），
 * 内部按 baseRadius 放大；focal 是相机焦距（固定值，相对单位深度）。 */
export function projectNode(
  node: SphereNode,
  q: Quat,
  canvasW: number,
  canvasH: number,
  baseRadius: number,
  focal: number,
): Projected2D {
  const rotated = rotateVec(q, node.pos)
  // 相机在 +z 远处看向原点；z 越大越近（范围约 ±1.7）
  const depth = rotated.z
  // focal=4.5 时 scale 范围 ≈ 0.72~1.61，透视柔和
  const scale = focal / (focal - depth)
  const r = (node.layer === 'hot' ? 8 : 6.5) * scale
  return {
    x: canvasW / 2 + rotated.x * baseRadius * scale,
    y: canvasH / 2 - rotated.y * baseRadius * scale,
    depth,
    radius: r,
  }
}

/** 平面图节点（力导向 2D） */
export interface FlatNode {
  id: string
  layer: Layer
  x: number
  y: number
  vx: number
  vy: number
}

/** 平面图边 */
export interface FlatLink {
  source: string
  target: string
  type: 'hot' | 'group' | 'tag'
}


/** 力导向迭代参数 */
export interface ForceParams {
  /** 斥力强度（线性衰减：force = repulsion / dist） */
  repulsion: number
  /** 弹簧强度（边） */
  spring: number
  /** 弹簧自然长度 */
  restLength: number
  /** 中心约束强度 */
  centering: number
  /** 速度衰减 */
  damping: number
  /** 斥力作用最小距离（小于此距离封顶，防爆） */
  minDist: number
  /** 斥力作用最大距离（大于此距离忽略，降 O(n²) 噪声） */
  maxDist: number
  /** 节点距中心的最大允许距离（超出被拉回，保证图留在画布） */
  bounds: number
}


/** 冷却参数：力的注入量随帧衰减（真正的模拟退火） */
export interface CoolingParams {
  /** 冷却开始的帧数 */
  startFrame: number
  /** 冷却结束的帧数（之后力衰减到最小） */
  endFrame: number
  /** 初始力注入系数 */
  startScale: number
  /** 最终力注入系数（接近 0 则系统静止） */
  endScale: number
}

const DEFAULT_COOLING: CoolingParams = {
  startFrame: 20,
  endFrame: 220,
  startScale: 1,
  endScale: 0.02,
}


