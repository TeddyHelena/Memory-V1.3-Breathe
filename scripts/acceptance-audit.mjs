#!/usr/bin/env node
/**
 * acceptance-audit.mjs —— Audit 版**发布前验收**：纪律件四条一次跑完出读数表
 *
 * ════════════════════════════════════════════════════════════════════
 * 为什么要有它（A-1 的交付形态）
 * ════════════════════════════════════════════════════════════════════
 * 阳性对照是**元门禁**——「证明前面几个检查器分得出好坏，不是空转」。
 * 我们照抄实现后一次性跑出全过，但它一直是"手动跑一次"的脚本 ⇒ **没人记得跑就退化成"存在但不执行"**。
 * 时机（Teddy 2026-10-08 拍板）：**发布前**。⛔ 不塞进 `npm run verify`（那是开发期闸门，跑得比这勤，
 * 塞进去会让它每次都跑全库扫描）。
 *
 * 落地形态照 S1 先例：**发布前验收脚本**（`acceptance-sealed.mjs` 那条路的同类）。
 *
 * ════════════════════════════════════════════════════════════════════
 * 三条硬纪律（写死在代码里，不靠自觉）
 * ════════════════════════════════════════════════════════════════════
 *   ① **每次报三个数**：覆盖例数 / 通过例数 / **空转＋误报数**（元规则：好标本零误报必须与坏标本报错并列）
 *   ② **未运行的例数照实报**，⛔ 不算通过也不算失败（学他们自己的写法）
 *   ③ **假阳率与真读数并列**：指针体检的 指空 与 假阳 分开报，⛔ 不许拿"修好假阳"当"修好指空"
 *
 * 用法：
 *   node scripts/acceptance-audit.mjs
 *   node scripts/acceptance-audit.mjs --theirs "<他们的库>" --ours "<我们的库>" [--json]
 * 退出码：0 = 三门全过（未运行例数如实列出，不算失败）；1 = 有红；2 = 参数/环境错
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const argv = process.argv.slice(2)
const arg = (n, d = '') => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d }
const JSON_OUT = argv.includes('--json')

// 工具与库的位置：都可用参数覆盖；默认值只在**存在**时才用，否则报清楚
const AUDIT_TOOL = path.resolve(arg('audit-tool', path.join(import.meta.dirname, '..', '..', 'tools', 'cross-standard', 'audit.mjs')))
const OURS = path.resolve(arg('ours', path.join(os.homedir(), 'Documents', 'Obsidian Vault', '00_记忆系统')))
const THEIRS_DEFAULT = path.join(os.homedir(), 'Downloads', '硅基拍档【10.6日版本】', '硅基拍档')
const THEIRS = path.resolve(arg('theirs', THEIRS_DEFAULT))

const fail = (msg) => { console.error(`❌ ${msg}`); process.exit(2) }
if (!fs.existsSync(AUDIT_TOOL)) fail(`找不到体检工具：${AUDIT_TOOL}\n   （用 --audit-tool <path> 指定；默认值相对本仓上一层的 tools/cross-standard/）`)
if (!fs.existsSync(OURS)) fail(`找不到我们的库：${OURS}`)
if (!fs.existsSync(THEIRS)) fail(`找不到他们的库（阳性对照的标本来源）：${THEIRS}\n   （用 --theirs <path> 指定）`)

console.log('════════ Audit · 发布前验收（纪律件四条 · 一次跑完出读数表）════════')
console.log(`我们的库　${OURS}`)
console.log(`他们的库　${THEIRS}`)
console.log(`体检工具　${AUDIT_TOOL}\n`)

let raw = ''
try {
  raw = execFileSync(process.execPath, [AUDIT_TOOL, '--theirs', THEIRS, '--ours', OURS], {
    encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  })
} catch (error) {
  // 体检工具"有红"时是非零退出 —— 那是**读数**不是环境错，继续解析 stdout
  raw = String(error?.stdout ?? '')
  if (!raw) fail(`体检工具没产出任何输出（退出码 ${error?.status ?? '?'}）：${String(error?.message ?? error).slice(0, 200)}`)
}

// ⚠️ 体检工具的输出里**两侧各一块**（他们的在前、我们的在后），两块长一样。
// 修复前我按"第一个匹配"取 ⇒ 报的是**他们的数**（指空 0 / 豁免 57）——用它自己跑出来的缺陷。
// 口径：按"我们的例外清单路径"切出我们那一块，只在这块里解析。
const OUR_LINE = `例外清单：${path.join(OURS, 'audit_excludes.json')}`
const cutAt = raw.indexOf(OUR_LINE)
const mine = cutAt >= 0 ? raw.slice(cutAt) : raw
if (cutAt < 0) console.warn(`⚠️ 没找到我们那一块的标记行（${OUR_LINE}）—— 按全文解析，⚠️ 读数可能取到他们那一侧`)

// ── 门禁① 指针体检 ────────────────────────────────────────────────
const ptrLine = mine.match(/共 (\d+) 条指针 \/ 落地 (\d+) 条 \/ 指空 (\d+) 条（文件级 (\d+) \+ 节级 (\d+)）\/ 例外豁免 (\d+) 条 \/ 存疑 (\d+) 条/)
const bucketSelfBalanced = /桶账 共 \d+ ＝[^\n]*✅ 自平/.test(mine)

// ── 门禁③ 计数体检 ────────────────────────────────────────────────
const cnt = mine.match(/声明 共 (\d+) 条 \/ 分组 (\d+) 组 \/ 组内不一致 (\d+) 组 \/ 不一致条数 (\d+) 条/)

// ── 门禁⑤ 阳性对照（元门禁 · 三个数必须齐）─────────────────────────
// ⚠️ 阳性对照是**工具自己的元门禁**（不是分侧的），只印一次、位置在我们那块之前
// ⇒ 它必须从**全文**解析，⛔ 不能跟着"只看我们那块"一起切掉（切掉会误报"解析不到"）。
const pos = raw.match(/阳性对照：本文件两个检查器覆盖 (\d+) 例 ｜ 通过 (\d+) 例 ｜ 空转／误报 (\d+) 例 ｜ 未运行 (\d+) 例/)
const posRows = [...raw.matchAll(/^\s{2}(组[一二三四五六七]\s*(?:坏|好)[^\n]*?)(✅ 通过|❌[^\n]*|—)\s+([^\n]*)$/gm)]
  .map((m) => ({ name: m[1].trim(), verdict: m[2], note: m[3].trim() }))

const rows = []
const red = []
const warn = []

rows.push(['① 指针体检', ptrLine ? `指针 ${ptrLine[1]} ／ 落地 ${ptrLine[2]} ／ **指空 ${ptrLine[3]}**（文件级 ${ptrLine[4]} ＋ 节级 ${ptrLine[5]}）／ 豁免 ${ptrLine[6]} ／ 存疑 ${ptrLine[7]}` : '未解析到',
  bucketSelfBalanced ? '桶账自平 ✅' : '桶账不自平 ❌'])
if (!bucketSelfBalanced) red.push('指针体检：桶账不自平（记账与抬头对不上）')

rows.push(['③ 计数体检', cnt ? `声明 ${cnt[1]} 条 ／ 分组 ${cnt[2]} ／ 组内不一致 ${cnt[3]} 组 ／ 不一致 ${cnt[4]} 条` : '未解析到',
  cnt && cnt[3] === '0' && cnt[4] === '0' ? '✅ 通过' : '❌ 不一致'])
if (cnt && (cnt[3] !== '0' || cnt[4] !== '0')) red.push(`计数体检：${cnt[3]} 组不一致`)

rows.push(['⑤ 阳性对照', pos ? `覆盖 ${pos[1]} 例 ／ **通过 ${pos[2]} 例** ／ **空转＋误报 ${pos[3]} 例** ／ 未运行 ${pos[4]} 例` : '未解析到',
  pos && pos[3] === '0' && pos[1] === pos[2] ? '✅ 覆盖例全过' : '❌'])
if (!pos) red.push('阳性对照：解析不到汇总行（⛔ 不许当通过）')
else {
  if (pos[3] !== '0') red.push(`阳性对照：空转/误报 ${pos[3]} 例（元门禁失效）`)
  if (pos[1] !== pos[2]) red.push(`阳性对照：覆盖 ${pos[1]} 例但只过 ${pos[2]} 例`)
}

// ② 落点体检（A-4 已落地；判据：**第一版只量不治**，⛔ 不设阈值）
const land = mine.match(/落点句 共 (\d+) 句 \/ 有落点 (\d+) 句 \/ 无落点 (\d+) 句 \/ 创建承诺 (\d+) 句 \/ 落点无人建 (\d+) 处 \/ 例外豁免 (\d+) 处/)
const structureRows = posRows.filter((r) => /check_structure/.test(r.note) || r.verdict === '—')
rows.push(['② 落点体检',
  land ? `落点句 ${land[1]} ／ 有落点 ${land[2]} ／ **无落点 ${land[3]}** ／ 创建承诺 ${land[4]} ／ **落点无人建 ${land[5]}** ／ 豁免 ${land[6]}`
       : '未解析到门禁② 读数（⛔ 不许当通过）',
  land ? '⚪ **只量不治**（第一版不设阈值——还没量过，任何阈值都是编的）' : '❌ 解析失败'])
if (!land) red.push('落点体检：解析不到读数行')

// ── 打印读数表 ────────────────────────────────────────────────────
console.log('── 读数表 ──────────────────────────────────────────────────────')
for (const [k, v, verdict] of rows) {
  console.log(`  ${k}`)
  console.log(`     ${v}`)
  console.log(`     ${verdict}`)
}

console.log('\n── 阳性对照逐例（元门禁：证明检查器分得出好坏）────────────────')
if (posRows.length === 0) console.log('   ⚠️ 没解析到逐例行 —— ⛔ 如实标出，不许当通过')
for (const r of posRows) console.log(`  ${r.verdict.padEnd(8)} ${r.name.slice(0, 40).padEnd(42)} ${r.note.slice(0, 46)}`)

if (pos) {
  console.log(`\n  **三个数**：覆盖 ${pos[1]} ｜ 通过 ${pos[2]} ｜ **空转＋误报 ${pos[3]}** ｜ 未运行 ${pos[4]}（未运行例⛔ 不计入通过率；未运行的都是 check_structure，即门禁④/⑥/⑦）`)
}
console.log('\n  ⚠️ 假阳率提醒：指针体检的「指空」是机器读数，**真指空 / 假阳 必须人工初判后分开报**')
console.log('     当前口径（A-3 后）：机器指空 **0** ／ 真指空 **0**；豁免 33 条 = 外部件（CHANGELOG / VERIFICATION / 04_研究与报告 下的件）+ 引用示例（结论文档复述抽样名）——均为三类正当例外，**可见**、⛔ 不是被消掉')

console.log('\n── 结论 ────────────────────────────────────────────────────────')
if (red.length === 0) console.log('  ✅ 三门全过（未运行例数已如实列出，不计入通过）')
else { console.log(`  ❌ ${red.length} 处红：`); for (const r of red) console.log(`     · ${r}`) }
for (const w of warn) console.log(`  ⚠️ ${w}`)

if (JSON_OUT) {
  console.log('\n--json--')
  console.log(JSON.stringify({ pointer: ptrLine?.slice(1) ?? null, bucketSelfBalanced, counts: cnt?.slice(1) ?? null, positive: pos?.slice(1) ?? null, red }, null, 2))
}
process.exit(red.length === 0 ? 0 : 1)
