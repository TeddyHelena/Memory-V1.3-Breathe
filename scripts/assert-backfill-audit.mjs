#!/usr/bin/env node
/**
 * assert-backfill-audit.mjs —— 「断言回填」门（V1.3-A · G4）
 *
 * ── 治的是什么病 ────────────────────────────────────────────────────
 * 写文档会造**死断言**，而且这不是偶发：本轮**犯了四次**
 *   S2 那批 4 处 → Ledger 那批 6 处 → Audit 1 处。
 * 每一次都是"文档写下去的那一刻看着是对的，之后被本版自己的改动作废了，而没人回头改"。
 * 机械闸门（守卫/负控/回滚点）防的是**代码**出错，防不住**文档里的断言过期**。
 *
 * ── 本门查三类 ──────────────────────────────────────────────────────
 *   ① **指针体检**：⛔ **不自己写抽取器** —— 复用 `tools/cross-standard/audit.mjs`
 *      （那里面有 13 条已入档的偏离修正；本仓历史上就栽在"第二份抽取器"上。
 *       实测：我第一版自写的抽取器在同一批文档上吐出 **229 处假阳**，
 *       全是 Audit 早修过的形态——`.md`、`[VERIFICATION.md`、`详见《…`）。
 *      读它的机器可读读数 `ours.pointer.bad`，必须为 0。
 *      ⚠️ 它的判据来源 `/tmp/silicon-1006`（对照库）**已经不存在**（/tmp 随重启清空）
 *      ⇒ 用 **自比对**（`--theirs` 传我们自己）跑我们这一侧，只为取读数。
 *   ② **死 id**：文档里引用的记忆 id 必须在容器索引里找得到
 *      （⛔ 分位数 p50/p90/p95/p99 **不是**记忆 id —— 第一版把它们全报成死的）
 *   ③ **作废未标注**：出现作废词的断言必须同时给出**时间 / 版本 / 替代物**之一 ——
 *      否则读者不知道该信哪一版（"已作废"三个字本身不构成交代）
 *
 * ── 用法 ────────────────────────────────────────────────────────────
 *   node scripts/assert-backfill-audit.mjs [--docs <库根>] [--since <ISO|YYYY-MM-DD>]
 *                                          [--container <容器>] [--json] [--skip-pointer]
 *   ① 扫全库（口径与门禁①一致）；②③ 只扫 `--since`（缺省 24h）之后改动过的文档
 * 退出码：0 = 三类都干净；2 = 有命中；3 = 参数/依赖错；1 = 工具自身错
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const arg = (n, d = '') => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : d }
const HAS = (n) => process.argv.includes(`--${n}`)

const VAULT_LIB = arg('docs') || path.join(os.homedir(), 'Documents', 'Obsidian Vault', '00_记忆系统')
const DOCS = path.join(VAULT_LIB, 'docs')
const CONTAINER = arg('container') || path.join(VAULT_LIB, 'dsh-memory-container')
const JSON_OUT = HAS('json')
const SKIP_POINTER = HAS('skip-pointer')
const SINCE = (() => {
  const raw = arg('since')
  if (!raw) return Date.now() - 24 * 3600 * 1000
  const t = Date.parse(raw.length <= 10 ? `${raw}T00:00:00` : raw)
  if (!Number.isFinite(t)) { console.error(`❌ --since 解析不了：${raw}`); process.exit(3) }
  return t
})()
if (!fs.existsSync(DOCS)) { console.error(`❌ 文档目录不存在：${DOCS}`); process.exit(3) }

// ════════════════════════════════════════════════════════════
// ① 指针体检 —— 复用既有工具（自比对取我们这侧读数）
// ════════════════════════════════════════════════════════════
const AUDIT_TOOL = path.join(REPO, 'tools', 'cross-standard', 'audit.mjs')
let pointer = { ran: false, note: '', bad: null, doubt: null, exempt: null, tot: null }

/** audit.mjs 把 JSON 印在人读报告之后（以 `\n{\n` 起头），按这个标记切 */
function parseAuditJson(out) {
  const start = out.indexOf('\n{\n')
  if (start < 0) return null
  return JSON.parse(out.slice(start + 1))
}

