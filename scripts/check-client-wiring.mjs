#!/usr/bin/env node
/**
 * **客户端接线门禁**：用**真 HTTP + 真注入面**验每一个方法。
 *
 * ## 为什么必须这么测（这一段是账本）
 * 2026-10-14 对抗验证 E 打出一个 **在沙箱里永远看不见** 的 bug：
 * `apiFetch` 已经剥掉 `{ok,data}` 外壳，而 `decayState/decaySweep/decayRollback`
 * **又读了一层 `r.data`** ⇒ 恒 `undefined` ⇒ 全取兜底零值。
 * 真 HTTP 打真容器：服务端说"今天归档了 5 条"，面板拿到 0、屏上写"今天无自动归档"、
 * **撤销按钮永远不出现** —— 那条 UI 纪律一个字没落地。
 *
 * ⛔ 而 `npm run shoot` 九张截图全绿 —— 因为沙箱注入的是**桩**，**桩绕过了 `apiFetch`**。
 * ⇒ **判"接线对不对"只能用真 HTTP + 真注入面。** 这就是本脚本存在的全部理由。
 *
 * ## 判据
 * 每个方法：**服务端原始响应的 `data`** ⇔ **注入面返回值**，两者必须等价。
 *   · "兜底零值"与真值不等 ⇒ 红（前置条件强制 `lastCount` 非零，否则分不出来）
 *   · `fresh` 这类按 `Date.now()` 现算的浮点**按 6 位有效数字归一化**再比 ——
 *     ⛔ 不做归一化就得把判据放宽到"看着差不多"，那就抓不到恒零值了
 *   · 每个用例**各造一个同构世界**（变更类端点共用一个世界会假红：先打的把状态改了）
 *   · 错误路径：`ok:false` ⇒ 注入面必须**抛**（⛔ 不许静默返回兜底值）
 *
 * ## 退出码
 * 判据不过 ⇒ 非 0。⛔ 只建临时容器 + 本地端口，不碰生产。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { execFileSync } from 'node:child_process'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'wiring-'))
execFileSync('npx', ['tsc', 'src/client/api-surface.ts', '--outDir', OUT, '--module', 'esnext', '--target', 'es2022', '--moduleResolution', 'bundler', '--skipLibCheck'], { cwd: ROOT, stdio: 'pipe' })
const { createApiSurface } = await import(path.join(OUT, 'api-surface.js'))
const { MemoryContainer } = await import(path.join(ROOT, 'lib', 'container.js'))
const { MemoryWriter } = await import(path.join(ROOT, 'lib', 'writer.js'))
const { createMemoryApi } = await import(path.join(ROOT, 'lib', 'api.js'))
const { runSweep, readSweepState } = await import(path.join(ROOT, 'lib', 'decay-sweep.js'))
const { sweepEntries } = await import(path.join(ROOT, 'lib', 'decay.js'))
const { setDayTimeZone } = await import(path.join(ROOT, 'lib', 'day-boundary.js'))
setDayTimeZone('Asia/Shanghai')

const TOKEN = 'TK'
const PREFIX = '/api/memory'

/** 造一个完整世界：临时容器（3 条 + 真扫一批）+ 真 HTTP + 真注入面 */
async function makeWorld() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-'))
  for (const l of ['hot', 'longterm', 'archive', 'pending']) fs.mkdirSync(path.join(root, l), { recursive: true })
  const T = Date.parse('2026-10-14T12:00:00+08:00')
  const entries = []
  for (let i = 0; i < 3; i++) {
    const la = new Date(T - 40 * 86400000).toISOString()
    fs.writeFileSync(path.join(root, 'longterm', `l${i}.md`),
      `---\nid: l${i}\ntitle: 条目${i}\nlayer: longterm\nstatus: active\ntags: []\nlast_accessed: ${la}\naccess_count: 0\n---\nbody\n`)
    entries.push({ id: `l${i}`, title: `条目${i}`, layer: 'longterm', status: 'active', tags: [], file: `longterm/l${i}.md`, last_accessed: la, access_count: 0 })
  }
  fs.writeFileSync(path.join(root, 'index.json'),
    JSON.stringify({ schema: 'harness-memory-container/12', version: 12, hot_order: [], entries, archive_index: {}, longterm_tags: {} }))
  const c = new MemoryContainer(root); c.load()
  const w = new MemoryWriter(c)
  runSweep({ root, entries: sweepEntries(c.getIndex().entries, T), relocate: (id, l, o) => w.relocate(id, l, o), now: T })
  // ⛔ `productVersion` 不传 ⇒ `/onboarding` 根本不注册（这不是 bug，是我**少给选项**——第一版门禁栽在这）
  const { handler } = createMemoryApi(c, {
    prefix: PREFIX, allowEdit: true, containerRoot: root, writer: w, token: TOKEN,
    guardHost: false, productVersion: '0.0.0-wiring-test',
  })
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    const rest = pathname.startsWith(PREFIX) ? pathname.slice(PREFIX.length) : null
    if (rest === null) { res.writeHead(404); res.end('{}'); return }
    handler(req, res, rest)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const surface = createApiSurface({ prefix: PREFIX, token: TOKEN, fetchImpl: (input, init) => fetch(new URL(String(input), base), init) })
  return { root, server, base, surface, lastCount: readSweepState(root).lastCount }
}

