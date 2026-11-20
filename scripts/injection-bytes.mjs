#!/usr/bin/env node
/**
 * ⭐ **每轮注入字符/token 的测量器**（2026-10-15 建）
 *
 * ## 为什么会有这个文件
 *
 * 验收② 的「字节面」原本**有读数、无仪器**：`lite-baseline.mjs` 印的
 * `现值 4,927 字符 ≈ 1,642 token` 是 **10-10 长任务压测**的读数（`PERF-V1.3.md:9`），
 * 而那一行 `console.log` **只是把它硬编码打印**——**全仓没有任何脚本能量它**。
 * ⇒ 尺子上钉着一个 5 天前的数，**没人能复测** ⇒ 字节面**不可判定**。
 *
 * ⇒ 本文件补上那台仪器：**走生产的装配入口**（`renderHotBlockDetailed` / `renderHotSummaryDetailed`
 * / `renderVoice`，与 `src/index.ts:1839` 注入时用的是同一处），⛔ 不另写一套算法。
 *
 * ## 口径
 *
 * | 量 | 来源 |
 * |---|---|
 * | **全量形态** | `renderHotBlockDetailed`（`personaMode: full`） |
 * | 摘要形态 | `renderHotSummaryDetailed`（体积受限时的回退） |
 * | 声音层 | `renderVoice(voice.md)`（若配了 `voiceFile`） |
 * | token 估算 | `字符 ÷ 3`（与 `PERF-V1.3.md` 的 4,927 ≈ 1,642 同口径：1642×3 = 4926 ✓） |
 *
 * ⛔ **只读**：只 `load()` + render，⛔ 不写容器、⛔ 不碰生产（默认对**副本**跑，见 `--root`）。
 *
 * 用法：
 *   node scripts/injection-bytes.mjs --root <副本容器>
 *   node scripts/injection-bytes.mjs --root <副本> --max-chars 16000 --voice voice.md
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const argv = process.argv.slice(2)
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}

const DEFAULT_ROOT = path.join(
  os.homedir(),
  'Documents/Obsidian Vault/00_记忆系统/dsh-memory-container',
)
const ROOT = arg('root', DEFAULT_ROOT)
const MAX_CHARS = Number(arg('max-chars', '16000'))
const VOICE_FILE = arg('voice', 'voice.md')
const BASELINE = Number(arg('baseline', '4927')) // PERF-V1.3 的 10-10 读数

const lib = (p) => new URL(`../lib/${p}`, import.meta.url).href
const { MemoryContainer } = await import(lib('container.js'))
const { renderHotBlockDetailed, renderHotSummaryDetailed, renderVoice } = await import(lib('persona.js'))

const c = new MemoryContainer(ROOT)
c.load()

const codeUnits = (s) => [...s].length // 按**码点**数（中文 1 个码点 = 1 字符）
const tok = (n) => Math.round(n / 3) // 与 PERF-V1.3 同口径

const full = renderHotBlockDetailed(c, { maxChars: MAX_CHARS })
const sum = renderHotSummaryDetailed(c, { maxChars: MAX_CHARS })

let voiceLen = 0
let voiceNote = ''
try {
  const vp = path.join(ROOT, VOICE_FILE)
  if (fs.existsSync(vp)) {
    voiceLen = codeUnits(renderVoice(fs.readFileSync(vp, 'utf-8')))
    voiceNote = VOICE_FILE
  } else {
    voiceNote = `${VOICE_FILE}（不存在，计 0）`
  }
} catch (e) {
  voiceNote = `读不到（${String(e?.message ?? e).slice(0, 40)}）`
}

const total = codeUnits(full.text) + voiceLen

console.log('  每轮注入字节测量（只读 · 走生产装配入口）')
console.log(`    容器            ${ROOT}`)
console.log(`    上限            maxChars=${MAX_CHARS}`)
console.log('')
console.log(`    全量形态        ${codeUnits(full.text)} 字符 ≈ ${tok(codeUnits(full.text))} token  ｜ 含 ${full.includedIds.length} 条${full.truncated ? '（已截断）' : ''}`)
console.log(`    摘要形态        ${codeUnits(sum.text)} 字符 ≈ ${tok(codeUnits(sum.text))} token  ｜ 含 ${sum.includedIds.length} 条${sum.truncated ? '（已截断）' : ''}`)
console.log(`    声音层          ${voiceLen} 字符 ≈ ${tok(voiceLen)} token  ｜ ${voiceNote}`)
console.log(`    ─────────────────────────────────────────`)
console.log(`    **合计（全量+声音）  ${total} 字符 ≈ ${tok(total)} token**`)
console.log('')
const delta = total - BASELINE
const pct = BASELINE ? ((delta / BASELINE) * 100).toFixed(1) : '—'
console.log(`    对照尺子值      ${BASELINE} 字符（PERF-V1.3 · 10-10 读数）⇒ 差 ${delta >= 0 ? '+' : ''}${delta}（${pct}%）`)
console.log(`    ⚠️ 尺子值原先**无仪器可复测**（硬编码在 lite-baseline）；本仪器即为复测入口。`)
if (full.truncated || sum.truncated) console.log('    ⚠️ 有形态触到上限 ⇒ 预算在起作用（不是"没超"，是"被截到上限"）')