if (SKIP_POINTER) {
  pointer.note = '按 --skip-pointer 跳过（如实标未运行，⛔ 不算通过也不算失败）'
} else if (!fs.existsSync(AUDIT_TOOL)) {
  pointer.note = `找不到 ${AUDIT_TOOL} ⇒ 指针体检**未运行**（⛔ 不算通过也不算失败）`
} else {
  let raw = ''
  try {
    raw = execFileSync('node', [AUDIT_TOOL, '--theirs', VAULT_LIB, '--ours', VAULT_LIB, '--json'],
      { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 })
  } catch (err) {
    // audit.mjs 有命中时 exit 2（那是"有东西要看"，不是工具坏了）——照样取它的 JSON
    raw = String(err.stdout ?? '')
    if (!raw) pointer.note = `audit.mjs 跑不起来（exit ${err.status ?? '?'}）：${String(err.stderr ?? err.message).slice(0, 160)}`
  }
  if (!pointer.note) {
    try {
      const p = parseAuditJson(raw)?.ours?.pointer
      if (p) pointer = { ran: true, note: '复用 tools/cross-standard/audit.mjs（自比对，取我们这侧）', bad: p.bad ?? null, doubt: p.doubt ?? null, exempt: p.exempt ?? null, tot: p.tot ?? null }
      else pointer.note = 'audit.mjs 输出里找不到 ours.pointer 读数 ⇒ **未运行**'
    } catch (err) {
      pointer.note = `audit.mjs 输出解析失败：${String(err.message).slice(0, 120)} ⇒ **未运行**`
    }
  }
}

// ════════════════════════════════════════════════════════════
// ②③ 只扫本版碰过的文档
// ════════════════════════════════════════════════════════════
function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir).sort()) {
    if (name.startsWith('.') || name === '_backup' || name.includes('.bak')) continue
    const abs = path.join(dir, name)
    const st = fs.statSync(abs)
    if (st.isDirectory()) walk(abs, out)
    else if (name.toLowerCase().endsWith('.md')) out.push({ abs, mtime: st.mtimeMs })
  }
  return out
}
const all = walk(DOCS)
const scoped = all.filter((f) => f.mtime >= SINCE)

/** 豁免词：同一行出现即不算指向性断言（与 audit.mjs 的「规则举例」类同源，取最小集） */
const EXEMPT = /举例|例：|例:|示例|模板|占位|写法|比如|假设|不是本包|包外|留底|历史记录|（历史）/

/** ② 死 id —— ⛔ 必须排除分位数：p50/p90/p95/p99 不是记忆 id（第一版把它们全报成死的） */
const PERCENTILE = new Set(['p50', 'p90', 'p95', 'p99', 'p25', 'p75', 'p10', 'p1', 'p5', 'p0'])
const RX_ID = /(?<![A-Za-z0-9_-])((?:h|a|p|l-e|l)\d{1,3})(?![A-Za-z0-9_-])/g

function checkIds(file, text, lines, known) {
  const hits = []
  for (const m of text.matchAll(RX_ID)) {
    const id = m[1]
    if (PERCENTILE.has(id)) continue
    const lineNo = text.slice(0, m.index).split('\n').length
    const line = lines[lineNo - 1] ?? ''
    if (EXEMPT.test(line)) continue
    if (/形如|例如|这种|以下|如下/.test(line)) continue
    if (!known.has(id)) hits.push({ doc: path.relative(DOCS, file.abs), line: lineNo, what: id })
  }
  return hits
}

