#!/usr/bin/env node
/**
 * crash-recovery.mjs —— 崩溃恢复台子（Ledger · L-1）
 *
 * ════════════════════════════════════════════════════════════════════
 * 判据（施工单 §三 L-1）
 * ════════════════════════════════════════════════════════════════════
 *   子进程在「文件已移动、索引未提交」处被杀 → 重启**可恢复**，**不阻断加载**。
 *
 * ════════════════════════════════════════════════════════════════════
 * 怎么造假崩溃（不是模拟，是真杀）
 * ════════════════════════════════════════════════════════════════════
 *   worker 进程里把 `container.saveIndex` 换成"自杀"（`process.kill(pid, 'SIGKILL')`），
 *   然后**真的执行一次 `writer.confirm`（候选转正）**：
 *     ① 文件已写到 pending/ ② 文件被移动/写到 longterm/ ③ syncEntryMeta 改了内存索引
 *     ④ finishIndex() → saveIndex() ⇒ **在这里被 SIGKILL** ⇒ 索引仍是"文件在 pending/"。
 *   SIGKILL 不可捕获、不留清理钩子 ⇒ 正好是断电那一刀。
 *
 * ════════════════════════════════════════════════════════════════════
 * 父进程看三件
 * ════════════════════════════════════════════════════════════════════
 *   ① 诊断：索引说的位置 vs 文件实际位置（确认窗口真的被踩到）
 *   ② `load({verify:true})` 能不能起来（**不阻断加载**）
 *   ③ 恢复**有没有留痕**（`container.repairEvents`，⛔ 不许静默修）
 *
 * 用法：
 *   node scripts/crash-recovery.mjs                # 默认跑一轮
 *   node scripts/crash-recovery.mjs --rounds 5
 * 退出码：0 = 三轮全过；1 = 出现阻断加载 / 无痕修复；2 = 参数错
 *
 * ⚠️ 全程在**临时目录**里跑，⛔ 不碰生产容器。
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
// worker 分支：真执行一次转正，并在索引提交处自杀
// ════════════════════════════════════════════════════════════════════
if (arg('worker', '')) {
  const root = path.resolve(arg('root', ''))
  const id = arg('id', '')
  const container = new MemoryContainer(root)
  container.load()
  const writer = new MemoryWriter(container)
  // ④ 索引提交那一刻 —— 就是这一刀
  container.saveIndex = function () { process.kill(process.pid, 'SIGKILL') }
  writer.confirm(id, { operator: 'crash-test' })
  process.exit(0)   // 理论上到不了这里
}

// ════════════════════════════════════════════════════════════════════
// harness 分支
// ════════════════════════════════════════════════════════════════════
const ROUNDS = Number(arg('rounds', 3))
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crashrec-'))

/** 造一个干净容器 + 一条候选（用真写路径，别手搓文件） */
const prepare = (dir) => {
  for (const d of ['hot', 'longterm', 'archive', 'pending']) fs.mkdirSync(path.join(dir, d), { recursive: true })
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({
    schema: 'harness-memory-container/v1', generated_at: new Date().toISOString(),
    source_root: dir, entry_count: 0, entries: [], hot_order: [], archive_index: {}, longterm_tags: {},
  }, null, 2) + '\n', 'utf-8')
  const c = new MemoryContainer(dir)
  c.load()
  const w = new MemoryWriter(c)
  const out = w.propose({
    content: '崩溃注入用候选：这条会在转正途中被 SIGKILL 打断。',
    title: '崩溃注入候选', memory_type: 'opinion',
    source_session: 'crash', source_message: 'msg-1',
  })
  return out.id
}

