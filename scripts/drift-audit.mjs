#!/usr/bin/env node
/**
 * drift-audit.mjs —— 全量对账（2026-10-07 建，借硅基拍档 10.6 的三条元规则）
 *
 * ── 为什么要有它 ────────────────────────────────────────────────────
 * 我们有机械闸门（守卫/负控/回滚点），防的是**新错产生**。
 * 但闸门防不住**"规则自己烂了"**——2026-10-07 实测到的两例：
 *   · README 的「写入 p50 9.2ms 已达标」躺了三个版本没人管，还被写成"每版必守的基线"
 *   · `v0.9` 那条 9-20 就作废的口径，10-06 又被捞回主线表
 * 闸门只管"按规则执行"，不管"规则过期了"。**这一栏只能靠定期拿真源对账。**
 *
 * 对照物：硅基拍档 10.6 包内 `系统-配置层/同步规则.md` 的漂移实录——
 *   版本号散落成 9 个（V1.2→V4.8）、「51−31−2」凑数、行号锚从 49 漂到 50、
 *   「方向写反⇒整行作废」、老库文件"整个不在"。六类漂移，五类与我们同构。
 *   他们的治法（本次直接借用）：
 *     ① ⛔ 不许写死任何一个数 —— 数出来几个就是几个
 *     ② 按锚串定位，⛔ 不按行号认
 *     ③ 判不出来时宁可标出来，⛔ 不许沉默、不许猜
 *
 * ── 扫什么 ──────────────────────────────────────────────────────────
 *   A 版本标识一致性   产品版本/包版本/tag/commit 的每个落点是否同值
 *   B 声明数字对真源   对外声明过的数字，逐条回真源重算
 *   C 索引 ↔ 文件 对账  index.json 的投影字段是否与条目文件（唯一真源）一致
 *   D 无定义引用       文档里用了但没定义过的代号/缩写
 *   E 行号锚           文档里引用的 `文件:行`，那行上现在是不是那个东西
 *   F 引用存在性       文档/元数据里提到的路径与记忆 id 是否真实存在
 *   — 方向写反：**不可机械化，本脚本不扫**（如实标出，不许沉默地漏掉）
 *
 * 用法：node scripts/drift-audit.mjs [--json]
 * 退出码：发现 P0 级不一致 → 1；否则 0（本脚本是报告，不是闸门）
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { MemoryContainer } from '../lib/container.js'
// 【V1.3-A · G1】字段表与漂移判据来自 `src/contract/fields.ts`（随构建产出 lib 版）。
// ⚠️ 这个 import 会**在构建产物缺失时直接失败** —— 那是**故意的**：
//    本脚本宁可拒绝运行，也不许退回自己那份手写字段表（历史上有过三份，已经静默对不上过一次）。
let fieldsMod
try {
  fieldsMod = await import('../lib/contract/fields.js')
} catch {
  console.error('❌ 未构建：本脚本的判据来自 src/contract/fields.ts。先跑 `npm run build:host` 再执行。')
  console.error('   （⛔ 刻意不内置备用判据：两份判据必然静默分叉）')
  process.exit(2)
}
const { diffEntryFields, MIRROR_FIELD_NAMES, REAL_DRIFT_KINDS } = fieldsMod

const HOME = os.homedir()
const REPO = path.resolve(import.meta.dirname, '..')
const VAULT = path.join(HOME, 'Documents', 'Obsidian Vault')
const DOCS = path.join(VAULT, '00_记忆系统', 'docs')
// 【Audit · 适配】容器根可被覆盖：--root <dir> 优先，其次 MEMORY_CONTAINER_ROOT 环境变量。
// ⚠️ 修复前这里是**硬编码**且**静默忽略 --root** —— 实测踩到：以为在跑副本，其实读的是生产
//    （只读所以没造成损害，但"验证跑在副本上"这个前提是假的，结论就不算数）。
const ROOT_OVERRIDE = (() => {
  const i = process.argv.indexOf('--root')
  if (i >= 0 && process.argv[i + 1]) return path.resolve(process.argv[i + 1])
  return process.env.MEMORY_CONTAINER_ROOT ? path.resolve(process.env.MEMORY_CONTAINER_ROOT) : null
})()
const CONTAINER = ROOT_OVERRIDE ?? path.join(VAULT, '00_记忆系统', 'dsh-memory-container')

/**
 * 【Audit · Ledger 适配】容器的**只读**真身视图 = 快照 + 增量日志。
 * ⛔ 不用 verify:true —— 那一档会**折平写盘**；审计工具不许在生产上制造写入。
 */
