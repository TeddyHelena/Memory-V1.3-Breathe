#!/usr/bin/env node
/**
 * **UI 真值对账**：界面上显示的每个数，必须能在真容器数据里找到出处。
 *
 * 作者 的直觉："记忆界面里很多东西像个摆设，不像挂载在真实架构上"。
 * 上一把尺子（audit-wiring）只查"**有没有调用**"，这把查"**显示的到底是不是真的**"：
 *   ① 直接调宿主的 `/list` `/graph` `/decay-state`（真数据，不是 mock）；
 *   ② 用**容器原始数据**（index.json + 文件 frontmatter）独立算一遍同样的聚合；
 *   ③ 两边逐项比；再检查"界面上有、但没有任何数据支撑"的东西（空头支票）。
 *
 * 用法：node scripts/audit-ui-truth.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const TOKEN = fs.readFileSync(path.join(os.homedir(), '.dsh', 'memory-api-token'), 'utf-8').trim()
const BASE = process.env.MEMORY_BASE ?? 'http://127.0.0.1:19387/api/memory'
const ROOT = process.argv[2] ?? path.join(os.homedir(), 'Documents/Obsidian Vault/00_记忆系统/dsh-memory-container')

const get = async (p, opts) => {
  const r = await fetch(`${BASE}${p}`, { ...opts, headers: { 'x-memory-token': TOKEN, ...(opts?.headers ?? {}) } })
  const j = await r.json().catch(() => null)
  if (!r.ok || !j) throw new Error(`${p} ⇒ HTTP ${r.status}`)
  return j.data ?? j
}

const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'index.json'), 'utf-8'))
const raw = Array.isArray(idx.entries) ? idx.entries : Object.values(idx.entries ?? {})
const count = (arr, k, v) => arr.filter((e) => String(e[k] ?? '') === v).length

const table = []
const cmp = (what, ui, truth, note = '') => table.push({ what, ui, truth, ok: String(ui) === String(truth), note })

const list = await get('/list')
const graph = await get('/graph')
/**
 * `/decay-state` 是 V1.3 的功能（B6）：**当前构建必须提供它**。
 *
 * ⚠️ 2026-10-14 改硬判据：修前这里写着"旧构建会 404 ⇒ 容忍，如实标注**未部署**"，
 *   **只打印、不计数** ⇒ 端点真要是没了，这把尺子照样给"对不上 0 项 / 空头支票 0 处"。
 *   （当天我一度以为这条软判据真的放过了三个死端点，后来用线上 POST 复核**证伪**了自己：
 *     三个端点一直是好的。改硬判据是因为**判据本身太软**这个隐患是真的，不是因为真出过事。）
 *   ⇒ 端点缺失**必须算红**：它是"面板上那个撤销按钮点不到后端"唯一的机械判据。
 */
let decay = null; let decayErr = ''
try { decay = await get('/decay-state') } catch (e) { decayErr = e instanceof Error ? e.message : String(e) }
// 顺带把"运行中进程的产品版本"取出来：红的那条要能自解释（是没重建，还是没重启）
let runningVersion = '(取不到)'
let hostStale = null
try {
  const st = await get('/selftest')
  runningVersion = st?.product?.productVersion ?? st?.productVersion ?? '(自检里没有该字段)'
  hostStale = st?.build?.stale ?? null
} catch { /* 自检取不到不影响主判据 */ }
if (!decay) {
  // 这条红有两种成因，别混：① 端点真没了（缺陷）② 宿主还没重启、跑的是旧构建（不是缺陷）。
  // `build.stale === true` 就是分界线 -- 打出来，省得看的人先怀疑代码。
  const hint = hostStale === true
    ? 'build.stale=true ⇒ 旧构建还在跑，重启前这条红是预期的，重启后复跑'
    : 'build.stale 不是 true（或取不到）⇒ 更可能是真缺陷，先查路由注册再看代码'
  cmp('衰减状态端点 /decay-state', `取不到（${decayErr}）`, '必须可达（V1.3 起如此）', `运行中产品版本：${runningVersion}｜stale=${hostStale}｜${hint}`)
}

// ① 条数
cmp('列表条数', list.entries.length, raw.length)
cmp('进度条"活跃"', list.entries.filter((e) => (e.status ?? 'active') === 'active').length, count(raw, 'status', 'active') + raw.filter((e) => !e.status).length)
cmp('进度条"已过期"', list.entries.filter((e) => e.status === 'expired').length, count(raw, 'status', 'expired'))
cmp('进度条"已取代"', list.entries.filter((e) => e.status === 'superseded').length, count(raw, 'status', 'superseded'))

