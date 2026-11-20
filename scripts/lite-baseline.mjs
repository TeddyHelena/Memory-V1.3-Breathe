#!/usr/bin/env node
/**
 * **MemoryV1.3-Lite · 规模基线快照**（可复跑）
 *
 * ## 它是什么，不是什么
 * 它是**尺子**，不是靶子清单。
 * 文件数 / 行数 / 导出面 / 包大小 —— 这些数的作用是**对照"砍前 vs 砍后"**，
 * ⛔ 不是"按体积排序找该删谁"。**大 ≠ 多余**（2026-10-14 作者 确认的目标口径）。
 *
 * ## Lite 的目标（记录口径）
 * 两条轴：① 砍**多余** ② 能**更简单地实现**的重写简单。
 * 两条硬约束：⛔ **指标不许退**（`docs/PERF-V1.3.md` 那几条）⛔ **运行要稳**（判据全绿）。
 *
 * ## 用法
 *   node scripts/lite-baseline.mjs                 # 全部
 *   node scripts/lite-baseline.mjs --json           # 机器可读（供对照脚本 diff）
 * ⛔ 只读真身（只 stat / 只数），写测试一律在临时目录。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const ROOT = path.resolve(import.meta.dirname, '..')
const REAL = process.env.MEMORY_ROOT ?? path.join(os.homedir(), 'Documents/Obsidian Vault/00_记忆系统/dsh-memory-container')
const JSON_OUT = process.argv.includes('--json')

const walk = (dir, exts) => {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p, exts))
    else if (exts.some((x) => e.name.endsWith(x))) out.push(p)
  }
  return out
}
const lines = (files) => files.reduce((n, f) => n + fs.readFileSync(f, 'utf-8').split('\n').length, 0)
const kb = (p) => { try { return Math.round(fs.statSync(p).size / 1024) } catch { return 0 } }

const R = { 代码: {}, 判据: {}, 脚本: {}, 数据: {}, 指标: {} }

// ── A · 代码面 ────────────────────────────────────────────────
const srcAll = walk(path.join(ROOT, 'src'), ['.ts', '.tsx'])
const srcHost = srcAll.filter((f) => !f.includes('/client/') && !f.includes('/route/') && !f.includes('/contract/'))
const srcRoute = srcAll.filter((f) => f.includes('/route/') || f.includes('/contract/'))
const srcClient = srcAll.filter((f) => f.includes('/client/'))
R.代码 = {
  'src 文件数': srcAll.length, 'src 行数': lines(srcAll),
  host文件: srcHost.length, host行数: lines(srcHost),
  route_contract文件: srcRoute.length, route_contract行数: lines(srcRoute),
  client文件: srcClient.length, client行数: lines(srcClient),
}

// 最大函数 top5（>120 行的）
const bigFns = []
for (const f of srcAll.filter((x) => x.endsWith('.ts'))) {
  const ls = fs.readFileSync(f, 'utf-8').split('\n')
  let depth = 0, start = null, name = null
  for (let i = 0; i < ls.length; i++) {
    const m = /^\s*(?:export )?(?:async )?function (\w+)/.exec(ls[i])
    if (m && depth === 0) { name = m[1]; start = i }
    depth += (ls[i].match(/{/g) ?? []).length - (ls[i].match(/}/g) ?? []).length
    if (depth === 0 && start !== null && name) {
      if (i - start + 1 > 120) bigFns.push({ fn: `${path.relative(ROOT, f)}:${name}`, 行: i - start + 1 })
      start = null; name = null
    }
  }
}
R.代码.大函数 = bigFns.sort((a, b) => b.行 - a.行).slice(0, 5)

// 客户端包 + 运行期产物
let pkgBytes = 0
try { for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) pkgBytes += kb(path.join(ROOT, 'lib', f)) } catch { /* 没构建 */ }
R.代码['lib 产物合计 KB'] = pkgBytes

// ── B · 导出面（复用既有门禁，不重造）─────────────────────────
try {
  const out = execFileSync('node', [path.join(ROOT, 'scripts', 'dead-exports.mjs')], { cwd: ROOT, encoding: 'utf-8' })
  const m = /运行期导出 (\d+)｜有生产调用方 (\d+)｜仅测试引用 (\d+)｜零调用点 (\d+)｜白名单 (\d+)/.exec(out)
  if (m) R.代码.导出面 = { 合计: +m[1], 有生产调用方: +m[2], 仅测试引用: +m[3], 零调用点: +m[4], 白名单: +m[5] }
} catch { R.代码.导出面 = '(dead-exports 跑不动)' }