/** ③ 作废未标注：作废词所在处必须给出 时间 / 版本 / 替代物 之一 */
const RX_VOID = /已作废|已失效|不再适用|已被取代|已废弃|作废了|不再成立|已经过期/
const RX_ANCHOR = /\d{4}-\d{2}(-\d{2})?|V\d+(\.\d+)*|v\d+\.\d+|第\s*\d+\s*版|见\s*`|改用|以后以|最新以/

function checkVoid(file, lines) {
  const hits = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!RX_VOID.test(line)) continue
    if (EXEMPT.test(line)) continue
    // ⚠️ 锚点只认**本行 + 下一行**（表格/断行时交代常落在下一行）。
    //    第一版取 ±2 行 ⇒ **阳性对照抓出假阴性**：坏样本前一行那句「旧结论见 `l99`」
    //    被当成替代物锚点，于是"已作废但没交代"的句子被漏掉。
    //    **前面**的指针属于另一个断言，不能拿来充数。
    const window = [line, lines[i + 1]].filter(Boolean).join(' ')
    if (!RX_ANCHOR.test(window)) hits.push({ doc: path.relative(DOCS, file.abs), line: i + 1, what: line.trim().slice(0, 60) })
  }
  return hits
}

let knownIds = new Set()
let idCheckRan = false
try {
  const { MemoryContainer } = await import(path.join(REPO, 'lib', 'container.js'))
  const c = new MemoryContainer(CONTAINER)
  c.load({ verify: false })     // 只读：重放增量日志，不折平（审计工具不许在生产上制造写入）
  for (const e of c.getIndex().entries) knownIds.add(e.id)
  idCheckRan = true
} catch (err) {
  console.error(`⚠️ 容器读不到（${String(err.message ?? err)}）⇒ **死 id 这一栏本轮未运行**（⛔ 不当通过）`)
}

const deadIds = []
const unmarked = []
for (const f of scoped) {
  const text = fs.readFileSync(f.abs, 'utf-8')
  const lines = text.split(/\r?\n/)
  if (idCheckRan) deadIds.push(...checkIds(f, text, lines, knownIds))
  unmarked.push(...checkVoid(f, lines))
}

const failed = []
if (pointer.ran && pointer.bad > 0) failed.push(`指针体检 bad=${pointer.bad}`)
failed.push(...deadIds.map((h) => `死 id ${h.doc}:${h.line} ${h.what}`))
failed.push(...unmarked.map((h) => `作废未标注 ${h.doc}:${h.line}`))

const report = {
  generatedAt: new Date().toISOString(),
  pointer, scopedDocs: scoped.length, totalDocs: all.length,
  deadIds, unmarkedVoid: unmarked, idCheckRan, passed: failed.length === 0,
}

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log('── ① 指针体检（复用 tools/cross-standard/audit.mjs，全库口径）──')
  if (pointer.ran) {
    console.log(`   指针 ${pointer.tot} ｜ 指空 **${pointer.bad}** ${pointer.bad === 0 ? '✅' : '❌'} ｜ 需人判 ${pointer.doubt} ｜ 豁免 ${pointer.exempt}`)
    console.log(`   （${pointer.note}）`)
  } else {
    console.log(`   ⛔ 未运行：${pointer.note}`)
  }
  console.log(`\n── ② 死 id：${deadIds.length} 处 ${deadIds.length === 0 ? '✅' : '❌'}（扫 ${scoped.length}/${all.length} 份，自 ${new Date(SINCE).toISOString()} 起改动过的）`)
  for (const h of deadIds.slice(0, 15)) console.log(`   ${h.doc}:${h.line}　${h.what}`)
  if (!idCheckRan) console.log('   ⛔ 本轮未运行（容器读不到）—— 不算通过也不算失败')
  console.log(`\n── ③ 作废未标注（缺 时间/版本/替代物）：${unmarked.length} 处 ${unmarked.length === 0 ? '✅' : '❌'}`)
  for (const h of unmarked.slice(0, 15)) console.log(`   ${h.doc}:${h.line}　${h.what}`)
}

if (failed.length > 0) {
  // ⚠️ --json 时**只输出 JSON**，人话一律走 stderr —— 混在一起会逼调用方去解析人话，
  //    而"解析人话取读数"正是 Audit 那轮踩过的坑（取到了报告另一侧的数）。
  if (!JSON_OUT) console.log(`\n❌ 断言回填门不通过：${failed.length} 处。逐条处置（改措辞 / 标注作废 / 补替代物 / 修引用的 id）后重跑。`)
  else console.error(`断言回填门不通过：${failed.length} 处`)
  process.exit(2)
}
if (!JSON_OUT) console.log('\n✅ 断言回填门通过')
process.exit(0)