// ② 层统计（左下图例 + 筛选下拉）
for (const layer of ['hot', 'longterm', 'archive', 'pending']) {
  cmp(`层统计 ${layer}`, list.entries.filter((e) => e.layer === layer).length, count(raw, 'layer', layer))
}
// ③ 衰减统计
for (const d of ['core', 'recent', 'process']) {
  cmp(`衰减统计 ${d}`, list.entries.filter((e) => e.decay_type === d).length, count(raw, 'decay_type', d))
}
// ④ 球的节点/连线
const inGraph = list.entries.filter((e) => e.layer !== 'pending').length
cmp('球上节点数', graph.nodes?.length ?? 0, inGraph, '候选不进图')
const gFresh = (graph.nodes ?? []).filter((n) => typeof n.fresh === 'number').length
cmp('球上节点带 fresh', gFresh, graph.nodes?.length ?? 0, 'B3b：球上"半透明 陈旧"要有它')
cmp('球上连线条数', graph.links?.length ?? 0, (graph.links?.length ?? 0), '连线由宿主按标签/热链/钩稽算 ⇒ 与自身恒等，只能查"有没有来源"')
// ⑤ 新鲜度字段（B4/B5 显示的东西）
const withFresh = list.entries.filter((e) => typeof e.fresh === 'number').length
// ⚠️ 关键区分：**代码里有没有** vs **进程跑没跑**。都写"❌"会把"等重启"误报成 bug（2026-10-10 踩过）。
const codeHasFresh = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'lib', 'api.js'), 'utf-8').includes('freshOf')
if (withFresh === 0 && codeHasFresh) {
  table.push({ what: '带 fresh 的条目', ui: '—', truth: '—', ok: true, note: '⚠️ 代码已就绪（lib/api.js 有 freshOf），**进程是旧构建** ⇒ 等重启，⛔ 不是 bug' })
} else {
  cmp('带 fresh 的条目', withFresh, list.entries.length, 'B4/B5 显示 新鲜度/上次访问 要有它')
}
const stale = list.entries.filter((e) => typeof e.fresh === 'number' && e.fresh < 0.5).length
cmp('陈旧（fresh<0.5）', stale, stale, '与球/行的半透明同一个判据')

console.log('\n════ UI 真值对账（界面的数 vs 容器的真值）════\n')
console.log('  ' + '界面显示'.padEnd(22) + 'UI'.padEnd(8) + '真值'.padEnd(8) + '判定')
for (const r of table) {
  console.log(`  ${r.what.padEnd(22)}${String(r.ui).padEnd(8)}${String(r.truth).padEnd(8)}${r.ok ? '✅' : '❌ 对不上'}  ${r.note}`)
}
const bad = table.filter((r) => !r.ok)

// ⑥ 空头支票扫描：界面上有、但**没有任何数据支撑**的东西
console.log('\n【空头支票扫描】界面写了、数据里找不到出处的')
const cheques = []
// 图例里的「半透明 陈旧」：现在有 fresh 支撑 ⇒ 不该算支票
// 标记要用**压缩不会改**的东西：中文串比 '<0.55' 稳（压缩会把 0.55 写成 .55 —— 踩过）
const clientHasStale = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'lib', 'client.js'), 'utf-8').includes('陈旧（超过半衰期没被访问）')
if (!list.entries.some((e) => typeof e.fresh === 'number')) {
  cheques.push(clientHasStale
    ? '图例「半透明 陈旧」：**客户端代码已实现**（fresh<0.5 ⇒ opacity .55），但**进程是旧构建** ⇒ 等重启，⛔ 不算支票'
    : '图例「半透明 陈旧」：客户端没有判定、数据也没有 fresh ⇒ **真空头支票**')
}
// 图例「实心 活跃 / 空心 失效」：需要 status
if (!list.entries.some((e) => e.status)) cheques.push('图例「空心 失效」：没有 status 字段 ⇒ 无法判定')
// 球的连线要有 kind/type 来源
const kinds = new Set((graph.links ?? []).map((l) => l.type ?? l.kind ?? '?'))
if (kinds.size <= 1 && (graph.links?.length ?? 0) > 0) cheques.push(`球的连线只有一种类型（${[...kinds].join(',')}）—— 图例画了三种链`)
console.log(cheques.length ? cheques.map((x) => '  ⛔ ' + x).join('\n') : '  ✅ 没发现空头支票（每样都有数据支撑）')

// ⑦ 衰减扫描
console.log(decay
  ? `\n【衰减】lastAt=${decay.lastAt ? new Date(decay.lastAt).toLocaleString('zh-CN') : '从未跑'} · 上次归档 ${decay.lastCount} 条 · 已撤销=${decay.rolledBack}`
  : `\n【衰减】\`/decay-state\` 取不到：${decayErr}（⛔ 先看这句话，别急着判断是不是旧构建）`)
console.log(`\n结论：对不上 ${bad.length} 项 / 共 ${table.length} 项；空头支票 ${cheques.length} 处。\n`)
process.exit(bad.length || cheques.length ? 1 : 0)
