#!/usr/bin/env node
/**
 * 部署后验收 —— 重启之后跑这一支，一条命令出结论。
 *
 * 为什么单独立一支：**重启会掐断会话**，验收脚本必须能独立跑、自己给结论。
 *
 * 分两半，缺一不可：
 *   ① **运行中的进程**（HTTP `/api/memory/selftest`）—— 证明"部署真的生效了"：
 *      进程里加载的 productVersion 是不是新的、漂移读数、校验和三类计数。
 *      ⚠️ 只有这一半能证明"重启生效"；只查盘上文件的话，改没改代码它都绿。
 *   ② **盘上的数据**（直接读容器）—— 证明安全修复在真身上成立：
 *      索引里还有没有正文指纹、作用域隔离的两条泄漏还复现不复现。
 *
 * 用法：node scripts/post-deploy-check.mjs [--port 19387] [--json]
 *   token 从 ~/.dsh/memory-api-token 读（也可用 --token 显式给）。
 *
 * ⛔ **它不是只读的**（2026-10-09 实测纠正 —— 我原本在这里写了"只读"，是错的）：
 *    `container.load()` 与插件启动走的是同一条自愈路径 —— 索引有 file-only 残留、
 *    作用域有漂移、增量日志有待折平时，**它会当场改写 `index.json` 并落盘**。
 *    实测：第一次跑这支脚本就把真身索引里的 70 条 checksum 残留清掉了（即重启首启动本会做的事）。
 *    ⇒ ① **跑之前先备份容器**（`cp -R` 一份）；
 *      ② 这一支本来就是**重启之后**跑的，别在部署前拿它当"体检"。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { MemoryContainer } from '../lib/container.js'
// ⭐ 配置漂移判据要用 schema 的**默认值**（⛔ 不硬编码）⇒ 从插件本体取
import { Config } from '../lib/index.js'
import { buildInvertedTagIndex, directed } from '../lib/route/recall.js'
import { DEFAULT_ROUTE_CONFIG } from '../lib/route/types.js'
import { scopeAllowsMeta } from '../lib/policy.js'

const args = process.argv.slice(2)
const arg = (name, fb) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fb }
const PORT = Number(arg('--port', '19387'))
const AS_JSON = args.includes('--json')
const CONTAINER = path.resolve(arg('--root', path.join(os.homedir(), 'Documents', 'Obsidian Vault', '00_记忆系统', 'dsh-memory-container')))

/**
 * 期望版本**从仓里读**，⛔ 不写死在这里。
 * 实测踩过：脚本里硬编码 `MemoryV1.3-A`，切到 `A.1` 之后那行**对着旧期望值报了绿**——
 * 一个会过期的判据比没有判据更糟（它给的是假安心）。
 */
function expectedVersions() {
  const repo = path.join(import.meta.dirname, '..')
  let pkg = {}
  try { pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')) } catch {}
  let productVersion = ''
  try {
    const src = fs.readFileSync(path.join(repo, 'src', 'index.ts'), 'utf8')
    productVersion = src.match(/productVersion:\s*'([^']+)'/)?.[1] ?? ''
  } catch {}
  return { package: pkg.version ?? '', productVersion }
}
const EXPECT = expectedVersions()
const token = arg('--token', (() => {
  try { return fs.readFileSync(path.join(os.homedir(), '.dsh', 'memory-api-token'), 'utf8').trim() } catch { return '' }
})())

const rows = []

/** 找 desktop profile 的 patch（插件管理器写的那份） */
function findProfilePatch() {
  const dir = path.join(os.homedir(), '.dsh', 'profiles')
  try {
    for (const p of fs.readdirSync(dir)) {
      const f = path.join(dir, p, 'cordis.patch.yml')
      if (fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes('id: memory-container')) return f
    }
  } catch {}
  return null
}

