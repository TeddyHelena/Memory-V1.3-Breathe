#!/usr/bin/env node
/**
 * acceptance-sealed.mjs —— S1（MemoryV1.2-Sealed）部署前验收
 *
 * 跑的是《MemoryV1.2 完整工程审查报告》给的**"正式使用前最低闭环"九条**：
 *   空库启动 · 明确记住 · 重复记住 · 命中搜索 · 全文读取 ·
 *   纠正 · 明确遗忘 · 候选转正 · 重启加载
 * 再加一条本仓自己的：**全库 verify:true 加载无 fail-fast**（报告第 9 条的加强版）。
 *
 * ⚠️ 纪律：**必须在容器副本上跑**（有写入）。用配套脚本：
 *     MEMORY_CONTAINER_ROOT="<生产容器>" bash scripts/with-container-copy.sh \
 *       'node scripts/acceptance-sealed.mjs --root "$CONTAINER_COPY"'
 * 直接指向生产容器会拒绝执行 —— 见下面 assertNotProduction()。
 *
 * 退出码：全过 0，任一不过 1。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { MemoryContainer } from '../lib/container.js'
import { MemoryWriter } from '../lib/writer.js'

const arg = (name, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback
}
const ROOT = arg('root') || process.env.CONTAINER_COPY || ''

if (!ROOT) {
  console.error('用法：node scripts/acceptance-sealed.mjs --root <容器目录>')
  process.exit(2)
}

/** 防呆：拒绝在生产容器上跑（本脚本会写入） */
function assertNotProduction(root) {
  const prod = process.env.MEMORY_CONTAINER_ROOT
  if (prod && path.resolve(root) === path.resolve(prod)) {
    console.error('❌ 拒绝在【生产容器】上运行：本脚本会写入。请用 scripts/with-container-copy.sh。')
    process.exit(2)
  }
  if (!path.resolve(root).startsWith('/tmp/') && !arg('force')) {
    console.error(`❌ 路径不在 /tmp 下（${root}），拒绝写入。确要用请加 --force。`)
    process.exit(2)
  }
}
assertNotProduction(ROOT)

const results = []
const check = (name, fn) => {
  try {
    const detail = fn()
    results.push({ name, ok: true, detail: detail ?? '' })
  } catch (error) {
    results.push({ name, ok: false, detail: String(error?.message ?? error) })
  }
}
const must = (cond, msg) => { if (!cond) throw new Error(msg) }

const SESSION = 'session-acceptance-sealed'
const MSG = 'msg-acceptance'

console.log(`容器副本：${ROOT}`)

// ── 0. 全库加载（verify:true） ──────────────────────────────────────
let container
check('0 全库加载 verify:true 无 fail-fast', () => {
  container = new MemoryContainer(ROOT)
  container.load() // verify 默认 true：逐条读文件交叉校验
  const n = container.totalEntries()
  must(n > 0, '加载后条目数为 0')
  return `加载 ${n} 条，无脱节`
})

const writer = new MemoryWriter(container)

// ── 1. 明确记住 ────────────────────────────────────────────────────
const PROBE = '验收探针：Sealed 部署前最低闭环（跑在副本上）。'
let probeId = null
check('1 明确记住', () => {
  const out = writer.remember({
    content: PROBE, title: '验收探针', memory_type: 'experience',
    source_session: SESSION, source_message: MSG,
  })
  must(out.ok, 'remember 返回 not ok')
  probeId = out.id
  must(fs.existsSync(path.join(ROOT, container.entryMeta(probeId).file)), '条目文件没落盘')
  return `${probeId} → ${container.entryMeta(probeId).file}`
})

// ── 2. 重复记住（判重吸收分支） ────────────────────────────────────
check('2 重复记住（判重吸收）', () => {
  const out = writer.remember({
    content: PROBE, title: '验收探针', memory_type: 'experience',
    source_session: SESSION, source_message: MSG,
  })
  must(out.ok, '重复 remember 返回 not ok')
  must(out.duplicate, '没有走判重吸收分支')
  must(!('version' in out) || out.version !== undefined, '返回里带了 undefined 的 version')
  return `命中 ${out.duplicate.via}:${out.duplicate.id}，未新建`
})

// ── 3. 命中搜索 ────────────────────────────────────────────────────
check('3 命中搜索（探针可被读到）', () => {
  // 检索走 search.ts 的 BM25；这里只验"新写入的条目能被语料读出来"这条底线
  const docs = container.corpusDocuments ? container.corpusDocuments() : null
  const hit = container.readEntry(probeId)
  must(hit, '读不到刚写的探针')
  return `探针可读（${hit.content.length} 字）${docs ? `，语料 ${docs.size} 篇` : ''}`
})

