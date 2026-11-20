#!/usr/bin/env node
/**
 * ⭐ 活性哨兵（L2 · 迁移第九件 · 2026-10-15 事故逼出来的）
 *
 * ## 为什么必须有
 *
 * 下午的生产事故暴露了一件事：**记忆系统静默缺席 35 分钟，零告警**——
 * 唯一信号是"侧边栏面板看不见"（那还只是"看不见"，引擎侧完全没声）。
 * 账本 `injection-ledger` 断档 1h50m，而它**零读取方** ⇒ 断档永远不会被发现。
 *
 * ⇒ **"写者死了"与"冻结成功"看起来一模一样** ⇒ 迁移窗口"冻结全部写者"**不可判定**。
 * ⇒ 这就是"**让沉默能红**"：与"沉默不等于决定"同一个机制家族。
 *
 * ## 判据（⛔ 两条都可机械判定）
 *
 *   ① **写入活性**：容器里最新一次写入距今 > `--max-idle-hours`（默认 24）⇒ **红**
 *   ② **插件活性**（给了 `--api` 才查）：宿主 API 不返回 200 ⇒ **红**
 *
 * ## 用法
 *
 *   node scripts/aliveness-check.mjs
 *   node scripts/aliveness-check.mjs --root <容器> --max-idle-hours 12
 *   node scripts/aliveness-check.mjs --api http://127.0.0.1:19387 --token-file ~/.dsh/memory-api-token
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const argv = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}

const ROOT =
  arg('root') ??
  path.join(os.homedir(), 'Documents/Obsidian Vault/00_记忆系统/dsh-memory-container')
const MAX_IDLE_H = Number(arg('max-idle-hours', '24'))
const API = arg('api', '')
const TOKEN_FILE = arg('token-file', path.join(os.homedir(), '.dsh/memory-api-token'))

/** 参与"写入活性"的文件（⛔ 只读 mtime，不读内容） */
const WITNESS_FILES = [
  'injection-ledger.jsonl',
  'index.json',
  '.decay-sweep.json',
  '.decay-audit.jsonl',
  '.decay-intent.jsonl',
  '.decay-startup.jsonl',
]

function newestWrite() {
  let best = null
  for (const f of WITNESS_FILES) {
    const p = path.join(ROOT, f)
    try {
      const st = fs.statSync(p)
      if (!best || st.mtimeMs > best.ms) best = { ms: st.mtimeMs, file: f }
    } catch {
      /* 文件不存在不算红（有的容器没有全部账本） */
    }
  }
  return best
}

async function pluginAlive() {
  if (!API) return null
  let token = ''
  try {
    token = fs.readFileSync(TOKEN_FILE, 'utf-8').trim()
  } catch {
    return { ok: false, why: `读不到 token 文件 ${TOKEN_FILE}` }
  }
  try {
    const res = await fetch(`${API.replace(/\/$/, '')}/api/memory/decay-state`, {
      headers: { 'x-memory-token': token },
      signal: AbortSignal.timeout(5000),
    })
    return res.ok ? { ok: true, status: res.status } : { ok: false, why: `HTTP ${res.status}` }
  } catch (e) {
    return { ok: false, why: `请求失败：${e?.message ?? e}` }
  }
}

const problems = []

// ① 写入活性
const nw = newestWrite()
if (!nw) {
  problems.push(`容器里 ${WITNESS_FILES.length} 个见证文件**一个都不存在** ⇒ 红（${ROOT}）`)
} else {
  const idleH = (Date.now() - nw.ms) / 3_600_000
  // ⚠️ 用**本地时间**显示（`toISOString` 是 UTC，实测显示成 07:53 而真实是 15:53 ⇒ 会误导）
  const d = new Date(nw.ms)
  const p2 = (n) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
  if (idleH > MAX_IDLE_H) {
    problems.push(
      `**写入静默 ${idleH.toFixed(1)} 小时**（阈值 ${MAX_IDLE_H}h）—— 最新写入是 ${stamp} 的 ${nw.file}`,
    )
  }
  console.log(`  最新写入：${stamp} ｜ ${nw.file} ｜ 静默 ${idleH.toFixed(1)} 小时`)
}

// ② 插件活性
const alive = await pluginAlive()
if (alive) {
  if (alive.ok) console.log(`  宿主 API：HTTP ${alive.status} ⇒ 插件在`)
  else problems.push(`**宿主 API 不通**：${alive.why}`)
}

if (problems.length) {
  console.error('')
  for (const p of problems) console.error(`  ⛔ ${p}`)
  console.error('')
  console.error('  活性哨兵：红（详见上）')
  process.exit(1)
}
console.log('  活性哨兵：绿')
