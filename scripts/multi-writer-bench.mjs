#!/usr/bin/env node
/**
 * multi-writer-bench.mjs —— 多进程并发写入的**业务级判据**（Ledger · L-2/L-7）
 *
 * ════════════════════════════════════════════════════════════════════
 * 为什么光验"互斥"不够
 * ════════════════════════════════════════════════════════════════════
 * `lock-race.mjs` 验的是"同一时刻至多一个持有者"——那是**手段**。
 * 真正要的是：**几个进程各写各的，最后一条都不许少**（l57 那类事故的形态是
 * "刚记住的东西下一个会话没了"）。互斥守住了、写入照样可能被覆盖：
 * 每个进程启动时都加载一份索引，谁最后落盘谁说了算 ⇒ 后来者把别人的新增整份盖掉。
 *
 * ════════════════════════════════════════════════════════════════════
 * 判据
 * ════════════════════════════════════════════════════════════════════
 *   ① **丢写入 = 0**：每个"报成功"的 id 都必须真的在最终索引里、且文件在
 *   ② LOCK_BUSY 可以接受（拒绝是诚实的），但 `成功 + 失败 = 尝试总数`（不许静默吞）
 *   ③ 最终 `entry_count` 与实际 entries 一致；索引↔文件脱节 = 0
 *
 * 用法：node scripts/multi-writer-bench.mjs --workers 4 --writes 5 --rounds 3
 * 退出码：0 = 三判据全过；1 = 丢写入/脱节/计数不符；2 = 参数错
 *
 * ⚠️ 全程临时目录，⛔ 不碰生产容器。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d }

const { MemoryContainer } = await import(path.join(HERE, '..', 'lib', 'container.js'))
const { MemoryWriter } = await import(path.join(HERE, '..', 'lib', 'writer.js'))

// ════════════════════════════════════════════════════════════════════
// worker：独立进程、独立容器实例，各写各的
// ════════════════════════════════════════════════════════════════════
if (arg('worker', '')) {
  const root = path.resolve(arg('root', ''))
  const who = arg('who', 'w')
  const writes = Number(arg('writes', 5))
  const startAt = Number(arg('start-at', '0'))
  const outFile = arg('out', '')
  const container = new MemoryContainer(root)
  container.load()
  const writer = new MemoryWriter(container, { operator: `w-${who}` })
  while (Date.now() < startAt) { /* 统一起跑，制造真并发 */ }
  for (let i = 0; i < writes; i++) {
    const line = (status, detail) => fs.appendFileSync(outFile, `${who}\t${i}\t${status}\t${detail}\n`)
    try {
      const out = writer.remember({
        title: `并发写入 ${who}-${i}`,
        content: `并发写入唯一内容 ${who}-${i}-${process.pid}。`,
        memory_type: 'world',
        source_session: 'mw', source_message: `${who}-${i}`,
      })
      line(out.duplicate ? 'DUPLICATE' : 'OK', out.id ?? out.new_id ?? '')
    } catch (error) {
      const code = String(error?.code ?? '').includes('LOCK_BUSY') || /LOCK_BUSY/.test(String(error?.message)) ? 'BUSY' : 'ERR'
      line(code, String(error?.message ?? error).slice(0, 60).replace(/\s+/g, ' '))
    }
  }
  process.exit(0)
}

// ════════════════════════════════════════════════════════════════════
// harness
// ════════════════════════════════════════════════════════════════════
const WORKERS = Number(arg('workers', 4))
const WRITES = Number(arg('writes', 5))
const ROUNDS = Number(arg('rounds', 3))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multiwriter-'))

const prepare = (dir) => {
  for (const d of ['hot', 'longterm', 'archive', 'pending']) fs.mkdirSync(path.join(dir, d), { recursive: true })
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({
    schema: 'harness-memory-container/v1', generated_at: new Date().toISOString(),
    source_root: dir, entry_count: 0, entries: [], hot_order: [], archive_index: {}, longterm_tags: {},
  }, null, 2) + '\n', 'utf-8')
}

/**
 * 检查器（抽出来是为了能**单独校验它**——见 `--detector-control`）。
 * 判据：报成功的 id 必须真在最终索引里、文件读得到、计数守恒。
 */
function checkOutcome(dir, okLines, attempts) {
  const c = new MemoryContainer(dir)
  c.load({ verify: true })
  const idx = c.getIndex()
  const ids = new Set(idx.entries.map((e) => e.id))
  let missingFile = 0
  for (const e of idx.entries) if (!c.readEntry(e.id)) missingFile++
  const lost = okLines.filter((l) => {
    const id = l.split('\t')[3]
    return !id || !ids.has(id) || !c.readEntry(id)
  })
  return {
    entryCount: idx.entries.length, declared: idx.entry_count, missingFile, lost: lost.length,
    accountedOk: okLines.length >= 0 && idx.entries.length === idx.entry_count,
    ok: okLines.length, merges: c.getIndexMergeEvents().length,
  }
}