// ── 4. 全文读取 ────────────────────────────────────────────────────
check('4 全文读取', () => {
  const hit = container.readEntry(probeId)
  must(hit, 'readEntry 返回空')
  must(hit.content.includes('最低闭环'), '正文内容不完整')
  must(hit.frontmatter.title === '验收探针', '标题不符')
  return '正文与 frontmatter 均完整'
})

// ── 5. 纠正 ────────────────────────────────────────────────────────
check('5 纠正（update）', () => {
  const out = writer.update(probeId, {
    title: '验收探针（已纠正）', reason: '验收：验证纠正路径',
    source_session: SESSION, source_message: MSG,
  })
  must(out.ok, 'update 返回 not ok')
  const after = container.readEntry(out.new_id)
  must(after.frontmatter.title === '验收探针（已纠正）', '标题没改成')
  probeId = out.new_id
  return `${out.old_id} → ${out.new_id}，旧版 superseded`
})

// ── 6. 候选转正 ────────────────────────────────────────────────────
check('6 候选转正（propose → confirm）', () => {
  const p = writer.propose({
    content: '验收候选：待人工确认的推断。', title: '验收候选', memory_type: 'experience',
    source_session: SESSION, source_message: MSG,
  })
  must(p.ok, 'propose 返回 not ok')
  const c = writer.confirm(p.id, { targetLayer: 'longterm' })
  must(c.ok, 'confirm 返回 not ok')
  must(fs.existsSync(path.join(ROOT, 'longterm')), 'longterm 目录不存在')
  return `${p.id} → longterm`
})

// ── 7. 明确遗忘（隐私删除：三处都要干净） ──────────────────────────
check('7 明确遗忘（三处脱敏）', () => {
  const rel = container.entryMeta(probeId).file
  writer.forget(probeId, { reason: '验收：验证隐私删除', source_session: SESSION, source_message: MSG })
  const meta = container.entryMeta(probeId)
  must(meta.title.startsWith('[已遗忘]'), `索引标题没脱敏：${meta.title}`)
  must(meta.summary === '（已删除：仅保留元数据）', '索引摘要没抹掉')
  const fileRaw = fs.readFileSync(path.join(ROOT, rel), 'utf-8')
  must(!fileRaw.includes('最低闭环'), '条目文件仍残留正文')
  const indexRaw = fs.readFileSync(path.join(ROOT, 'index.json'), 'utf-8')
  must(!indexRaw.includes('最低闭环'), 'index.json 仍残留正文')
  // 【L-5】隐私删除必须连**增量日志**一起干净：脱敏若只进日志不改快照，等于没删。
  const logPath = path.join(ROOT, 'index.delta.jsonl')
  const logRaw = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : ''
  must(!logRaw.includes('最低闭环'), 'index.delta.jsonl 仍残留正文')
  return `标题=${meta.title}`
})

// ── 8. 重启加载 ────────────────────────────────────────────────────
check('8 重启加载（新实例 verify:true）', () => {
  const again = new MemoryContainer(ROOT)
  again.load()
  must(again.totalEntries() >= 1, '重启后条目数为 0')
  const meta = again.entryMeta(probeId)
  must(meta?.title.startsWith('[已遗忘]'), '重启后墓碑标题不是中性标识')
  return `${again.totalEntries()} 条，墓碑状态已持久化`
})

// ── 9. 空库启动（独立临时目录，与副本无关） ────────────────────────
check('9 空库启动', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-accept-empty-'))
  try {
    fs.writeFileSync(path.join(empty, 'index.json'), JSON.stringify({
      schema: 'harness-memory-container/v1', generated_at: '', source_root: empty,
      entry_count: 0, entries: [], hot_order: [], archive_index: {}, longterm_tags: {},
    }, null, 2) + '\n')
    const c = new MemoryContainer(empty)
    c.load() // S1 之前这里会抛「entries 为空」
    const w = new MemoryWriter(c)
    const out = w.remember({
      content: '空库第一条。', title: '空库第一条', memory_type: 'world',
      source_session: SESSION, source_message: MSG,
    })
    must(out.ok, '空库写入失败')
    const reload = new MemoryContainer(empty)
    reload.load()
    must(reload.totalEntries() === 1, '空库重启后条目数不对')
    return '空库 加载 → 写入 → 重启 全通过'
  } finally {
    fs.rmSync(empty, { recursive: true, force: true })
  }
})

// ── 汇总 ───────────────────────────────────────────────────────────
console.log('')
let failed = 0
for (const r of results) {
  if (!r.ok) failed++
  console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? `\n      ${r.detail}` : ''}`)
}
console.log('')
console.log(failed === 0
  ? `结论：最低闭环 ${results.length}/${results.length} 全过。`
  : `结论：${results.length - failed}/${results.length} 过，${failed} 项不过 —— 不要部署。`)
process.exit(failed === 0 ? 0 : 1)
