#!/usr/bin/env node
/**
 * release-check.mjs —— 发布前的**版本口径一致性闸门**（S2 起）
 *
 * ════════════════════════════════════════════════════════════════════
 * 为什么要有它
 * ════════════════════════════════════════════════════════════════════
 * 「两套号必须同时动」是我们自己立过的纪律（包 semver ＋ 产品版本），而它散在**四处**：
 *   `package.json` / `src/index.ts` 的 product 块 / `README.md` 首行 / 插件管理器 `overrides.json`
 * S1 那次就是靠人逐个改的。发布当天漏掉一处 ⇒ 半年后没人对得上「哪份代码是哪个产品版」。
 * ⛔ 靠自觉的纪律会被破；**靠"走脚本就不用想"的纪律才守得住**。
 *
 * ════════════════════════════════════════════════════════════════════
 * 查什么（全部只读）
 * ════════════════════════════════════════════════════════════════════
 *   ① 四个落点的版本串是否同值（逐个打印，不同值即红）
 *   ② `baseline` 必须等于**当前大版本的锚点**（V1.3 系列 = `MemoryV1.3`）——
 *      锚点不随小版本变，但**随大版本切一次**（V1.3-A 从 `MemoryV1.2` 切到 `MemoryV1.3`）
 *   ③ 容器：`load({verify:true})` 通过 + 索引↔文件零脱节 + 条目数与 index.json 声明一致
 *   ④ 容器里不该出现写死的条目数声明（overrides 的 notes / health.expect 里出现数字就警告）
 *
 * 用法：
 *   node scripts/release-check.mjs --expect-product MemoryV1.2-Scoped --expect-package 0.9.0
 *   # 容器默认读生产；想跑副本加 --root <副本>
 * 退出码：0 = 全绿；1 = 有红；2 = 参数/路径错。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { MemoryContainer } from '../lib/container.js'

const argv = process.argv.slice(2)
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d }
const EXPECT_PRODUCT = arg('expect-product', '')
const EXPECT_PACKAGE = arg('expect-package', '')
const ROOT = arg('root', path.join(os.homedir(), 'Documents', 'Obsidian Vault', '00_记忆系统', 'dsh-memory-container'))
const OVERRIDES = arg('overrides', path.join(os.homedir(), 'Documents', 'Obsidian Vault', '03_项目', '本地插件管理器', 'overrides.json'))
const REPO = path.resolve(import.meta.dirname, '..')

const rows = []
let red = 0
const ok = (what, got, want) => { const pass = want === undefined || got === want; if (!pass) red++; rows.push([pass ? '✅' : '❌', what, String(got), want === undefined ? '—' : String(want)]) }
const warn = (what, got) => rows.push(['⚠️', what, String(got), '（不应写死）'])

// ── ① 四个落点 ───────────────────────────────────────────────────────
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf-8'))
// ⚠️ 版本口径已提成**常量**（src/index.ts 的 `PRODUCT`）⇒ 闸门必须**读真值**，
//    不许再用正则从源码里抠字面量：2026-10-10 切 B 时实测——常量一提，正则就"未找到"，
//    于是四条判据一起假红（README 明明写了却报"不含"）。
//    读真值还有个好处：闸门校验的是**代码真正会用的那个值**，正则抠的只是它的影子。
const { PRODUCT } = await import(path.join(REPO, 'lib', 'index.js'))
const productVersion = PRODUCT?.productVersion ?? '(未找到)'
const productPackage = PRODUCT?.package ?? '(未找到)'
const baseline = PRODUCT?.baseline ?? '(未找到)'
const readmeFirst = fs.readFileSync(path.join(REPO, 'README.md'), 'utf-8').split('\n')[0]
let overrides = null
try { overrides = JSON.parse(fs.readFileSync(OVERRIDES, 'utf-8')) } catch { /* 允许缺 */ }
// ⚠️ 只认**本插件**那一条：overrides 里有六个插件，各带自己的 productVersion
//    （第一版写成"遍历全树"，于是把 dsh-local-plugins 的 "Phase 2 · 设置页页面" 也算了进来，
//     当场报假红。台子自身的缺陷也要单独列——记在这里。）
const memory = overrides?.plugins?.['dsh-memory-container']
const overrideVersions = memory && typeof memory.productVersion === 'string' ? [memory.productVersion] : []

