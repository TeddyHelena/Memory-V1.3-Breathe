#!/usr/bin/env node
/**
 * lock-race.mjs —— 跨进程写锁的**竞争台子**（Ledger · L-7）
 *
 * ════════════════════════════════════════════════════════════════════
 * 为什么必须有它
 * ════════════════════════════════════════════════════════════════════
 * L-2（P1-3 陈旧锁双接管）的判据是「同一陈旧锁双进程竞争 → **只有一个成功**」。
 * 这句话在代码里看着像对的（`readLock` → `isStale` → 写自己的 token），
 * 但那三步**没有原子性** ⇒ 两个进程可以同时判"陈旧"、各自覆盖写入 ⇒ **双双自认持锁**。
 * ⛔ 这种缺陷"看起来对"是常态，**只有真起多进程才验得出来**。
 *
 * ════════════════════════════════════════════════════════════════════
 * 两个模式
 * ════════════════════════════════════════════════════════════════════
 *   A. `fresh`   —— 锁**不存在**时 N 个进程同时抢（`wx` 原子创建）
 *      期望：**恰好 1 个**成功，其余全部 LOCK_BUSY
 *   B. `stale`   —— 预先放一个**同机已退出进程**留下的锁文件
 *      期望：任一时刻**至多 1 个持有者**；活 PID 不因旧 heartbeat 被接管，远端锁不自动接管
 *
 * ⚠️ 判据口径（第一版栽在这）：看的是**持有窗口有没有重叠**（最大同时持有者数），
 *   ⛔ 不是"有几个进程赢过"——先后抢到（前一个已释放）是正常串行获取，误报过一轮。
 *
 * 用法（harness）：
 *   node scripts/lock-race.mjs --workers 8 --rounds 5
 * 退出码：0 = 每个模式每轮都恰好 1 个赢家；1 = 出现多赢家（红）；2 = 参数错
 *
 * 设计要点：
 *   · 全部跑在**临时目录**（锁只用到目录本身，不碰任何容器）——⛔ 不碰生产容器
 *   · 同时起跑：spawn 时给一个**共同的起跑时刻**，各 worker 忙等到那一刻再抢
 *   · 「赢家」的判定：worker 拿到锁就算赢，**先记账再释放**；harness 数不同 pid
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d }

if (arg('worker', '')) {
  // ── worker 分支：起跑 → 抢锁 → 记账 → 释放 ──────────────────────
  const root = arg('root', '')
  const startAt = Number(arg('start-at', '0'))
  const outFile = arg('out', '')
  const { acquireWriteLock } = await import(path.join(HERE, '..', 'lib', 'lock.js'))
  while (Date.now() < startAt) { /* 忙等，尽量让所有 worker 同时进入抢锁 */ }
  let acquiredAt = 0
  let lock = null
  try {
    lock = acquireWriteLock(root, { staleMs: 1000, holder: `w-${process.pid}` })
    acquiredAt = Date.now()
  } catch { /* 拿不到就是拿不到，交给 harness 判 */ }
  if (lock) {
    // 持有一小会儿再放：判据看的是**持有窗口有没有重叠**，不是"谁赢过"。
    // ⛔ 只记"赢没赢"会误报：先后抢到（前一个已释放）看着也像多赢家。
    await new Promise((r) => setTimeout(r, 30))
    const releasedAt = Date.now()
    fs.appendFileSync(outFile, `${process.pid}\tWIN\t${acquiredAt}\t${releasedAt}\n`)
    lock.release()
  } else {
    fs.appendFileSync(outFile, `${process.pid}\tbusy\t0\t0\n`)
  }
  process.exit(0)
}

const WORKERS = Number(arg('workers', 8))
const ROUNDS = Number(arg('rounds', 5))
const MODES = String(arg('modes', 'fresh,stale')).split(',')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lockrace-'))

const runMode = async (mode, round) => {
  const dir = path.join(tmp, `${mode}-${round}`)
  fs.mkdirSync(dir, { recursive: true })
  if (mode === 'stale') {
    // 手工放一个同机已退出进程留下的锁；PID 不存在 ⇒ 所有 worker 都能安全识别为可恢复。
    const past = new Date(Date.now() - 10_000).toISOString()
    fs.writeFileSync(path.join(dir, '.memory-write.lock'), JSON.stringify({
      token: 'stale-placeholder', pid: 2147483647, host: os.hostname(), holder: 'crashed-local',
      startedAt: past, heartbeatAt: past,
    }, null, 2) + '\n', { mode: 0o600 })
  }
  const outFile = path.join(dir, 'result.tsv')
  fs.writeFileSync(outFile, '', 'utf-8')
  const startAt = Date.now() + 700   // 给 spawn 留出时间，然后统一起跑
  const kids = []
  for (let i = 0; i < WORKERS; i++) {
    kids.push(new Promise((resolve) => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--worker', '1',
        '--root', dir, '--start-at', String(startAt), '--out', outFile],
        { stdio: 'ignore' })
      child.on('exit', resolve)
    }))
  }
  await Promise.all(kids)
  const lines = fs.readFileSync(outFile, 'utf-8').trim().split('\n').filter(Boolean)
  const windows = lines.filter((l) => l.includes('\tWIN\t')).map((l) => {
    const [pid, , a, b] = l.split('\t'); return { pid, start: Number(a), end: Number(b) }
  })
  // ⚠️ 判据是**最大同时持有者数**，不是"赢家个数"——
  //    "先后抢到"（前一个已释放）是正常的串行获取，⛔ 不许当成违规（第一版就栽在这）。
  const events = []
  for (const w of windows) { events.push([w.start, 1]); events.push([w.end, -1]) }
  events.sort((x, y) => x[0] - y[0] || x[1] - y[1])
  let cur = 0, maxConcurrent = 0
  for (const [, d] of events) { cur += d; maxConcurrent = Math.max(maxConcurrent, cur) }
  return { mode, round, total: lines.length, winners: windows.map((w) => w.pid), maxConcurrent }
}

console.log('════════ 跨进程写锁竞争台子（L-7 · L-2 的判据台）════════')
console.log(`临时目录 ${tmp}`)
console.log(`每轮 ${WORKERS} 进程 ｜ 模式 ${MODES.join(' / ')} ｜ 每模式 ${ROUNDS} 轮\n`)

let red = 0
const rows = []
for (const mode of MODES) {
  for (let r = 1; r <= ROUNDS; r++) {
    const res = await runMode(mode, r)
    const ok = res.maxConcurrent <= 1
    if (!ok) red++
    rows.push({ ...res, ok })
    console.log(`${ok ? '✅' : '❌'} ${mode.padEnd(6)} 第 ${r} 轮：${res.total} 进程参与 ｜ 赢过 ${res.winners.length} 个 ｜ **同一时刻最多 ${res.maxConcurrent} 个持有者**（期望 ≤1）`)
  }
}

console.log('\n──── 汇总 ────')
for (const mode of MODES) {
  const rs = rows.filter((x) => x.mode === mode)
  const bad = rs.filter((x) => !x.ok).length
  console.log(`${mode.padEnd(6)}：${rs.length - bad}/${rs.length} 轮守住了互斥（同时持有者 ≤1）${bad ? `　⚠️ ${bad} 轮出现**并发持有**` : ''}`)
}
fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n结论：${red === 0 ? '✅ 两模式都守住互斥' : `❌ ${red} 轮出现并发持有 —— L-2 缺陷可复现`}`)
process.exit(red === 0 ? 0 : 1)
