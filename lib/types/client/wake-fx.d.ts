/**
 * 「唤醒」转场的**特效层（纯逻辑）**——规格 `docs/wake-transition-spec.md`。
 *
 * ## 为什么单独一个文件
 * 与 `wake.ts` 同款分工：**纯逻辑可单测、可断言**，画布只负责把这里算出来的东西画出来。
 * ⛔ 本文件**不碰 DOM、不碰 canvas、不挂 rAF**（那些在 `WakeOverlay.tsx`）。
 *
 * ## spec §五 七点里，这一层要对的四点
 * ① **幽灵布局必须 = 最终布局**（否则飞行终点会跳）⇒ `WAKE_LANDING` 是**唯一定义处**，
 *    胶囊的几何从它取值 ⇒ "相等"是**构造出来的**，不是"碰巧对上"。
 * ② **弹簧参数与 flight/settle 的时间尺度匹配** ⇒ `springFor()` 按 T_L 反解，
 *    并由测试断言"在 flight 内落定且超调有界"。
 * ③ **粒子窗口固定**（别随卡片尺寸变）⇒ `FIELD` 是固定逻辑窗口，粒子在其中撒点，
 *    ⛔ 不拿卡片宽高去乘。
 * ④ **过渡初值**（不同元素的起始态规则不同）⇒ `initialParticle()` 按"从字形上炸开"给初值。
 */
/** 固定粒子窗口（逻辑尺寸，与卡片无关）——spec §五 第 3 点 */
export declare const FIELD: {
    readonly w: 520;
    readonly h: 260;
};
/**
 * **落点几何（唯一定义处）**——spec §五 第 1 点。
 *
 * 数值来源：`MemoryPanel.tsx` 里 `.who` 胶囊的实测几何——
 * 胶囊 `left:14 top:12`、内边距 `5px`、头像 `34×34` ⇒ 头像相对球卡 = `(19, 17, 34)`。
 * ⛔ 胶囊那几处**必须从这里取值**（`import { WAKE_LANDING }`），
 *   否则"幽灵布局 = 最终布局"就退化成"两份各自写、改一处就错位"
 *   —— 原型为这事专门留了注释（"TL 和 CSS 各写各的…又是一次时间线错位"）。
 */
export declare const WAKE_LANDING: {
    /** 胶囊相对球卡左上角的偏移 */
    readonly capsule: {
        readonly left: 14;
        readonly top: 12;
    };
    /** 胶囊内边距（四边同值；头像左/上各再让这么多） */
    readonly pad: 5;
    /** 头像直径 */
    readonly avatar: 34;
};
/** 头像相对容器左上角的落点矩形 */
export declare function landingRect(container: {
    left: number;
    top: number;
}): {
    x: number;
    y: number;
    r: number;
};
export interface Particle {
    /**
     * **炸开偏移**：相对字形中心，单位是"半个场宽/场高"（∈ [-1, 1]）。
     * 落点不在这里 —— 落点由 `landingOffsets` 单独给（圆面积内均匀撒点）。
     * 两者分开的原因见 `burstAt` 的注释：炸开与飞行是**两段**，
     * 硬塞进一个插值里会变成"整体平移"（第一版实测就是这样）。
     */
    bx: number;
    by: number;
    /** 大小（px）与相位偏移（让粒子不同步） */
    size: number;
    delay: number;
}
/**
 * 生成粒子场（spec §五 第 3/4 点）。
 *
 * 初值规则：从**字形附近**炸开（`spread` 控制散开半径），目标收敛到**落点半径内**。
 * ⛔ 全部在固定窗口 `FIELD` 里算 ⇒ 与卡片尺寸无关。
 */
/**
 * ⚠️ **审美参数，不是数学参数**：`spread` 决定炸开多大。
 * 0.18 实测像"一坨密集的疙瘩"（170 个粒子挤在 73×24 里互相盖住），
 * 调到 0.32 才读得出"炸开"。**这个值该由 Teddy 的眼睛定** ——
 * 我能验的是"炸开发生了、终点不跳"，验不了"好不好看"。
 */