const results = []
for (let round = 1; round <= ROUNDS; round++) {
  const dir = path.join(tmpRoot, `r${round}`)
  fs.mkdirSync(dir, { recursive: true })
  const id = prepare(dir)
  const before = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf-8'))
  const idxFile = before.entries.find((e) => e.id === id)?.file

  // —— 真杀 ——
  const exit = await new Promise((resolve) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--worker', '1', '--root', dir, '--id', id], { stdio: 'ignore' })
    child.on('exit', (code, signal) => resolve({ code, signal }))
  })

  // —— 诊断：索引说的 vs 实际在的 ——
  const idxNow = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf-8'))
  const idxSays = idxNow.entries.find((e) => e.id === id)?.file
  const idxSaysExists = idxSays ? fs.existsSync(path.join(dir, idxSays)) : null
  const actual = []
  for (const layer of ['pending', 'longterm', 'archive', 'hot']) {
    for (const f of fs.readdirSync(path.join(dir, layer))) if (f.startsWith(`${id}.md`) || f.startsWith(`${id}_`)) actual.push(`${layer}/${f}`)
  }

  // —— ② 能不能起来 ——
  let loadOk = true
  let loadErr = ''
  let repaired = false
  let traceCount = 0
  let resolvedTo = ''
  try {
    const c2 = new MemoryContainer(dir)
    c2.load({ verify: true })
    repaired = true
    traceCount = (c2.repairEvents ?? []).length
    resolvedTo = c2.entryMeta(id)?.file ?? ''
  } catch (error) {
    loadOk = false
    loadErr = String(error?.message ?? error).slice(0, 90)
  }

  // —— ④ 崩溃后**立刻**还能不能写（陈旧锁必须被接管；⛔ 不许让用户等 60 秒）——
  // 【Ledger · L-1×L-2】真实现场：崩溃留下锁文件 → 重启后写入被自己的锁挡住，
  // 文案还让人"关闭另一个 DSH 实例"（那个实例就是刚崩掉的自己）。
  let writeOk = false, writeMs = 0, writeErr = ''
  if (loadOk) {
    const c4 = new MemoryContainer(dir)
    c4.load()
    const w4 = new MemoryWriter(c4)
    const s = Date.now()
    try {
      w4.remember({ content: '崩溃后立刻写入探针。', title: '崩溃后写入', memory_type: 'world', source_session: 'crash', source_message: `after-${round}` })
      writeOk = true
    } catch (error) { writeErr = String(error?.message ?? error).slice(0, 80) }
    writeMs = Date.now() - s
  }

  // —— ⑤ 收敛性：自愈必须**落盘**，否则每次 load 都得再修一遍 ——
  // 判据：崩溃 → 自愈 → 写一次 → **再起一次不该再报修复**（repairEvents 归零）。
  let converged = false
  let reRepairs = -1
  if (writeOk) {
    const c5 = new MemoryContainer(dir)
    c5.load({ verify: true })
    reRepairs = c5.repairEvents.length
    converged = reRepairs === 0
  }

  const r = { round, signal: exit.signal, killed: exit.signal === 'SIGKILL', idxSays, idxSaysExists, actual, loadOk, loadErr, repaired, traceCount, resolvedTo, writeOk, writeMs, writeErr, converged, reRepairs }
  results.push(r)
  console.log(`── 第 ${round} 轮`)
  console.log(`   ① 被 ${exit.signal ?? `exit ${exit.code}`} 打断 ｜ 索引说文件在 ${idxSays}${idxSaysExists === false ? '（**不存在**）' : ''}`)
  console.log(`      文件实际在 ${actual.join(' / ') || '（找不到）'}`)
  console.log(`   ② load(verify:true)：${loadOk ? '✅ 起得来' : `❌ 被阻断 —— ${loadErr}`}`)
  console.log(`   ③ 恢复留痕：${repaired ? (traceCount > 0 ? `✅ ${traceCount} 条（新位置 ${resolvedTo}）` : '❌ **无痕**') : '—'}`)
  console.log(`   ④ 崩溃后立刻可写：${writeOk ? `✅ ${writeMs}ms` : `❌ ${writeErr}`}`)
  console.log(`   ⑤ 收敛（再起一次不该再修）：${converged ? '✅ 0 条修复' : `❌ 又报了 ${reRepairs} 条`}\n`)
}

const blocked = results.filter((r) => !r.loadOk).length
const silent = results.filter((r) => r.loadOk && r.repaired && r.traceCount === 0).length
const stuck = results.filter((r) => r.loadOk && !r.writeOk).length
const unconverged = results.filter((r) => r.writeOk && !r.converged).length
const windowHit = results.filter((r) => r.idxSaysExists === false).length
console.log('──── 汇总 ────')
console.log(`踩中窗口（索引指向了不存在的文件）：${windowHit}/${ROUNDS} 轮`)
console.log(`阻断加载：${blocked}/${ROUNDS} ｜ 无痕修复：${silent}/${ROUNDS} ｜ 崩溃后写不进去：${stuck}/${ROUNDS} ｜ 不收敛（反复修）：${unconverged}/${ROUNDS}`)
console.log(`\n结论：${blocked === 0 && silent === 0 && stuck === 0 && unconverged === 0 ? '✅ 崩溃后能起来、留痕、立刻能写、且收敛' : `❌ L-1 未达标（阻断 ${blocked} / 无痕 ${silent} / 写不了 ${stuck} / 不收敛 ${unconverged}）`}`)
fs.rmSync(tmpRoot, { recursive: true, force: true })
process.exit(blocked === 0 && silent === 0 && stuck === 0 && unconverged === 0 ? 0 : 1)
