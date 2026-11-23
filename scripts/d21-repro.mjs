#!/usr/bin/env node
/**
 * D21 复现器（2026-11-22）
 *
 * 目的：把 `test/concurrency.test.mjs` 第三条用例（同一底座只允许一个 active 头）
 * 从 `node --test` 里剥出来，**按原样**循环跑，一旦红就 dump 现场并停下。
 *
 * 与测试用例的差异（必须只有这三处，否则复现概率就不是同一件事）：
 *   1. 不删临时目录（红的那轮保留）；
 *   2. 红的时候额外 dump：index.json 全量条目状态 / l01、l02 文件 frontmatter / 四个 worker 输出；
 *   3. 跑 N 轮。
 *
 * 用法：node scripts/d21-repro.mjs [轮数=200]
 * 退出码：0 = N 轮全绿；1 = 复现并已 dump。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REPO = path.resolve(import.meta.dirname, '..')
const WORKER = path.join(REPO, 'test', 'helpers', 'concurrency-worker.mjs')
const ROUNDS = Number(process.argv[2] ?? 200)

function fixture(n = 1) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-d21-'))
  for (const layer of ['hot', 'longterm', 'archive', 'pending']) fs.mkdirSync(path.join(root, layer), { recursive: true })
  const entries = []
  for (let i = 1; i <= n; i++) {
    const id = `l${String(i).padStart(2, '0')}`
    const file = `longterm/${id}.md`
    fs.writeFileSync(path.join(root, file), [
      '---', `id: ${id}`, 'layer: longterm', `title: 并发夹具 ${i}`, 'source: probe',
      'source_session: seed', 'source_message: seed', 'status: active', 'decay_type: recent',
      `summary: 并发夹具 ${i}`, 'updated: 2026-10-19', 'created_at: 2026-09-01T00:00:00.000Z',
      'scope: global', 'tags: [probe]', 'priority: 60', 'version: 1', '---', '', `正文 ${i}`,
    ].join('\n'), 'utf-8')
    entries.push({ id, layer: 'longterm', title: `并发夹具 ${i}`, file, tags: ['probe'], priority: 60, updated: '2026-10-19', summary: `并发夹具 ${i}`, status: 'active', decay_type: 'recent', scope: 'global', source_session: 'seed', source_message: 'seed', version: 1 })
  }
  fs.writeFileSync(path.join(root, 'index.json'), JSON.stringify({
    schema: 'harness-memory-container/v1', generated_at: '', entry_count: entries.length, hot_order: [], entries,
  }), 'utf-8')
  return root
}

const runWorker = (env) => new Promise((resolve) => {
  const child = spawn(process.execPath, [WORKER], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => { stdout += d })
  child.stderr.on('data', (d) => { stderr += d })
  child.on('error', (e) => resolve({ fatal: String(e) }))
  child.on('close', (code) => {
    const line = stdout.trim().split('\n').filter(Boolean).at(-1)
    if (!line) return resolve({ fatal: `无输出 exit=${code} stderr=${stderr.slice(0, 400)}` })
    try { resolve(JSON.parse(line)) } catch { resolve({ fatal: `输出非 JSON: ${line.slice(0, 300)}` }) }
  })
})

function dump(root, results) {
  const idx = JSON.parse(fs.readFileSync(path.join(root, 'index.json'), 'utf-8'))
  const active = idx.entries.filter((e) => e.status === 'active')
  const lines = []
  lines.push(`# D21 现场  ${path.basename(root)}`)
  lines.push(`active 条目：${active.map((e) => `${e.id}(v${e.version},superseded_by=${e.superseded_by ?? '-'})`).join(', ')}`)
  lines.push('')
  lines.push('## index.json 全量条目')
  for (const e of idx.entries) lines.push(`- ${e.id} v${e.version} file=${e.file} status=${e.status} superseded_by=${e.superseded_by ?? '-'} operation=${e.operation ?? '-'} operator=${e.operator ?? '-'}`)
  lines.push('')
  lines.push('## 文件 frontmatter')
  for (const f of fs.readdirSync(path.join(root, 'longterm')).filter((x) => x.endsWith('.md'))) {
    const t = fs.readFileSync(path.join(root, 'longterm', f), 'utf-8')
    const fm = t.split('---')[1] ?? ''
    const pick = fm.split('\n').filter((l) => /^(id|status|superseded_by|version|operation|operator|updated):/.test(l)).join(' | ')
    lines.push(`- ${f}: ${pick}`)
  }
  lines.push('')
  lines.push('## worker 输出')
  for (const r of results) lines.push(`- ${JSON.stringify(r)}`)
  return lines.join('\n')
}

let red = 0
for (let round = 1; round <= ROUNDS; round++) {
  const root = fixture(1)
  const results = await Promise.all([0, 1, 2, 3].map((w) => runWorker({ ROOT: root, MODE: 'update', WORKER: String(w), TARGET: 'l01' })))
  const flat = results.flatMap((r) => r.out ?? [])
  const ok = flat.filter((x) => x.ok)
  const idx = JSON.parse(fs.readFileSync(path.join(root, 'index.json'), 'utf-8'))
  const active = idx.entries.filter((e) => e.status === 'active')
  const bad = ok.length !== 1 || active.length !== 1
  if (bad) {
    red++
    const report = dump(root, results)
    const out = path.join(REPO, 'scripts', 'd21-scene.md')
    fs.writeFileSync(out, report, 'utf-8')
    console.log(`✗ 第 ${round} 轮复现：ok=${ok.length} active=${active.length} (${active.map((e) => e.id).join(',')})`)
    console.log(`现场保留：${root}`)
    console.log(`报告：${out}`)
    process.exitCode = 1
    break
  }
  fs.rmSync(root, { recursive: true, force: true })
  if (round % 25 === 0) console.log(`… ${round}/${ROUNDS} 全绿`)
}
if (!red) console.log(`✓ ${ROUNDS} 轮全绿`)
