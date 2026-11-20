/**
 * checksum.ts —— 条目正文完整性（V1.3-A · G3）
 *
 * ── 治的是什么病 ────────────────────────────────────────────────────
 * `checksum` 这个 frontmatter 字段**在仓库里存在很久了，但从来没有人算过它、也没有人验过它**：
 * 写入时写 `''`，改内容时置 `''`，读的时候原样带过。生产容器里 69 条有值，
 * 全是历史遗留的 `v3:` —— 用 sha256(body) 的常见变体**一条都复现不出来**（69 条全试过，
 * 命中 0），所以连"它当初算的是什么"都无从考证。
 *
 * ⇒ 现状是"**看起来有完整性，实际没有**"。这类空壳比明着没有更坏：它让人以为有防线。
 *
 * 先红证据（2026-10-09 实测）：改掉 `h01` 的正文、`checksum` 保持原样，然后
 *   · `container.load({verify:true})` → 通过，无告警
 *   · 投影漂移 0 ／ 数据缺口 0 ／ 不可重建遗留 16 ／ `drift-audit` C 段全绿
 * **三个出口全哑。**
 *
 * ── 本模块的口径（最小版 · 只做两件事）──────────────────────────────
 *   ① **写入即算**：凡是**改动了正文**的写路径（新建 / 内容补丁）都算一次校验和
 *   ② **启动即验**：`load({verify:true})` 本来就要逐条读文件解析，校验**复用那一趟**
 *      ⇒ **零额外 I/O**（这是 C1 约束的落地方式，比"抽个样看看"更强）
 *
 * ── 三条不许违反的纪律 ──────────────────────────────────────────────
 *   ① **只在正文被改写时重算**。`stampV12Fields`（路由 touch）**不许动 checksum** ——
 *      否则"改了正文再 touch 一下"就能把篡改痕迹**洗白**，校验和当场失去证据价值。
 *   ② **验不过不许拦启动**（C3）：只报，⛔ 不 fail-fast —— 容器不能被自己的校验写死，
 *      这条在 2026-09-15 / 10-06 已经栽过两次。
 *   ③ **不可验证的要如实说**：`v3:` 与空值**不算通过也不算失败**，
 *      单独计数（`unverifiable`）。⛔ 不许混进"通过"里把读数做好看。
 */

import { createHash } from 'node:crypto'

/**
 * 算法版本前缀。**换算法必须换前缀** —— 否则新旧值混在一张表里，
 * "验不过"到底是篡改还是换了算法，没人分得清（`v3:` 那批就是这么变成考古问题的）。
 */
const CHECKSUM_PREFIX = 'v4:'

/**
 * 算法：`v4:` ＋ `sha256(正文)` 的前 16 位十六进制。
 *
 * 算的是**正文**（frontmatter 之后的部分），与 `parseEntryFile()` 返回的 `content` 同口径。
 * 两边都 `trim()`：写盘时文件里是 `\n\n${content}\n`，读回来会被 `trim()`，
 * 不统一口径的话算出来的值必然对不上——这类"自己跟自己不一致"的坑本仓踩过不止一次。
 */
export function computeChecksum(content: string): string {
  const hex = createHash('sha256').update(content.trim(), 'utf-8').digest('hex')
  return `${CHECKSUM_PREFIX}${hex.slice(0, 16)}`
}

/** 这个值是不是本模块能验的格式（`v4:` 开头且有 16 位十六进制） */
function isVerifiableChecksum(recorded: string | undefined): boolean {
  return typeof recorded === 'string' && /^v4:[0-9a-f]{16}$/.test(recorded)
}

export type ChecksumVerdict = 'ok' | 'mismatch' | 'unverifiable'

/**
 * 验一条：**`mismatch` 才是真信号**（正文被改动过而校验和没跟上）。
 * `unverifiable` = 旧格式 / 空值 —— 如实单独报，⛔ 不当作通过。
 */
export function verifyChecksum(recorded: string | undefined, content: string): ChecksumVerdict {
  if (!isVerifiableChecksum(recorded)) return 'unverifiable'
  return recorded === computeChecksum(content) ? 'ok' : 'mismatch'
}