ok('package.json version', pkg.version, EXPECT_PACKAGE || undefined)
ok('src product.package', productPackage, EXPECT_PACKAGE || undefined)
ok('src product.productVersion', productVersion, EXPECT_PRODUCT || undefined)
// 锚点：V1.3 系列起为 MemoryV1.3。⛔ 改这里必须同时改 src/index.ts 的 product.baseline 与那句注释。
ok('src product.baseline（大版本锚点）', baseline, 'MemoryV1.3')
ok('package.json 与 product.package 同值', pkg.version === productPackage ? '同值' : `不同（${pkg.version} vs ${productPackage}）`, '同值')
ok('README 首行含产品版本', readmeFirst.includes(productVersion) ? '含' : `不含（首行：${readmeFirst.slice(0, 60)}…）`, '含')
ok('README 首行含包版本', readmeFirst.includes(pkg.version) ? '含' : `不含（首行：${readmeFirst.slice(0, 60)}…）`, '含')
if (overrideVersions.length) {
  const bad = overrideVersions.filter((v) => v !== productVersion && v !== '（待登记）')
  ok('插件管理器 dsh-memory-container 的 productVersion', bad.length ? `不一致：${bad.join(' / ')}` : '与代码同值', '与代码同值')
}

// ── ② 写死的数（我们自己立的元规则：⛔ 不写死任何一个数）────────────
if (overrides) {
  const notes = JSON.stringify(memory ?? {})
  const hardcoded = notes.match(/容器\s*\d+\s*条/)
  if (hardcoded) warn('overrides 里写死了条目数', hardcoded[0])
  const expect = notes.match(/"expect"\s*:\s*"([^"]*\d[^"]*)"/)
  if (expect) warn('overrides health.expect 里有数字', expect[1])
}

// ── ③ 容器 ──────────────────────────────────────────────────────────
try {
  const c = new MemoryContainer(ROOT)
  // 【L-5】先 load 再读文件：verify 档会把增量日志折平回快照，
  // 之后读 `index.json` 才是当前真身（直接读会读到落后于日志的快照）。
  c.load({ verify: true })
  const live = c.getIndex().entries.length
  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'index.json'), 'utf-8'))
  const logStatus = c.indexLogStatus()
  rows.push(['ℹ️', '增量索引日志', `待折平 ${logStatus.pendingRecords} 条`, '0（load 后应已折平）'])
  ok('容器 load({verify:true})', '通过', '通过')
  const sameCount = idx.entry_count === live
  if (!sameCount) red++
  rows.push([sameCount ? '✅' : '❌', '索引声明条目数 ＝ 实际载入', `声明 ${idx.entry_count} ／ 实载 ${live}`, '相等'])
  let missing = 0
  for (const e of c.getIndex().entries) if (!c.readEntry(e.id)) missing++
  ok('索引 ↔ 文件脱节', `${missing} 条读不到`, '0 条读不到')
} catch (e) {
  red++
  rows.push(['❌', '容器检查', String(e?.message ?? e).slice(0, 70), '应通过'])
}

// ── 发布阻塞清单（作者 2026-10-10 拍板：不解决不发布）────────────────
// 这份清单是**机器门禁**，不是备忘：`docs/RELEASE-BLOCKERS.md` 里只要还有 `- [ ]`，这里就红。
{
  const fs = await import('node:fs')
  const path = await import('node:path')
  const bl = path.resolve(import.meta.dirname, '..', 'docs', 'RELEASE-BLOCKERS.md')
  try {
    const md = fs.readFileSync(bl, 'utf-8')
    const open = md.split('\n').filter((l) => /^- \[ \]/.test(l.trim()))
    if (open.length) {
      red++
      rows.push(['❌', '发布阻塞清单', `还有 ${open.length} 条未解决`, '0 条'])
      console.log('\n  ⛔ 未解决的阻塞项：')
      for (const l of open) console.log('     ' + l.trim().slice(0, 90))
    } else {
      rows.push(['✅', '发布阻塞清单', '全部已解决', '0 条'])
    }
  } catch (e) {
    red++
    rows.push(['❌', '发布阻塞清单', `读不到 ${path.basename(bl)}`, '应存在'])
  }
}

// ── 打印 ────────────────────────────────────────────────────────────
console.log('════════ 发布前版本口径闸门 ════════')
console.log(`仓库 ${REPO}`)
console.log(`容器 ${ROOT}`)
console.log(`期望 产品 ${EXPECT_PRODUCT || '(未指定)'} ／ 包 ${EXPECT_PACKAGE || '(未指定)'}\n`)
for (const [mark, what, got, want] of rows) console.log(`${mark} ${what.padEnd(34)} ${got}${want === '—' ? '' : `  ｜ 期望 ${want}`}`)
console.log(`\n结论：${red === 0 ? '✅ 全绿' : `❌ ${red} 处红`}`)
process.exit(red === 0 ? 0 : 1)