export declare function particleField(count: number, seed: number, spread?: number): Particle[];
/**
 * **落点内部的逐个目标点**（spec §五 第 1 点：幽灵布局 = 最终布局）。
 *
 * ## 为什么不是"全部收进同一个坐标"
 * 我第一版让 170 个粒子**收敛到落点圆心同一个坐标**、半径还缩到 <2px ⇒
 * 实测末帧只剩 **12 个像素（4×4 的点）**，而紧接着 `settle` 画的是 **34px 实心圆**
 * ⇒ **一个点突然变成一个大圆 = "终点跳"**，正是 spec §五 第 1 点要防的那类抖动。
 *
 * ## 改法
 * 每个粒子有自己的落点（**圆面积内均匀撒点**，`r = R·√u` 保证不是往圆心堆），
 * 末态 = 一团铺满落点圆的粒子 ⇒ 与 `settle` 的实心圆**尺寸连续**，只是密度变化。
 * ⛔ 仍然是确定性的（同种子同结果）⇒ 可做像素级回归。
 */
export declare function landingOffsets(count: number, seed: number, maxR?: number): Array<{
    dx: number;
    dy: number;
}>;
export interface SpringParams {
    /** 角频率 ω₀（rad/s） */
    omega: number;
    /** 阻尼比 ζ */
    zeta: number;
}
/**
 * 按 `flight` / `settle` 的时间尺度**反解**弹簧参数（spec §五 第 2 点）。
 *
 * 依据：二阶系统的**落定时间** ≈ `4 / (ζ·ω₀)`（2% 判据）。
 * 取 ζ = 0.86（轻微超调 —— 原型注："弹簧的**前段**才是眼睛读到的速度"），
 * 令落定时间 ≈ `flight` 的 0.8 倍（留出 settle 那段回弹）。
 * ⛔ 这里**不写死秒数**，一切从传进来的 `flightMs` 推。
 */
export declare function springFor(flightMs: number, zeta?: number): SpringParams;
/**
 * **settle 的"晃一下"**（spec：整体回弹 —— 落定后整团晃一下再稳）。
 *
 * ## 为什么要有它（不是装饰）
 * 我第一版把 flight 的弹簧调到 ζ=0.86 ⇒ 1500ms 时超调只剩 **0.44%**、完全收敛
 * ⇒ **settle 那 320ms 是空的**（什么都没发生）。而 spec 明写 settle 是"回弹/晃一下再稳"。
 * ⇒ flight 负责"飞到位"，settle 负责"落定后那一下" —— 两段各有各的活。
 *
 * ## 形状
 * 衰减正弦：`A·e^(−5t/T)·sin(2π·1.5·t/T)` ⇒ settle 内约 **1.5 个来回**、末了衰减到 ~0.7%。
 * 幅度 A = 3.5%（作用在整团 scale 上）——够看见，不至于晃得花。
 */
export declare function settleBump(tMs: number, settleMs: number, amplitude?: number): number;
export interface SpringState {
    p: number;
    v: number;
}
/** 一步半隐式欧拉积分（稳定、可复现；⛔ 不用解析解 —— 要的就是"前段快、后段收"的手感） */
/**
 * **炸开进度**（spec 对 flight 的原话是"**炸开 + 飞行**" —— 这是两段，不是一段）。
 *
 * ## 为什么必须拆开
 * 我第一版让粒子位置 = `起点 → 落点` 一条弹簧插值到底。
 * 实测截图（150ms 那帧）：粒子**整体已经飘到左上角**了，
 * 而落点在 (19,17)、字形在 (640,410) —— 距离 621px，
 * 弹簧走了 16% 就已经把整团拽过去 ~100px ⇒ **眼睛看到的是"平移"，不是"炸开"**。
 * 炸开那一段（粒子从字形向外散）**根本没发生**。
 *
 * ## 形状
 * 前 `burstFrac`（默认 28%）段用 easeOutCubic 把粒子从**字形中心**推到它的**场位置**；
 * 之后才由 `travelAt` 接管飞向落点。两段接力，中间不跳（两者在交界处都接近各自端点）。
 */
export declare function burstAt(tMs: number, flightMs: number, burstFrac?: number): number;
/**
 * **飞行进度**：炸开之后再开始（`delayFrac` 与 `burstAt` 的 `burstFrac` 重叠一小段，
 * 让"散开"和"起飞"有交叠、不生硬），到 `flight` 末落定。
 */
export declare function travelAt(tMs: number, flightMs: number, spring: SpringParams, delayFrac?: number): number;
/**
 * 把弹簧积分到时刻 `t`（毫秒），返回 0..1 的进度。
 * 采样步长固定 4ms ⇒ **同一 t 必然得到同一结果**（可复现、可截图回归）。
 */
export declare function flightProgress(tMs: number, flightMs: number, k: SpringParams): number;
/** 粒子在时刻 `t`（毫秒）的位置——`flight` 段用弹簧，起止由 `delay` 错开 */