/** 取 patch 里 memory-container 段的 config 键值（简易缩进解析，够用且不引 yaml 依赖） */
function readMemoryConfig(patch) {
  const lines = fs.readFileSync(patch, 'utf8').split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*- id: memory-container\s*$/.test(lines[i])) continue
    const base = lines[i].length - lines[i].trimStart().length
    const out = {}
    let inConfig = false
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]
      if (!l.trim()) continue
      const ind = l.length - l.trimStart().length
      if (ind <= base && l.trimStart().startsWith('- ')) break
      if (/^\s*config:\s*$/.test(l)) { inConfig = true; continue }
      const m = inConfig ? l.match(/^\s+([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/) : null
      if (m) out[m[1]] = m[2].trim().replace(/^'(.*)'$/, '$1')
    }
    return out
  }
  return null
}
const add = (name, ok, detail) => rows.push({ name, ok, detail })

/**
 * ⭐【2026-10-16 · 事故'dyn-recall-off' 的判据】**「该开的开了没」**。
 *
 * ## 为什么必须有这一条（它不是上一条的加强版，是**另一个问题**）
 * 上面那条「配置漂移」回答的是：**盘上 == 进程内吗**。
 * 实测事故（2026-10-16）：`enableRoute` **在盘上根本没有这个键** ⇒ 吃 schema 默认 `false`
 * ⇒ 盘上「没写」、进程内「false」、默认值也是「false」⇒ **一致性判据绿**，而**引擎是关的**。
 * ⇒ 两个值**一致地等于默认值**时，一致性判据**永远发现不了**。
 *
 * 所以这条换一个问法：**这份部署声称要开的开关，进程里真的开着吗？**
 * 基线来自仓里的 `config/memory-baseline.json`（记录**部署决定**，⛔ 不是照抄活配置）。
 *
 * ## 两个方向都要抓
 * · `expect: true` 而进程里不是 true ⇒ **该开的没开**（本次事故）
 * · `expect: false` 而进程里是 true ⇒ **不该开的开了**（旧配置残留，10-09 那次的样子）
 */
function loadBaseline() {
  const p = path.resolve(arg('--baseline', path.join(import.meta.dirname, '..', 'config', 'memory-baseline.json')))
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    return { path: p, ...j }
  } catch (error) {
    return { path: p, error: String(error.message).slice(0, 80) }
  }
}