/**
 * 归一化：**只抹两类天然会变的东西**，其余一律严格比。
 *   ① 浮点按 6 位有效数字（`fresh` 按 `Date.now()` 现算，两次调用差微秒）
 *   ② `generated_at`（墙钟戳，两次请求必然不同）
 * ⛔ 抹的范围必须**极小**：抹多了就等于把判据放宽成"看着差不多"，
 *    而"恒零值"这类 bug 恰恰只能靠严格比才露出来。
 */
const VOLATILE_KEYS = new Set(['generated_at'])
const norm = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? Number(v.toFixed(6)) : String(v)
  if (Array.isArray(v)) return v.map(norm)
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, VOLATILE_KEYS.has(k) ? '(wall-clock)' : norm(x)]))
  }
  return v
}
const eq = (a, b) => JSON.stringify(norm(a)) === JSON.stringify(norm(b))

const fails = []
async function check(name, run, pathName, init) {
  const wRaw = await makeWorld()
  const wGot = await makeWorld()
  try {
    const body = await (await fetch(`${wRaw.base}${PREFIX}${pathName}`, {
      headers: { 'content-type': 'application/json', 'x-memory-token': TOKEN }, ...(init ?? {}),
    })).json()
    let got, err = null
    try { got = await run(wGot.surface) } catch (e) { err = e }
    if (err) { fails.push(`${name}：注入面抛了 ${err.message}`); console.log(`  ❌ ${name.padEnd(15)} 注入面抛错：${err.message}`); return }
    const ok = eq(got, body.data)
    if (!ok) fails.push(`${name}：注入面 ${JSON.stringify(got)} ⇏ 服务端 ${JSON.stringify(body.data)}`)
    console.log(`  ${ok ? '✅' : '❌'} ${name.padEnd(15)} ${JSON.stringify(got)?.slice(0, 76)}`)
    if (!ok) console.log(`     ${' '.repeat(16)}服务端 ${JSON.stringify(body.data)?.slice(0, 76)}`)
  } finally { wRaw.server.close(); wGot.server.close() }
}

console.log('── 客户端接线门禁（真 HTTP + 真注入面）──')
{
  const probe = await makeWorld()
  probe.server.close()
  if (probe.lastCount !== 3) {
    console.error(`❌ 前置条件不成立：lastCount=${probe.lastCount}，应为 3 —— 不非零就分不出"兜底零值"`)
    process.exit(2)
  }
}
await check('decayState', (s) => s.decayState(), '/decay-state')
await check('decaySweep', (s) => s.decaySweep(false), '/decay-sweep', { method: 'POST', body: '{"force":false}' })
await check('decayRollback', (s) => s.decayRollback(), '/decay-rollback', { method: 'POST', body: '{}' })
await check('list', (s) => s.list(), '/list')
await check('graph', (s) => s.graph(), '/graph')
await check('onboarding', (s) => s.onboarding(), '/onboarding')
await check('identity', (s) => s.identity(), '/identity')
await check('getEntry', (s) => s.getEntry('l0'), '/entry/l0')

{
  const bad = createApiSurface({
    prefix: PREFIX, token: TOKEN,
    fetchImpl: async () => new Response(JSON.stringify({ ok: false, error: 'boom' }), { status: 400, headers: { 'content-type': 'application/json' } }),
  })
  let threw = null
  try { await bad.decayState() } catch (e) { threw = e }
  const pass = threw !== null && /boom/.test(String(threw))
  if (!pass) fails.push('错误路径：ok:false 时注入面没有抛（静默返回兜底值 = 把错误当数据）')
  console.log(`  ${pass ? '✅' : '❌'} ${'错误路径'.padEnd(13)} ok:false ⇒ ${threw ? '抛出 ✅' : '⚠️ 没抛（静默）'}`)
}

if (fails.length) {
  console.error('\n❌ 接线门禁不过：')
  for (const f of fails) console.error(`   · ${f}`)
  process.exit(1)
}
console.log('\n✅ 接线门禁全过（注入面返回值 ⇔ 服务端 data 逐条等价）')
