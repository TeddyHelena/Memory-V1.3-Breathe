#!/usr/bin/env node
/**
 * **MemoryV1.3 恢复器**（配套 `v13-backup.mjs`）
 *
 * ## 用法
 *   node scripts/v13-restore.mjs --backup <备份目录> --dest <目标目录> [--verify]
 *
 * ## 恢复出来的布局
 *   <dest>/repo/        ← 源码 + 构建产物（`node --test test/*.test.mjs` 能直接在这儿跑）
 *   <dest>/container/   ← 容器数据（内含 dsh-memory-container/）
 *
 * ## `--verify` 干什么（⛔ 这才是"演练"的本体）
 *   ① 逐个校验 sha256 ⇔ MANIFEST（**先校验再解包**，坏了就别往下走）
 *   ② 用**恢复出来的 lib** 跑一组测试（证明产物真的可执行，不是一堆字节）
 *   ③ 用**恢复出来的容器**走一遍 load({verify:true})，条目数与层分布 ⇔ MANIFEST
 *
 * ⛔ 本脚本**只写 dest**，不碰真身、不碰原仓库。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

// 支持 `--k=v` 与 `--k v` 两种写法
const argv = {}
{
  const a = process.argv.slice(2)
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith('--')) continue
    const [k, ...v] = a[i].replace(/^--/, '').split('=')
    if (v.length) argv[k] = v.join('=')
    else if (a[i + 1] && !a[i + 1].startsWith('--')) { argv[k] = a[i + 1]; i++ }
    else argv[k] = 'true'
  }
}
if (!argv.backup || !argv.dest) { console.error('用法：--backup <备份目录> --dest <目标目录> [--verify]'); process.exit(2) }
const BK = path.resolve(argv.backup)
const DEST = path.resolve(argv.dest)
const VERIFY = argv.verify === 'true'
const M = JSON.parse(fs.readFileSync(path.join(BK, 'MANIFEST.json'), 'utf-8'))
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')

console.log(`═══ MemoryV1.3 恢复 ═══\n  备份 ${BK}\n  目标 ${DEST}`)
console.log(`  来源：${M.tag} ｜ ${M.commit.slice(0, 8)} ｜ 包 ${M.package} ｜ 产品 ${M.product}`)

// ① 先校验再解包
let bad = 0
for (const [name, meta] of Object.entries(M.artifacts)) {
  const f = path.join(BK, name)
  if (!fs.existsSync(f)) { console.error(`  ❌ 缺件 ${name}`); bad++; continue }
  const got = sha(f)
  const ok = got === meta.sha256
  if (!ok) bad++
  console.log(`  ${ok ? '✅' : '❌'} ${name.padEnd(18)} sha256 ${got.slice(0, 16)}… ${ok ? '' : `≠ 期望 ${meta.sha256.slice(0, 16)}…`}`)
}
if (bad) { console.error(`\n⛔ ${bad} 件校验不过 —— ⛔ 不继续（坏备份解出来比没有更危险：你以为回去了，其实没有）`); process.exit(1) }

// ② 解包
fs.mkdirSync(DEST, { recursive: true })
const repo = path.join(DEST, 'repo')
fs.mkdirSync(repo, { recursive: true })
execFileSync('tar', ['-xzf', path.join(BK, 'code.tar.gz'), '-C', repo])
if (M.artifacts['lib.tar.gz']) execFileSync('tar', ['-xzf', path.join(BK, 'lib.tar.gz'), '-C', repo])
console.log(`  ✅ repo/       解出 ${fs.readdirSync(repo).length} 项`)
if (M.artifacts['container.tar.gz']) {
  const cd = path.join(DEST, 'container')
  fs.mkdirSync(cd, { recursive: true })
  execFileSync('tar', ['-xzf', path.join(BK, 'container.tar.gz'), '-C', cd])
  console.log(`  ✅ container/  解出 ${fs.readdirSync(cd).join(', ')}`)
}

if (!VERIFY) { console.log(`\n  ℹ️ 没带 --verify（只解包）。要演练请加 --verify`); process.exit(0) }

// ③ 演练本体
console.log('\n── 演练：这三样都要过 ──')
let fail = 0

// ③a 恢复出来的 lib 可执行吗：跑一组真测试
try {
  const out = execFileSync('node', ['--test', 'test/decay-wiring.test.mjs', 'test/wake.test.mjs'], { cwd: repo, encoding: 'utf-8' })
  const pass = /# pass (\d+)/.exec(out)?.[1] ?? '?'
  const failed = Number(/# fail (\d+)/.exec(out)?.[1] ?? 1)
  if (failed !== 0) throw new Error(`有 ${failed} 条不过`)
  console.log(`  ✅ 产物可执行    恢复出来的 lib 跑通 ${pass} 条测试`)
} catch (e) { console.error(`  ❌ 产物跑不动：${String(e.message).slice(0, 160)}`); fail++ }

// ③b 恢复出来的容器读得开吗：条目数与层分布对得上吗
try {
  const containerDir = path.join(DEST, 'container', path.basename(M.restoreContainerPath ?? 'dsh-memory-container'))
  const root = fs.existsSync(containerDir) ? containerDir : path.join(DEST, 'container')
  const { MemoryContainer } = await import(path.join(repo, 'lib/container.js'))
  const c = new MemoryContainer(root); c.load({ verify: true })
  const entries = c.getIndex().entries.length
  const byLayer = {}
  for (const e of c.getIndex().entries) byLayer[e.layer] = (byLayer[e.layer] ?? 0) + 1
  const sameCount = entries === M.container.entries
  const sameLayers = JSON.stringify(byLayer) === JSON.stringify(M.container.byLayer)
  console.log(`  ${sameCount ? '✅' : '❌'} 容器读得开    ${entries} 条（备份时 ${M.container.entries}）｜ 层 ${JSON.stringify(byLayer)}`)
  if (!sameCount || !sameLayers) fail++
} catch (e) { console.error(`  ❌ 容器读不开：${String(e.message).slice(0, 160)}`); fail++ }

if (fail) { console.error(`\n⛔ 演练不过（${fail} 项）—— ⛔ 这份备份**不能当安全网用**`); process.exit(1) }
console.log('\n✅ 演练全过：校验一致 · 产物可执行 · 容器读得开 ⇒ **这份备份能回滚**')
