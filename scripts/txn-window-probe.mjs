#!/usr/bin/env node
/**
 * txn-window-probe.mjs —— 量「崩溃窗口有多宽」（Ledger · L-1 配套）
 *
 * ════════════════════════════════════════════════════════════════════
 * 为什么必须量它
 * ════════════════════════════════════════════════════════════════════
 * 崩溃恢复台子（`crash-recovery.mjs`）证明的是「窗口被踩中 ⇒ 插件起不来」，
 * 但它**没回答"撞上这个窗口的概率有多大"**。概率 ≈ 窗口宽度 ÷ 写入总耗时，
 * 所以要量的是：**从"条目文件落定"到"索引开始提交"之间有多长时间**。
 *
 * ════════════════════════════════════════════════════════════════════
 * 怎么量（只读地"看"，不改事务逻辑）
 * ════════════════════════════════════════════════════════════════════
 *   钩住两处：
 *     · `container.atomicWrite` —— 条目文件的落盘出口
 *     · `container.saveIndex`  —— **索引提交点**
 *   窗口 = **最后一次条目文件写入** → **索引提交开始** 的间隔。
 *   ⚠️ 【L-5 改判】原来把"index.json 的 atomicWrite"当提交点；追加式落盘之后，
 *      一次写入可能只往 `index.delta.jsonl` 追一条、压根不碰 index.json
 *      ⇒ 原判据会量到"窗口不存在"（数组空 ⇒ 直接崩）。改成钩 saveIndex 才是真正的提交时刻。
 *
 * 用法（跑在容器副本上）：
 *   MEMORY_CONTAINER_ROOT="<生产容器>" bash scripts/with-container-copy.sh \
 *     'node scripts/txn-window-probe.mjs --root "$CONTAINER_COPY" --rungs 105,2000,5000'
 */

import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d }
const ROOT = path.resolve(arg('root', ''))
const RUNGS = String(arg('rungs', '105,2000,5000')).split(',').map((x) => Number(x.trim())).filter(Boolean)
const ROUNDS = Number(arg('rounds', 10))
if (!arg('root', '')) { console.error('用法：node scripts/txn-window-probe.mjs --root <副本>'); process.exit(2) }
if (/00_记忆系统[\\/]dsh-memory-container$/.test(ROOT)) { console.error('❌ 拒绝在生产容器上跑'); process.exit(2) }

const { MemoryContainer } = await import(path.join(import.meta.dirname, '..', 'lib', 'container.js'))
const { MemoryWriter } = await import(path.join(import.meta.dirname, '..', 'lib', 'writer.js'))

const t = () => Number(process.hrtime.bigint() / 1000n) / 1000
const p50 = (a) => { const s = [...a].sort((x, y) => x - y); return Number(s[Math.floor((s.length - 1) / 2)].toFixed(3)) }
const p90 = (a) => { const s = [...a].sort((x, y) => x - y); return Number(s[Math.min(s.length - 1, Math.floor(s.length * 0.9))].toFixed(3)) }

const c = new MemoryContainer(ROOT)
c.load()
const w = new MemoryWriter(c)

let lastEntryWrite = 0
let firstIndexWrite = 0
const origAtomicWrite = c.atomicWrite.bind(c)
c.atomicWrite = function (p, text) {
  if (!String(p).endsWith('index.json')) lastEntryWrite = t()
  return origAtomicWrite(p, text)
}
// 索引提交点：saveIndex 一被调用就算（无论它走整份快照还是追一条日志）
const origSaveIndex = c.saveIndex.bind(c)
c.saveIndex = function (...args) {
  if (firstIndexWrite === 0) firstIndexWrite = t()
  return origSaveIndex(...args)
}

let built = c.getIndex().entries.length
let since = 0
const buildTo = (target) => {
  while (built < target) {
    const id = c.nextEntryId('longterm')
    c.addEntryFile({
      id, layer: 'longterm',
      frontmatter: {
        id, layer: 'longterm', title: `窗口探针语料 ${built}`, summary: `探针 ${built}`, tags: ['p'],
        priority: 50, updated: '2026-10-08', status: 'active', memory_type: 'world',
        source_session: 'p', source_message: `p${built}`,
      },
      content: `窗口探针第 ${built} 条。` + '补长度用。'.repeat(100),
    })
    built += 1
    if (++since >= 400) { c.saveIndex(); since = 0 }
  }
  if (since) { c.saveIndex(); since = 0 }
}

console.log('════════ 崩溃窗口宽度（L-1 配套）════════')
console.log(`副本 ${ROOT}\n`)
console.log('窗口 = 最后一次条目文件写入 → 第一次 index.json 写入（这中间被打断就会留下"索引指向缺失文件"）\n')

for (const N of RUNGS) {
  buildTo(N)
  const windows = []
  const totals = []
  for (let i = 0; i < ROUNDS; i++) {
    lastEntryWrite = 0; firstIndexWrite = 0
    const s = t()
    w.remember({
      title: `窗口探针写入 ${N}-${i}`, content: `窗口探针唯一内容 ${N}-${i} ${Math.random()}。`,
      memory_type: 'world', source_session: 'p', source_message: `w${N}${i}`,
    })
    totals.push(t() - s)
    if (lastEntryWrite && firstIndexWrite) windows.push(firstIndexWrite - lastEntryWrite)
  }
  const med = p50(windows), hi = p90(windows), total = p50(totals)
  console.log(`── ${N} 条`)
  console.log(`   窗口宽度 p50 ${med}ms ｜ p90 ${hi}ms ｜ 写入总耗时 p50 ${total}ms`)
  console.log(`   ⇒ 撞上概率量级 ≈ ${((med / total) * 100).toFixed(1)}%（窗口 ÷ 总耗时）\n`)
}