let _containerViewCache = null
function containerView() {
  if (_containerViewCache) return _containerViewCache
  const c = new MemoryContainer(CONTAINER)
  try {
    c.load({ verify: false })
    _containerViewCache = { index: c.getIndex(), container: c, error: null }
    return _containerViewCache
  } catch (error) {
    _containerViewCache = { index: { entries: [], entry_count: -1 }, container: null, error: String(error?.message ?? error) }
    return _containerViewCache
  }
}
const MANAGER_OVERRIDES = path.join(VAULT, '03_项目', '本地插件管理器', 'overrides.json')

const JSON_OUT = process.argv.includes('--json')
const findings = []          // {level:'P0'|'P1'|'?', area, what, detail}
const add = (level, area, what, detail = '') => findings.push({ level, area, what, detail })

const readJson = (p, fb = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return fb } }
const run = (bin, args, cwd = REPO) => {
  try { return execFileSync(bin, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
  catch (e) { return `（执行失败: ${String(e.message).slice(0, 60)}）` }
}

// ════════════════════════════════════════════════════════════════
// A · 版本标识一致性 —— 每一个落点都读出来，不同值就是漂移
// ════════════════════════════════════════════════════════════════
const versionSpots = {}
{
  const pkg = readJson(path.join(REPO, 'package.json'), {})
  versionSpots['package.json → version'] = pkg.version

  const src = fs.readFileSync(path.join(REPO, 'src', 'index.ts'), 'utf8')
  const m = src.match(/product:\s*\{([^}]*)\}/)
  if (m) {
    const grab = (k) => (m[1].match(new RegExp(`${k}:\\s*'([^']*)'`)) ?? [])[1]
    versionSpots['src/index.ts → product.package'] = grab('package')
    versionSpots['src/index.ts → product.productVersion'] = grab('productVersion')
    versionSpots['src/index.ts → product.baseline'] = grab('baseline')
  }
  const readmeHead = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8').split('\n')[0]
  versionSpots['README.md 首行'] = readmeHead.slice(0, 80)

  const ov = readJson(MANAGER_OVERRIDES, null)
  if (ov?.plugins?.['dsh-memory-container']) {
    versionSpots['插件管理器 overrides → productVersion'] = ov.plugins['dsh-memory-container'].productVersion
  }
  // ⚠️ 必须 rev-list -n1（peel）：annotated tag 的 rev-parse 返回的是 **tag 对象**的 SHA，
  //    不是它指向的提交 —— 写第一版时误报了一次「tag 不指向 HEAD」（84faf1f vs 422bc9c）
  versionSpots['git tag MemoryV1.2-Sealed → 指向提交'] = run('git', ['rev-list', '-n1', '--abbrev-commit', 'MemoryV1.2-Sealed'])
  versionSpots['git HEAD'] = run('git', ['rev-parse', '--short', 'HEAD'])
  versionSpots['git 当前分支'] = run('git', ['branch', '--show-current'])
}

// ════════════════════════════════════════════════════════════════
// B · 声明数字对真源 —— 声明值 vs 当场重算值
// ════════════════════════════════════════════════════════════════
const claims = []
{
  // 真源 1：测试数（当场跑，不写死）
  const testOut = run('npm', ['test'])
  const claimed = [...testOut.matchAll(/^# tests (\d+)/gm)].map((m) => Number(m[1]))
  const pass = [...testOut.matchAll(/^# pass (\d+)/gm)].map((m) => Number(m[1]))
  const fail = [...testOut.matchAll(/^# fail (\d+)/gm)].map((m) => Number(m[1]))
  const testTotal = claimed.reduce((a, b) => a + b, 0)
  const testFail = fail.reduce((a, b) => a + b, 0)
  claims.push({ name: '测试数', truth: `${testTotal} 项（fail ${testFail}，当场 npm test 实跑）`, sources: [
    ['插件管理器 overrides → health.expect', readJson(MANAGER_OVERRIDES, {})?.plugins?.['dsh-memory-container']?.health?.expect],
    // ⚠️ 第 6 类假阳性（2026-10-07 踩到）：CHANGELOG 是**历史记录**，它写的数字是"当时"的真值
    //    （Sealed 交付时确实是 223），不是"当前声明"。按现状去查历史文档，必然误报。
    //    ⇒ 历史文档不参与一致性判定；要查历史值有没有错，得回到当时的真源。
    ['（历史）CHANGELOG Sealed 条目 —— 不参与判定', undefined],
  // ⚠️ 第 10 类假阳性：`health.expect` 空串是**刻意的**——按他们那条元规则
  //    「⛔ 不许写死任何一个数」，体检只判 fail=0，不再绑死测试数（写死的数一定会漂）。
  //    守卫必须放行这种"主动不声明"，否则落实规则反而报红。
  ], ok: (v) => typeof v !== 'string' || v === '' || v.includes(String(testTotal)) })

  // 真源 2：容器条目数
  // 【Audit · Ledger 适配】索引真身 = 快照 + 增量日志，⛔ 不许直读 index.json。
  // 用 verify:false 档：**重放日志**得到真身，但不折平 —— 审计工具只读，不在生产上制造写入。
  const view = containerView()
  const idx = view.index
  const entryCount = Array.isArray(idx.entries) ? idx.entries.length : -1
  claims.push({ name: '容器条目数', truth: `${entryCount} 条（当场数：快照 + 增量日志）`, sources: [
    ['index.json → entry_count 字段', String(idx.entry_count)],
    ['插件管理器 overrides → notes 里声明的条数', (readJson(MANAGER_OVERRIDES, {})?.plugins?.['dsh-memory-container']?.notes?.match(/容器 (\d+) 条/) ?? [])[1]],
  ], ok: (v) => v === undefined || v === null || String(v).includes(String(entryCount)) })

  // 真源 3：性能数（只能引存档，不能自动重算 —— 如实标）
  claims.push({ name: '写入性能（**需人判**）', truth: '存档值：V1.2 实测 @2000 75.99ms、@2481 93.4–94.8ms；V1.0 微基准 9.2ms', sources: [
    ['README 性能口径表', (fs.readFileSync(path.join(REPO, 'README.md'), 'utf8').match(/V1\.2 实测 ~?([\d.]+)ms（@2000）/) ?? [])[0] ?? '（未匹配到）'],
  ], ok: () => true, note: '性能数不可自动重算（要 2000 条语料 + 压测台），本行只确认 README 已标注失效，非一致性判据' })
}

// ════════════════════════════════════════════════════════════════
// C · index.json ↔ 条目文件 对账（我们专属类：投影 vs 唯一真源）
// ════════════════════════════════════════════════════════════════
const indexVsFile = { checked: 0, mismatch: [], indexOnly: [], dataMissing: [], legacyMissing: [] }
{
  const view = containerView()
  const idx = view.index   // 【Audit · Ledger 适配】真身 = 快照 + 增量日志，经 container 读
  // 【V1.3-A · G1】字段表与判定**不再手写第二份**：全部来自 contract/fields.ts。
  // 上一版这里自带 8 字段表和一份判定，规则是「单侧缺值不算不符」⇒
  // `source`（索引缺 42 条）、`scope`（索引缺 9 条）这类真漂移**一处都报不出来**。
  // ⚠️ 建一次容器、load 一次 —— 每条都 new 的话 readEntry 拿不到索引，
  //    会全部报"解析失败"，制造假 P0（写脚本时踩到，记在这里）
  // ⛔ 用 verify:false：审计工具不许在生产上触发折平写盘。
  const c = new MemoryContainer(CONTAINER)
  c.load({ verify: false })
  for (const e of idx.entries ?? []) {
    const abs = path.join(CONTAINER, e.file)
    if (!fs.existsSync(abs)) { indexVsFile.mismatch.push([e.id, 'file', '条目文件不存在']); continue }
    let entryFile = null
    try { entryFile = c.readEntry(e.id) } catch { entryFile = null }
    if (!entryFile) { indexVsFile.mismatch.push([e.id, 'parse', '解析失败']); continue }
    indexVsFile.checked++
    // ⛔ 比 **raw**（文件里真写了什么），不是补过默认的 frontmatter ——
    //    否则解析器补的 `scope='global'` 会被当成"文件里有"，造出假漂移，
    //    同时**掩盖**"文件真写了 scope 但索引没有"这类真漂移。
    const raw = entryFile.raw ?? entryFile.frontmatter
    for (const d of diffEntryFields(e.id, e, raw)) {
      if (REAL_DRIFT_KINDS.includes(d.kind)) {
        indexVsFile.mismatch.push([e.id, d.field, `${d.kind} 索引=${JSON.stringify(d.fromIndex)?.slice(0, 30)} 文件=${JSON.stringify(d.fromFile)?.slice(0, 30)}`])
      } else if (d.kind === 'legacy-missing') {
        indexVsFile.legacyMissing.push([e.id, d.field])
      } else {
        indexVsFile.dataMissing.push([e.id, d.field])
      }
    }
  }
}

// ════════════════════════════════════════════════════════════════
// D · 无定义引用 —— 只查我们真踩过的那些代号（不做通用启发式，避免噪声）
// ════════════════════════════════════════════════════════════════
const undefinedRefs = []
{
  const WATCH = ['TM 框架', 'TM框架', '方案 A', '方案A']
  const files = fs.existsSync(DOCS) ? fs.readdirSync(DOCS).filter((f) => f.endsWith('.md')) : []
  for (const f of files) {
    const text = fs.readFileSync(path.join(DOCS, f), 'utf8')
    // 声明式白名单：文件已就该词的未定义状态做过注记 ⇒ 跳过（不靠人记住，靠声明串认）
    if (text.includes('历史引用未定义（2026-10-07 对账发现）') || text.includes('无定义引用的例证')) continue
    for (const w of WATCH) {
      if (!text.includes(w)) continue
      const at = text.indexOf(w)
      const near = text.slice(Math.max(0, at - 200), at + 200)
      // 定义判据：同一个文件里，该词附近 200 字内有没有定义句。
      // ⚠️ 第 5 类假阳性（2026-10-07 踩到）：定义句不止「是指 / 即 / ＝」，还有**冒号式** ——
      //    `V1.1性能对比` 里逐字写着「动态预算（方案A：上一轮用量驱动本轮）」，那就是定义，
      //    旧判据不认，把有定义的引用也报成"无定义"。守卫的假阳性会让人把它关掉 ⇒ 放宽。
      const defined = /(是指|指的是|＝|="?"|即|又叫|全称|候选方案|加强版|方案\s?[A-ZＡ-Ｚ][：:]\s?\S)/.test(near)
      if (!defined) undefinedRefs.push([f, w, near.replace(/\s+/g, ' ').slice(0, 80)])
    }
  }
}

// ════════════════════════════════════════════════════════════════
// E · 行号锚 —— 按锚串定位，验证 `file:line` 那行上现在是不是那个东西
// ════════════════════════════════════════════════════════════════
const lineAnchors = { checked: 0, drifted: [], unjudgeable: [] }
{
  const files = fs.existsSync(DOCS) ? fs.readdirSync(DOCS).filter((f) => f.endsWith('.md')) : []
  const re = /([\w./-]+\.(?:ts|js|mjs|md|json))[:：](\d{1,5})(?:[–-](\d{1,5}))?/g
  for (const f of files) {
    const text = fs.readFileSync(path.join(DOCS, f), 'utf8')
    // ⚠️ 第 8 类假阳性（2026-10-07）：**历史审计记录**里的行号是"当时"的读数，
    //    刻意保留（改了就是篡改留痕），文首已加锚点声明。按**声明串**识别并跳过 ——
    //    不按文件名认（文件名会变，锚串不会：他们那条"按锚串定位、不按行号认"同源）。
    if (text.includes('锚点声明（2026-10-07 补）')) continue
    for (const m of text.matchAll(re)) {
      const [, file, lineStr] = m
      const line = Number(lineStr)
      // 只验证"本仓源码"那种锚（文档/外部路径没法定位）
      if (!/\.(ts|js|mjs)$/.test(file)) continue
      const abs = path.join(REPO, 'src', path.basename(file))
      if (!fs.existsSync(abs)) { lineAnchors.unjudgeable.push([f, m[0], '源文件不在预期位置']); continue }
      const lines = fs.readFileSync(abs, 'utf8').split('\n')
      lineAnchors.checked++
      if (line > lines.length) { lineAnchors.drifted.push([f, m[0], `该文件只有 ${lines.length} 行`]); continue }
      // 判据：拿锚串所在的整句里提到的标识符，看那一行现在有没有
      const context = text.slice(Math.max(0, m.index - 120), m.index + 120)
      const ids = [...context.matchAll(/`([a-zA-Z_][\w.]{3,})`/g)].map((x) => x[1])
      const hit = ids.some((id) => lines[line - 1]?.includes(id.split('.')[0]))
      if (ids.length > 0 && !hit) lineAnchors.drifted.push([f, m[0], `第 ${line} 行现在不含 ${ids.join('/')}`])
      else lineAnchors.unjudgeable.push([f, m[0], '上下文里没有可判定的标识符 —— 需人判'])
    }
  }
}

// ════════════════════════════════════════════════════════════════
// F · 引用存在性 —— 元数据/文档里提到的路径与记忆 id
// ════════════════════════════════════════════════════════════════
const refExistence = { missingPaths: [], missingIds: [] }
{
  const ov = readJson(MANAGER_OVERRIDES, {})
  const mem = ov?.plugins?.['dsh-memory-container']
  if (mem?.insertConfig?.containerRoot && !fs.existsSync(mem.insertConfig.containerRoot)) {
    refExistence.missingPaths.push(['overrides.insertConfig.containerRoot', mem.insertConfig.containerRoot])
  }
  const view = containerView()
  const idx = view.index   // 【Audit · Ledger 适配】真身 = 快照 + 增量日志，经 container 读
  const ids = new Set((idx.entries ?? []).map((e) => e.id))
  const files = fs.existsSync(DOCS) ? fs.readdirSync(DOCS).filter((f) => f.endsWith('.md')) : []
  for (const f of files) {
    const text = fs.readFileSync(path.join(DOCS, f), 'utf8')
    for (const m of text.matchAll(/\b([hlpa]-?e?\d{2})\b/g)) {
      const id = m[1]
      if (/^p(50|90|95|99)$/.test(id)) continue   // p50/p95 是性能术语，不是记忆 id（第一版的假阳性）
      // 只报"像是引用记忆 id"的（排除 l01 这种通用编号噪声）：要求同句有"条/记忆/条目/见"
      const at = m.index
      const near = text.slice(Math.max(0, at - 30), at + 30)
      if (!/(条|记忆|条目|见|见 |条目 |id)/.test(near)) continue
      // ⚠️ 第 9 类假阳性（2026-10-07，实测 3/3 全是）：三种语境被误当成"引用了我们的记忆 id"——
      //    ① 跨容器引用（"他按交付说明建，只有 h00 示例" —— 说的是**别人的**容器）
      //    ② 未来规划（"新条目顺延 h12 起" —— 还没建）
      //    ③ 自指举例（对账报告里举例说明"h12 不存在"）
      if (/(示例|交付说明|顺延|规划|推荐|他将|他的容器|不存在|待建)/.test(near)) continue
      if (!ids.has(id)) refExistence.missingIds.push([f, id, near.replace(/\s+/g, ' ').slice(0, 60)])
    }
  }
}

// ════════════════════════════════════════════════════════════════
// 汇总
// ════════════════════════════════════════════════════════════════
{
  // A
  const vals = Object.entries(versionSpots)
  const productVals = new Set([versionSpots['src/index.ts → product.productVersion'],
    versionSpots['插件管理器 overrides → productVersion']].filter(Boolean))
  if (productVals.size > 1) {
    add('P0', 'A 版本标识', '产品版本不止一个值', [...productVals].join(' ≠ '))
  }
  const pkgVals = new Set([versionSpots['package.json → version'], versionSpots['src/index.ts → product.package']].filter(Boolean))
  if (pkgVals.size > 1) add('P0', 'A 版本标识', '包版本不止一个值', [...pkgVals].join(' ≠ '))
  if (!String(versionSpots['README.md 首行'] ?? '').includes(String(versionSpots['src/index.ts → product.productVersion'] ?? ''))) {
    add('P1', 'A 版本标识', 'README 首行的产品版本与源码不一致', String(versionSpots['README.md 首行']).slice(0, 60))
  }
  // ⚠️ 第 11 类假阳性：tag 与 HEAD 不同是**常态**（发布之后照常会有提交）。
  //    真正有信息量的是"tag 之后还有几个提交没发布"。报成信息项，不报 P1。
  if (versionSpots['git HEAD'] !== versionSpots['git tag MemoryV1.2-Sealed → 指向提交']) {
    const behind = run('git', ['rev-list', '--count', 'MemoryV1.2-Sealed..HEAD'])
    versionSpots['（信息）tag 之后未发布的提交数'] = behind
  }
  // ⚠️ 旧判据是"分支 ≠ main 就报"—— main 快进到 HEAD 之后仍然报，属第 7 类假阳性。
  //    真正该判的是**main 有没有落后**：只要 HEAD 的提交在 main 上，就不是问题。
  const mainSha = run('git', ['rev-parse', '--short', 'main'])
  const headInMain = run('git', ['merge-base', '--is-ancestor', 'HEAD', 'main']).length === 0
  const ancestorCheck = (() => { try { execFileSync('git', ['merge-base', '--is-ancestor', 'HEAD', 'main'], { cwd: REPO }); return true } catch { return false } })()
  if (!ancestorCheck) {
    add('P1', 'A 版本标识', `main 落后于 HEAD`, `main=${mainSha} HEAD=${versionSpots['git HEAD']} 当前分支=${versionSpots['git 当前分支']}`)
  }
  // B
  for (const c of claims) for (const [src, v] of c.sources) {
    if (v === undefined || v === null) continue
    if (!c.ok(v)) add('P0', 'B 声明数字', `${c.name}：${src} 与真源不符`, `真源 ${c.truth} ｜ 声明 ${JSON.stringify(v)}`)
  }
  // C
  if (indexVsFile.mismatch.length > 0) {
    add(indexVsFile.mismatch.length > 5 ? 'P0' : 'P1', 'C 索引↔文件',
      `${indexVsFile.mismatch.length} 处投影与唯一真源不符`, JSON.stringify(indexVsFile.mismatch.slice(0, 6)))
  }
  if (indexVsFile.dataMissing.length > 0) {
    add('P1', 'C 数据缺口',
      `${indexVsFile.dataMissing.length} 处字段两侧都缺（按契约该有值）—— 是**回填**的活，不是漂移`,
      JSON.stringify(indexVsFile.dataMissing.slice(0, 6)))
  }
  // D
  for (const [f, w] of undefinedRefs) add('P1', 'D 无定义引用', `${f} 用了「${w}」但附近没有定义句`, '')
  // E
  if (lineAnchors.drifted.length > 0) add('P1', 'E 行号锚', `${lineAnchors.drifted.length} 处行号锚疑漂`, JSON.stringify(lineAnchors.drifted.slice(0, 5)))
  // F
  if (refExistence.missingIds.length > 0) add('P1', 'F 引用存在性', `${refExistence.missingIds.length} 处引用了不存在的记忆 id`, JSON.stringify(refExistence.missingIds.slice(0, 5)))
}

const report = {
  scannedAt: new Date().toISOString(),
  versionSpots, claims: claims.map((c) => ({ name: c.name, truth: c.truth, sources: c.sources })),
  indexVsFile: { checked: indexVsFile.checked, mismatch: indexVsFile.mismatch, indexOnlyCount: indexVsFile.indexOnly.length },
  undefinedRefs, lineAnchors, refExistence,
  findings,
  notScanned: [
    '方向写反（如"归因反了"）—— 不可机械化，需人逐条读；本脚本不扫，如实标出',
  ],
}

if (JSON_OUT) { console.log(JSON.stringify(report, null, 2)); process.exit(findings.some((f) => f.level === 'P0') ? 1 : 0) }

const L = (s = '') => console.log(s)
L('════════ 全量对账 ════════')
L(`仓库 ${REPO}`)
L(`容器 ${CONTAINER}`)
L(`时间 ${report.scannedAt}`)
L()
L('── A · 版本标识落点（每个落点逐条读出来）──')
for (const [k, v] of Object.entries(versionSpots)) L(`   ${k.padEnd(42)} ${v}`)
L()
L('── B · 声明数字 vs 真源 ──')
for (const c of report.claims) {
  L(`   ◆ ${c.name}｜真源：${c.truth}`)
  for (const [src, v] of c.sources) L(`      声明 ${src} = ${JSON.stringify(v)}`)
}
L()
L(`── C · 索引 ↔ 文件 对账 ──`)
L(`   逐条比对 ${indexVsFile.checked} 条 × ${MIRROR_FIELD_NAMES.length} 个镜像字段（判据来自 contract/fields.ts）`)
L(`   真漂移 ${indexVsFile.mismatch.length} 处　｜　可回填缺口 ${indexVsFile.dataMissing.length} 处　｜　不可重建遗留 ${indexVsFile.legacyMissing.length} 处`)
for (const m of indexVsFile.mismatch.slice(0, 10)) L(`     ${m[0]} · ${m[1]}：${m[2]}`)
L()
L(`── D · 无定义引用 ── ${undefinedRefs.length} 处`)
for (const r of undefinedRefs.slice(0, 8)) L(`     ${r[0]}：${r[1]}`)
L()
L(`── E · 行号锚 ── 可判 ${lineAnchors.checked} 处，疑漂 ${lineAnchors.drifted.length} 处，需人判 ${lineAnchors.unjudgeable.length} 处`)
for (const r of lineAnchors.drifted.slice(0, 8)) L(`     疑漂 ${r[0]}：${r[1]} —— ${r[2]}`)
L()
L(`── F · 引用存在性 ── 缺失路径 ${refExistence.missingPaths.length} ｜ 不存在的记忆 id ${refExistence.missingIds.length}`)
for (const r of refExistence.missingIds.slice(0, 8)) L(`     ${r[0]}：引用 ${r[1]}（${r[2]}）`)
L()
L('── 结论 ──')
if (findings.length === 0) L('   ✅ 六类里可机械化的五类：未发现不一致')
else for (const f of findings) L(`   ${f.level === 'P0' ? '❌' : '⚠️'} [${f.level}] ${f.area}｜${f.what}${f.detail ? ' —— ' + f.detail : ''}`)
L()
L('── 本脚本不扫的（⛔ 不许沉默地漏掉）──')
for (const s of report.notScanned) L(`   · ${s}`)
process.exit(findings.some((f) => f.level === 'P0') ? 1 : 0)