// ── 仪器校验：人为制造一次"静默丢失"，检查器必须报出来 ──────────────
if (arg('detector-control', '')) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detctrl-'))
  prepare(dir)
  const c = new MemoryContainer(dir)
  c.load()
  const w = new MemoryWriter(c, { operator: 'det' })
  const a = w.remember({ title: '仪器校验-甲', content: '仪器校验甲。', memory_type: 'world', source_session: 'd', source_message: 'd1' })
  const b = w.remember({ title: '仪器校验-乙', content: '仪器校验乙。', memory_type: 'world', source_session: 'd', source_message: 'd2' })
  const okLines = [`x\t0\tOK\t${a.id}`, `x\t1\tOK\t${b.id}`]
  const before = checkOutcome(dir, okLines, 2)
  // 【L-5】先让 verify 档把增量日志折平，再动快照 ——
  // 否则"抹掉"会被日志重放又带回来，人为丢失根本造不出来（仪器就验不成）。
  new MemoryContainer(dir).load({ verify: true })
  // 制造丢失：把乙从**快照**里静默抹掉（文件留着，模拟"被人覆盖了索引"）
  const idx = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf-8'))
  idx.entries = idx.entries.filter((e) => e.id !== b.id)
  idx.entry_count = idx.entries.length
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(idx, null, 2) + '\n')
  const after = checkOutcome(dir, okLines, 2)
  console.log('════════ 仪器校验：检查器抓不抓得住"静默丢失" ════════')
  console.log(`  制造丢失前：丢写入 ${before.lost}`)
  console.log(`  人为抹掉 ${b.id} 后：丢写入 ${after.lost}`)
  console.log(`\n结论：${before.lost === 0 && after.lost === 1 ? '✅ 仪器有分辨力（人为丢失被抓到）' : '❌ 检查器没抓到人为丢失'}`)
  fs.rmSync(dir, { recursive: true, force: true })
  process.exit(before.lost === 0 && after.lost === 1 ? 0 : 1)
}

console.log('════════ 多进程并发写入台子（L-2/L-7 业务级判据）════════')
console.log(`${WORKERS} 进程 × 每人 ${WRITES} 条 ｜ ${ROUNDS} 轮 ｜ 判据：**丢写入 = 0**\n`)

const rows = []
for (let round = 1; round <= ROUNDS; round++) {
  const dir = path.join(tmp, `r${round}`); fs.mkdirSync(dir, { recursive: true })
  prepare(dir)
  const outFile = path.join(dir, 'results.tsv'); fs.writeFileSync(outFile, '')
  const startAt = Date.now() + 700
  await Promise.all(Array.from({ length: WORKERS }, (_, i) => new Promise((resolve) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--worker', '1',
      '--root', dir, '--who', String(i + 1), '--writes', String(WRITES), '--start-at', String(startAt), '--out', outFile],
      { stdio: 'ignore' })
    child.on('exit', resolve)
  })))

  const lines = fs.readFileSync(outFile, 'utf-8').trim().split('\n').filter(Boolean)
  const ok = lines.filter((l) => l.split('\t')[2] === 'OK')
  const busy = lines.filter((l) => l.split('\t')[2] === 'BUSY').length
  const dup = lines.filter((l) => l.split('\t')[2] === 'DUPLICATE').length
  const err = lines.filter((l) => l.split('\t')[2] === 'ERR').length

  const c = new MemoryContainer(dir)
  c.load({ verify: true })
  const idx = c.getIndex()
  const ids = new Set(idx.entries.map((e) => e.id))
  let missingFile = 0
  for (const e of idx.entries) if (!c.readEntry(e.id)) missingFile++

  // ① 丢写入：报成功的 id 必须真在索引里、且文件读得到
  const lost = ok.filter((l) => {
    const id = l.split('\t')[3]
    return !id || !ids.has(id) || !c.readEntry(id)
  })
  // ② 计数守恒
  const accounted = ok.length + busy + dup + err
  const attempts = WORKERS * WRITES
  const r = {
    round, attempts, ok: ok.length, busy, dup, err,
    entryCount: idx.entries.length, declared: idx.entry_count, missingFile,
    lost: lost.length, accountedOk: accounted === attempts,
    merges: c.getIndexMergeEvents().length,
  }
  rows.push(r)
  const pass = r.lost === 0 && r.missingFile === 0 && r.accountedOk && r.entryCount === r.declared && r.ok === r.entryCount
  console.log(`── 第 ${round} 轮`)
  console.log(`   尝试 ${r.attempts} ｜ ✅成功 ${r.ok} ｜ 忙(LOCK_BUSY) ${r.busy} ｜ 判重 ${r.dup} ｜ 其它错 ${r.err}`)
  console.log(`   最终索引 ${r.entryCount} 条（声明 ${r.declared}）｜ 文件缺失 ${r.missingFile} ｜ 合并事件 ${r.merges}`)
  console.log(`   **丢写入 ${r.lost}** ｜ 计数守恒 ${r.accountedOk ? '✅' : '❌'} ｜ ${pass ? '✅ 过' : '❌ 不过'}\n`)
}

const badLost = rows.reduce((a, r) => a + r.lost, 0)
const badDrift = rows.reduce((a, r) => a + r.missingFile, 0)
const badCount = rows.filter((r) => !r.accountedOk || r.entryCount !== r.declared || r.ok !== r.entryCount).length
console.log('──── 汇总 ────')
console.log(`丢写入合计 ${badLost} 条 ｜ 脱节合计 ${badDrift} ｜ 计数不符 ${badCount} 轮`)
const busyTotal = rows.reduce((a, r) => a + r.busy, 0)
console.log(`（参考：LOCK_BUSY 合计 ${busyTotal} 次 —— 拒绝是诚实的，不计为失败）`)
console.log(`\n结论：${badLost === 0 && badDrift === 0 && badCount === 0 ? '✅ 并发写入一条都没丢' : '❌ 出现丢写入 / 脱节 / 计数不符'}`)
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(badLost === 0 && badDrift === 0 && badCount === 0 ? 0 : 1)