// ── ① 运行中的进程 ────────────────────────────────────────────────
let live = null
try {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/memory/selftest`, {
    headers: token ? { 'x-memory-token': token } : {},
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  live = await res.json()
} catch (error) {
  add('① 运行进程可读', false, `读不到 /api/memory/selftest：${String(error.message).slice(0, 60)}`)
}
if (live) {
  const p = live?.data?.product ?? live?.product ?? {}
  add('① 运行进程可读', true, `HTTP 200`)
  add('① 进程内 productVersion', p.productVersion === EXPECT.productVersion,
    `${p.productVersion ?? '(缺)'}（期望 ${EXPECT.productVersion}${EXPECT.productVersion ? ' —— 不是新值 = 还没重启' : '（读不到期望值，判据失效）'}）`)
  add('① 进程内包版本', p.package === EXPECT.package, `${p.package ?? '(缺)'}（期望 ${EXPECT.package}）`)
  add('① 进程内 baseline', p.baseline === 'MemoryV1.3', `${p.baseline ?? '(缺)'}`)
  // ⛔ 读数缺失 = 失败（不许默认成 0 判绿）—— 本脚本第一版就踩过：
  //    路径写错成 `data.data.*`，结果"投影漂移"那行永远是 0、永远绿，
  //    而实际上根本没量到东西（"读数对不上就等于没量"）。
  const d = live?.data ?? {}
  const drift = d.projection_drift
  add('① 投影漂移读数存在', Array.isArray(drift), Array.isArray(drift) ? '是（data.projection_drift）' : `读数缺失/形状不对：${JSON.stringify(drift)?.slice(0, 60)}`)
  if (Array.isArray(drift)) add('① 投影漂移', drift.length === 0, `drift=${drift.length}`)
  // 【D0】"现在跑的是哪一版"的机械答案：盘上与进程内是不是同一个构建
  const b = d.build
  add('① 构建身份读数存在', b && typeof b === 'object', b ? '是（data.build）' : '读数缺失')
  if (b && typeof b === 'object') {
    add('① 盘上 = 进程内（未陈旧）', b.stale === false, `loaded=${b.loadedHash} ／ disk=${b.diskHash}${b.stale ? '  ⇒ 改了代码没重启。**动作人：作者**（重启宿主）｜ 助手 已检测并报告' : ''}`)
    add('① 构建清单无缺失项', (b.missing?.length ?? -1) === 0, `files=${b.files} ／ missing=${JSON.stringify(b.missing ?? [])}`)
    add('① 启动时刻有留痕', typeof b.loadedAt === 'string' && b.loadedAt.length > 0, `${b.loadedAt}`)
  }
  // 【D3】常驻名单审计：掉线（层=hot 但不在名单）= 文件在、永不注入
  const ha = d.hot_audit
  add('① 名单审计读数存在', Array.isArray(ha), Array.isArray(ha) ? '是（data.hot_audit）' : '读数缺失')
  if (Array.isArray(ha)) {
    const offline = ha.filter((x) => String(x).startsWith('掉线'))
    add('① 无掉线条目', offline.length === 0, offline.length ? offline.join(' ｜ ') : '0 条掉线')
    add('① 名单审计明细', true, ha.length ? ha.join(' ｜ ') : '（一致）')
  }
  // 【E · 1.4】「一天」的单一权威：时区 + 一个可一眼核对的样例
  const db = d.day_boundary
  add('① 日界权威读数存在', db && typeof db === 'object', db ? '是（data.day_boundary）' : '读数缺失')
  if (db && typeof db === 'object') {
    add('① 日界时区 = 配置时区', db.timeZone === 'Asia/Shanghai', `${db.timeZone}（期望 Asia/Shanghai）`)
    const sample = db.样例?.['2026-10-09 的结束']
    // 上海 2026-10-09 的结束 = 15:59:59.999Z；若给成 23:59:59.999Z 就是旧的 UTC 口径（差 8 小时）
    add('① 日界样例 = 当地日末', sample === '2026-10-09T15:59:59.999Z', `${sample}（≠ 该值说明还是 UTC 口径，多活 8 小时）`)
  }
  // 【C1】投递账本：它是"什么算唤起"的唯一权威，必须真的在记
  const il = d.injection_ledger
  add('① 投递账本读数存在', il && typeof il === 'object', il ? '是（data.injection_ledger）' : '读数缺失')
  if (il && typeof il === 'object') {
    add('① 账本在记录', (il.events ?? 0) > 0, `events=${il.events}（flushed=${il.flushed} buffered=${il.buffered}）｜最近一面=${il.last?.face ?? '-'}`)
  }
  // ── 【配置漂移】盘上的 profile patch vs 进程内实际加载的配置 ──────────────
  // 事故实录（2026-10-09）：重挂载把 5 个键弄丢（含 enableRoute）⇒ 面② 静默关闭 4.5 小时，
  // 而当时唯一"看得见"的读数是 route.rounds=0 —— 与"这次会话还没说话"长得一模一样。
  // 这条判据把"盘上 ≠ 进程内"变成一句能读的话。
  const cfg = d.config_effective
  add('① 配置读数存在', cfg && typeof cfg === 'object', cfg ? '是（data.config_effective）' : '读数缺失')
  if (cfg && typeof cfg === 'object') {
    const patch = findProfilePatch()
    const onDisk = patch ? readMemoryConfig(patch) : null
    if (!onDisk) {
      add('① 配置漂移检查', false, `读不到 profile patch 的 memory-container 段（${patch ?? '未找到 patch'}）⇒ 无法判漂移`)
    } else {
      const drift = []
      // ⛔ 【2026-10-15 判据修正：盘上**没声明**的键不再一律算漂移】
      //
      // 为什么改：`Config` 的 `.default(...)` 会在**进程里补齐**键，而盘上不写它们
      // ⇒ 原先一律算漂移 ⇒ **实测假阳**（`enableRoute` / `freshFromTurnClock`：
      //   进程值 = 默认值 = `false`，本来就没漂）。
      //
      // ⭐ 但**必须保住抓事故的能力**：2026-10-09 重挂载把含 `enableRoute` 的 5 个键弄丢，
      //    面② 静默关闭 4.5 小时，而当时唯一可见的读数 `route.rounds=0` 与"这次会话还没说话"一模一样。
      //    那一幕的特征是 **进程值 ≠ 默认值 且盘上没声明**（旧配置残留）。
      //
      // ⇒ 正确判据：**盘上没声明 且 进程值 ≠ 该键的默认值 ⇒ 才是漂移**。
      //    默认值从 schema 自己取（⛔ 不硬编码，否则 schema 改了这里会静静失效）。
      //    ⚠️ `Config` 是 **Schemastery** schema（⛔ 不是标准 zod）：取默认值靠**直接调用**它
      //       （`Config({...})` 返回补齐默认值的对象；`.parse` / `.resolve` 都**不存在** —— 实测）。
      const DEFAULTS = Config({ containerRoot: '/__post_deploy_defaults_probe__' })
      for (const [k, v] of Object.entries(cfg)) {
        if (!(k in onDisk)) {
          const def = DEFAULTS[k]
          if (v !== def) drift.push(`${k}（盘上没声明，进程值 ${JSON.stringify(v)} ≠ 默认值 ${JSON.stringify(def)}）`)
          continue
        }
        const diskVal = onDisk[k]
        const norm = (x) => (x === 'true' ? true : x === 'false' ? false : typeof x === 'string' && /^\d+$/.test(x) ? Number(x) : x)
        if (norm(diskVal) !== v) drift.push(`${k}: 盘上=${diskVal} 进程内=${v}`)
      }
      add('① 配置漂移（盘上 = 进程内）', drift.length === 0,
        drift.length ? `**改了配置没重启**：${drift.join(' ｜ ')}` : `${Object.keys(cfg).length} 项一致`)

      // ── ⭐【2026-10-16】「该开的开了没」—— 与上一条**问的不是同一个问题** ──────
      // 上一条问「盘上 == 进程内吗」；这条问「部署决定要开的，进程里开了吗」。
      // 事故实证：`enableRoute` 盘上没这个键 ⇒ 进程 false、默认 false ⇒ 上一条**绿**，而引擎关着。
      const baseline = loadBaseline()
      if (baseline.error) {
        add('① 基线可读', false, `读不到基线（${baseline.path}）：${baseline.error}`)
      } else {
        const violations = []
        for (const [k, spec] of Object.entries(baseline.mustBe ?? {})) {
          const has = Object.prototype.hasOwnProperty.call(cfg, k)
          const v = cfg[k]
          if (spec.expect === false) {
            if (has && v !== false) violations.push(`${k}（**不该开却开着**：进程内 ${JSON.stringify(v)}）`)
            continue
          }
          if (v !== spec.expect) {
            // 盘上有没有这个键，是两种不同的病，文案要分开——不然下次又会有人把它当假阳
            const diskNote = !patch ? '' : (readMemoryConfig(patch)?.[k] === undefined ? '盘上没声明这个键（吃默认值）' : `盘上声明了 ${JSON.stringify(readMemoryConfig(patch)?.[k])}`)
            violations.push(`${k}（**该开没开**：进程内 ${JSON.stringify(v)}，期望 ${JSON.stringify(spec.expect)}；${diskNote}）`)
          }
        }
        add('① 该开的开了没（基线 vs 进程内）', violations.length === 0,
          violations.length
            ? `**按部署决定应当为真、但进程里不是**：${violations.join(' ｜ ')}　（基线：${path.relative(path.join(import.meta.dirname, '..'), baseline.path)}，${baseline.updatedAt ?? '-'}）`
            : `${Object.keys(baseline.mustBe ?? {}).length} 项符合部署决定（基线 ${baseline.updatedAt ?? '-'}）`)

        // ── 开关与权重向量必须配对（「只换条曲线、权重不管」是明令禁止的组合）────
        // ⚠️ 权重的**读数来源是 `fresh_params.effectiveWeights`**，⛔ 不在 `config_effective` 里
        //    （实测看漏过一次：写 `cfg.weights` 会恒 undefined ⇒ 这条判据静默失效）。
        const sets = baseline.weightSets ?? {}
        const wired = cfg.freshFromTurnClock === true
        const want = wired ? sets.whenFreshWired : sets.whenFreshFrozen
        const liveWeights = d.fresh_params?.effectiveWeights
        if (want && liveWeights) {
          const bad = Object.entries(want).filter(([k, v]) => liveWeights[k] !== v)
          add('① 开关与权重向量配对', bad.length === 0,
            bad.length
              ? `上盘的是**禁配组合**：freshFromTurnClock=${wired} 却带 ${bad.map(([k, v]) => `${k}=${liveWeights[k]}（应 ${v}）`).join(' / ')}`
              : `freshFromTurnClock=${wired} ⇒ 权重符合该态（w2_pri=${liveWeights.w2_pri}）`)
        } else if (want) {
          add('① 开关与权重向量配对', false, '读不到 fresh_params.effectiveWeights ⇒ 无法判配对（⛔ 读数缺失不许判绿）')
        }
      }
    }
  }
  const ck = d.checksum
  add('① 校验和读数存在', ck && typeof ck === 'object', ck ? '是（data.checksum）' : '读数缺失')
  if (ck && typeof ck === 'object') {
    add('① 校验和不符必须为 0', (ck.mismatch?.length ?? -1) === 0, `mismatch=${ck.mismatch?.length ?? '(未报)'}`)
    add('① 校验和三类分开报', Number.isFinite(ck.verified) && Number.isFinite(ck.unverifiable), `verified=${ck.verified} ／ unverifiable=${ck.unverifiable}（旧格式或空值，⛔ 不算通过也不算失败）`)
  }
}

// ── ② 盘上数据 ────────────────────────────────────────────────────
const container = new MemoryContainer(CONTAINER)
container.load()
const index = container.getIndex()
const raw = JSON.parse(fs.readFileSync(path.join(CONTAINER, 'index.json'), 'utf8'))

const withChecksum = raw.entries.filter((e) => 'checksum' in e)
add('② 索引无正文指纹残留', withChecksum.length === 0, `${withChecksum.length} 条${withChecksum.length ? '（应已清零）' : ''}`)

const scopeDrift = container.getProjectionDrift().filter((s) => /\.scope(_id)?（/.test(s))
add('② 无作用域漂移', scopeDrift.length === 0, `${scopeDrift.length} 处`)

// 泄漏重现：空作用域上下文下，hot 倒排 + tag 扩散都不许带出非 global 条目
const tagIndex = buildInvertedTagIndex(index.entries)
const ctx = { container, config: DEFAULT_ROUTE_CONFIG, tagIndex, scopeContext: {} }
const leaked = new Set()
for (const q of ['记忆', '系统', '版本', '项目', '任务', '助手', '协作', '模板', '配置', '文档']) {
  for (const s of directed(ctx, q)) if (!scopeAllowsMeta(s.meta, ctx.scopeContext)) leaked.add(s.meta.id)
}
add('② 跨作用域读泄漏不可复现', leaked.size === 0, leaked.size ? `仍然泄漏：${[...leaked].join(',')}` : '10 个查询全部干净')

// 非 global 条目清单（人工核对用）
const nonGlobal = index.entries.filter((e) => (e.scope ?? 'global') !== 'global')
add('② 非 global 条目', true, nonGlobal.length ? nonGlobal.map((e) => `${e.id}(${e.scope}/${e.scope_id ?? '-'})`).join(' ') : '无')

// 启动留痕
const evts = [...(container.indexMergeEvents ?? []), ...(container.repairEvents ?? [])]
add('② 启动留痕', true, evts.length ? evts.slice(-3).map((s) => s.slice(0, 70)).join(' ｜ ') : '（无：说明本次没有需要自愈的东西）')

if (AS_JSON) {
  console.log(JSON.stringify({ container: CONTAINER, rows }, null, 2))
} else {
  console.log(`\n════ 部署后验收 ════\n容器 ${CONTAINER}\n`)
  for (const r of rows) console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? `  ｜ ${r.detail}` : ''}`)
  const failed = rows.filter((r) => !r.ok)
  console.log(`\n结论：${failed.length === 0 ? '✅ 全部通过（部署生效、安全修复在真身上成立）' : `❌ ${failed.length} 项未过 —— ${failed.map((f) => f.name).join(' / ')}`}\n`)
}
process.exit(rows.some((r) => !r.ok) ? 1 : 0)