// ── C · 判据面（稳定性资产：⛔ 只许增不许减）─────────────────
const testAll = walk(path.join(ROOT, 'test'), ['.mjs'])
R.判据 = { test文件数: testAll.length, test行数: lines(testAll) }

// ── D · 脚本面（"多余"的线索，不是判据）─────────────────────
const scriptAll = walk(path.join(ROOT, 'scripts'), ['.mjs', '.sh'])
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'))
const npmText = JSON.stringify(pkg.scripts)
const docsText = (() => { try { return walk(path.join(ROOT, 'docs'), ['.md']).map((f) => fs.readFileSync(f, 'utf-8')).join('\n') } catch { return '' } })()
const referenced = [], orphans = []
for (const f of scriptAll) {
  const base = path.basename(f)
  if (npmText.includes(base) || docsText.includes(base)) referenced.push(base); else orphans.push(base)
}
R.脚本 = { 文件数: scriptAll.length, 行数: lines(scriptAll), 被引用: referenced.length, 只身一人: orphans.length, 只身一人的名单: orphans }

// ── E · 数据面（真身；**对照项，不是靶子**）──────────────────
const ledgers = {}
// ⚠️ **三份扫描真源必须齐**（第 10 份第 11 条）：先前漏了 `.decay-sweep.json`（状态真源）
for (const f of ['index.json', 'injection-ledger.jsonl', 'index.delta.jsonl', '.decay-sweep.json', '.decay-startup.jsonl', '.decay-audit.jsonl', '.decay-intent.jsonl']) {
  const p = path.join(REAL, f)
  if (fs.existsSync(p)) ledgers[f] = { KB: kb(p), 行: fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean).length }
}
let bakN = 0, bakKB = 0
try { for (const f of fs.readdirSync(REAL)) if (f.startsWith('index.json.bak-')) { bakN++; bakKB += kb(path.join(REAL, f)) } } catch { /* 真身不在 */ }
R.数据 = { 账本: ledgers, 备份份数: bakN, 备份KB: bakKB }

// ── F · 指标面（⛔ 不许退）：冷启动 / 写入斜率 / 读路径 ────────
const { MemoryContainer } = await import(path.join(ROOT, 'lib', 'container.js'))
const { MemoryWriter } = await import(path.join(ROOT, 'lib', 'writer.js'))
const { performance } = await import('node:perf_hooks')

/** 造 n 条副本（真身只读，⛔ 绝不写真身） */
const mkCopy = (n) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-baseline-'))
  for (const l of ['hot', 'longterm', 'archive', 'pending']) fs.mkdirSync(path.join(dir, l), { recursive: true })
  const T = Date.now()
  const entries = []
  for (let i = 0; i < n; i++) {
    const la = new Date(T - (i % 40) * 86400000).toISOString()
    fs.writeFileSync(path.join(dir, 'longterm', `l${i}.md`), `---\nid: l${i}\ntitle: 条目${i}\nlayer: longterm\nstatus: active\ntags: []\nlast_accessed: ${la}\naccess_count: ${i}\n---\n正文 ${i}\n`)
    entries.push({ id: `l${i}`, title: `条目${i}`, layer: 'longterm', status: 'active', tags: [], file: `longterm/l${i}.md`, last_accessed: la, access_count: i, priority: 50 })
  }
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ schema: 'harness-memory-container/12', version: 12, hot_order: [], entries, archive_index: {}, longterm_tags: {} }))
  return dir
}
// 冷启动（load verify）—— 取 5 次中位
const cold = []
for (let i = 0; i < 5; i++) { const d = mkCopy(200); const t = performance.now(); const c = new MemoryContainer(d); c.load({ verify: true }); cold.push(performance.now() - t); fs.rmSync(d, { recursive: true, force: true }) }
cold.sort((a, b) => a - b)
R.指标['冷启动 load(verify) 中位 ms（200 条）'] = +cold[2].toFixed(1)

// ⚠️ 口径要说清（⛔ 别把两个不同的量混着报）：
//   `docs/PERF-V1.3.md` 那条 **0.0032 ms/条** 是 `drift-ladder.mjs` 的口径（索引阶梯增长的成本）
//   —— 见下面的"复跑清单"，本脚本不重造它。
//   本脚本测的是**另一条**、而且是交互上更要紧的：**一次完整写事务（含落盘）要多久**。
//   ⇒ Lite 不许退的清单里，两条都要（一条管规模成本，一条管交互手感）。
const tx = {}
for (const n of [1000, 5000, 10000]) {
  const d = mkCopy(n); const c = new MemoryContainer(d); c.load(); const w = new MemoryWriter(c)
  const t = performance.now()
  for (let i = 0; i < 200; i++) w.edit(`l${i}`, { summary: `改 ${i}` })
  tx[`@${n} 条 · 单写事务 ms`] = +((performance.now() - t) / 200).toFixed(2)
  fs.rmSync(d, { recursive: true, force: true })
}
R.指标.单写事务耗时 = tx

// 读路径：只测"取索引"（纯内存投影，夹具就够）。
// ⛔ 检索延迟**不在本脚本里重造** —— `scripts/search-latency-probe.mjs` 是专用台子
//    （它要**真实正文**建语料，合成夹具喂不进去）。见下面复跑清单。
{
  const d = mkCopy(5000); const c = new MemoryContainer(d); c.load()
  c.getIndex()                                        // 预热
  const t = performance.now()
  for (let i = 0; i < 50; i++) c.getIndex().entries.length
  R.指标['取索引 ms（5000 条，纯内存）'] = +((performance.now() - t) / 50).toFixed(4)
  fs.rmSync(d, { recursive: true, force: true })
}

// ── 输出 ──────────────────────────────────────────────────────
if (JSON_OUT) { console.log(JSON.stringify(R, null, 2)); process.exit(0) }
const show = (title, obj, indent = '  ') => {
  console.log(`\n${title}`)
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) { console.log(`${indent}${k}:`); for (const x of v) console.log(`${indent}  · ${typeof x === 'object' ? JSON.stringify(x) : x}`) }
    else if (v && typeof v === 'object') {
      console.log(`${indent}${k}:`)
      for (const [k2, v2] of Object.entries(v)) {
        if (v2 && typeof v2 === 'object') console.log(`${indent}  ${String(k2).padEnd(26)} ${Object.entries(v2).map(([a, b]) => `${a}=${b}`).join('  ')}`)
        else console.log(`${indent}  ${String(k2).padEnd(26)} ${v2}`)
      }
    }
    else console.log(`${indent}${String(k).padEnd(28)} ${v}`)
  }
}
console.log('════════ MemoryV1.3-Lite · 规模基线快照 ════════')
console.log(`  生成 ${new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 19)} ｜ 仓库 ${ROOT}`)
console.log('  ⛔ 这是**尺子**不是靶子清单 —— 大 ≠ 多余')
show('── A · 代码面 ──', R.代码)
show('── B · 判据面（稳定性资产：只许增不许减）──', R.判据)
show('── C · 脚本面（"多余"的线索）──', R.脚本)
show('── D · 数据面（对照项，不是靶子）──', R.数据)
show('── E · 指标面（⛔ 不许退）──', R.指标)
console.log('\n── F · 插件级指标（本脚本测不了，复跑清单）──')
console.log('  每轮注入字符/token   → **node scripts/injection-bytes.mjs --root <副本>**（⛔ 别再用那个硬编码值）')
console.log('                          ⚠️ 2026-10-15：原先这行印的是**硬编码的 4,927 字符**（PERF-V1.3 的 10-10 读数），')
console.log('                             而**全仓无仪器可复测它**（"有读数、无仪器"）⇒ 已补仪器；并测出**口径分歧**：')
console.log('                             今天的分项是 全量 4,304 ／ 摘要 837 ／ 声音 2,032（合计 6,336）⇒ 尺子值**口径没写清**')
console.log('  索引级写入斜率 0.0032 → node scripts/drift-ladder.mjs --root <副本>（PERF-V1.3 的口径）')
console.log('  检索延迟（稳定/写后） → MEMORY_CONTAINER_ROOT=<真身> bash scripts/with-container-copy.sh \'node scripts/search-latency-probe.mjs "$CONTAINER_COPY" 2000\'')
console.log('  长跑漂移五判据       → node scripts/longrun-drift.mjs --root <副本>')
console.log('  指针指空             → node ~/Desktop/Harness/plugin-dev/tools/cross-standard/audit.mjs')
console.log('  全部门禁             → npm run verify && node scripts/release-check.mjs && npm run shoot')
console.log('  七个试验场           → 00_记忆系统/docs/试验场/breathe-20261014/*.mjs')
console.log('')
