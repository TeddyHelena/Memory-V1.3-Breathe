#!/usr/bin/env node
/**
 * **MemoryV1.3 备份器**（Lite 动刀前的安全网）
 *
 * ## 原则
 * ⛔ **没演练过的备份 = 没有备份**。所以配套 `v13-restore.mjs`，且必须跑过 `--drill`。
 *
 * ## 一次备份包含什么（四件，缺一都回不去）
 *   ① `code.tar.gz`     —— 源码（src/test/scripts/docs + 配置 + README），⛔ 不含 node_modules/lib
 *   ② `lib.tar.gz`      —— **已构建产物**（宿主 lib + 客户端包）。为什么要存它：
 *                          回滚时若 CI/依赖变了，重构建可能得到**不一样的字节**；产物在 = 回得到原样
 *   ③ `container.tar.gz` —— 真身容器（记忆数据本体）
 *   ④ `repo.bundle`     —— 完整 git 历史（单文件，不依赖原仓库也能 `git clone` 出来）
 *   外加 `MANIFEST.json`（sha256 + 版本 + 计数 + **当时的验收读数**）与 `RESTORE.md`
 *
 * ## 用法
 *   node scripts/v13-backup.mjs                    # 备份到 ~/Desktop/Harness/backups/memory-v13/<时间戳>
 *   node scripts/v13-backup.mjs --label pre-lite  # 加个人话标签
 *   node scripts/v13-backup.mjs --drill            # 备份 + **立刻恢复到一个临时目录并逐项校验**
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

// 支持 `--k=v` 与 `--k v` 两种写法（⛔ 第一版只认 `=`，`--label pre-lite` 会变成 `true`）
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
const ROOT = path.resolve(import.meta.dirname, '..')
const CONTAINER = process.env.MEMORY_ROOT ?? path.join(os.homedir(), 'Documents/Obsidian Vault/00_记忆系统/dsh-memory-container')
const BASE = argv.out ?? path.join(os.homedir(), 'Desktop/Harness/backups/memory-v13')
const label = argv.label ? `-${argv.label}` : ''
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)
const OUT = path.join(BASE, `${stamp}${label}`)
// ⛔ stderr 也吃掉：探测用的 `git rev-parse` 失败时会在终端刷一行 fatal，看着像出错其实是我在探测
const sh = (cmd, args, cwd = ROOT) => execFileSync(cmd, args, { cwd, encoding: 'utf-8', maxBuffer: 1 << 28, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')

fs.mkdirSync(OUT, { recursive: true })
console.log(`═══ MemoryV1.3 备份 ═══\n  目标 ${OUT}`)

// ⓪ 前提：工作树必须干净（否则"回滚到哪一点"说不清）
const dirty = sh('git', ['status', '--porcelain']).split('\n').filter((l) => l && !l.includes('lib/sandbox.js'))
if (dirty.length) { console.error(`⛔ 工作树不干净（${dirty.length} 项），先提交再备份：\n${dirty.slice(0, 5).join('\n')}`); process.exit(1) }
const head = sh('git', ['rev-parse', 'HEAD'])
const branch = sh('git', ['branch', '--show-current'])
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'))
/**
 * 版本从**唯一真源**读：`src/index.ts` 的 `PRODUCT` 常量
 * （README 写明"口径唯一真源就是它"）。
 * ⛔ 第一版我拿正则去猜 `z.string().default(...)` ⇒ 抓了个 `null` ——
 *    **别造第二个读法**，读它自己声明的那一份。
 */
const prodSrc = fs.readFileSync(path.join(ROOT, 'src/index.ts'), 'utf-8')
const prodBlock = /export const PRODUCT\s*=\s*\{([^}]*)\}/.exec(prodSrc)?.[1] ?? ''
const pick = (k) => (new RegExp(`${k}\\s*:\\s*'([^']*)'`).exec(prodBlock) ?? [])[1] ?? null
const product = pick('productVersion')
const baseline = pick('baseline')
let tag = `v1.3-pre-lite-${stamp}`
if (!product) { console.error('⛔ 读不到 PRODUCT.productVersion —— 版本口径读不出来，不备份'); process.exit(1) }
console.log(`  提交 ${head.slice(0, 8)} ｜ 分支 ${branch} ｜ 包 ${pkg.version} ｜ 产品 ${product}（基线 ${baseline}）`)

// ① 打标（回滚锚点：有标签就不用记哈希）
/**
 * 打标（回滚锚点）。
 * ⛔ **同名冲突时必须校验它指哪儿** —— 实测踩过一次：同名标签还指着上一次的提交，
 *   而 MANIFEST 写的是新提交 ⇒ **两个真源打架**（正是本仓今天追了一整天的那个病）。
 */
{
  let existing = null
  try { existing = sh('git', ['rev-parse', `${tag}^{commit}`]) } catch { /* 不存在 */ }
  if (existing === null) {
    sh('git', ['tag', '-a', tag, '-m', `V1.3 备份锚点（Lite 动刀前）· 包 ${pkg.version} · ${head.slice(0, 8)}`])
    console.log(`  ✅ 标签 ${tag}`)
  } else if (existing === head) {
    console.log(`  ✅ 标签 ${tag}（已存在且指向本次提交）`)
  } else {
    tag = `${tag}-${head.slice(0, 8)}`
    sh('git', ['tag', '-a', tag, '-m', `V1.3 备份锚点（Lite 动刀前）· 包 ${pkg.version} · ${head.slice(0, 8)}`])
    console.log(`  ⚠️ 同名标签指向别的提交（${existing.slice(0, 8)}）⇒ 换名打标：${tag}`)
  }
}

// ② 源码（含配置；⛔ 排除 node_modules / lib / .git / .screens）
const CODE_ITEMS = ['src', 'test', 'scripts', 'docs', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.client.json', 'tsconfig.client.types.json', 'README.md']
const codeTar = path.join(OUT, 'code.tar.gz')
execFileSync('tar', ['-czf', codeTar, ...CODE_ITEMS.filter((x) => fs.existsSync(path.join(ROOT, x)))], { cwd: ROOT })
console.log(`  ✅ code.tar.gz      ${(fs.statSync(codeTar).size / 1024).toFixed(0)} KB`)

// ③ 构建产物（能回"原样字节"，不必依赖重构建）
const libTar = path.join(OUT, 'lib.tar.gz')
if (fs.existsSync(path.join(ROOT, 'lib'))) {
  execFileSync('tar', ['-czf', libTar, 'lib'], { cwd: ROOT })
  console.log(`  ✅ lib.tar.gz       ${(fs.statSync(libTar).size / 1024).toFixed(0)} KB`)
} else console.log('  ⚠️ 没有 lib/（没构建过）—— 回滚时需自己 npm run build')

// ④ 真身容器
const cTar = path.join(OUT, 'container.tar.gz')
execFileSync('tar', ['-czf', cTar, '-C', path.dirname(CONTAINER), path.basename(CONTAINER)])
console.log(`  ✅ container.tar.gz ${(fs.statSync(cTar).size / 1024).toFixed(0)} KB`)

// ⑤ 完整 git 历史（单文件就能克隆回来）
const bundle = path.join(OUT, 'repo.bundle')
sh('git', ['bundle', 'create', bundle, '--all'])
console.log(`  ✅ repo.bundle      ${(fs.statSync(bundle).size / 1024).toFixed(0)} KB（含全部历史）`)

// ⑥ MANIFEST：哈希 + 计数 + **当时的验收读数**（回滚后拿它对）
const { MemoryContainer } = await import(path.join(ROOT, 'lib/container.js'))
const c = new MemoryContainer(CONTAINER); c.load({ verify: true })
const byLayer = {}
for (const e of c.getIndex().entries) byLayer[e.layer] = (byLayer[e.layer] ?? 0) + 1
const auditPath = path.join(CONTAINER, '.decay-audit.jsonl')
const manifest = {
  schema: 'memory-v13-backup/1', at: new Date().toISOString(), tag, branch, commit: head, package: pkg.version, product, baseline,
  artifacts: Object.fromEntries([['code.tar.gz', codeTar], ['lib.tar.gz', libTar], ['container.tar.gz', cTar], ['repo.bundle', bundle]]
    .filter(([, f]) => fs.existsSync(f)).map(([n, f]) => [n, { sha256: sha(f), bytes: fs.statSync(f).size }])),
  container: {
    entries: c.getIndex().entries.length, byLayer,
    archivedEver: fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf-8').split('\n').filter(Boolean).length : 0,
  },
  restore: 'node scripts/v13-restore.mjs --backup <本目录> --dest <目标目录>',
}
fs.writeFileSync(path.join(OUT, 'MANIFEST.json'), JSON.stringify(manifest, null, 2))
const totalKB = fs.readdirSync(OUT).reduce((n, f) => n + fs.statSync(path.join(OUT, f)).size, 0) / 1024
console.log(`  ✅ MANIFEST.json    条目 ${c.getIndex().entries.length} ｜ 层 ${JSON.stringify(byLayer)} ｜ 累计归档 ${manifest.container.archivedEver}`)
console.log(`\n  📦 合计 ${totalKB.toFixed(0)} KB ｜ ${OUT}`)
console.log(`  回滚：node scripts/v13-restore.mjs --backup ${OUT} --dest <目标>`)
if (argv.drill) {
  console.log('\n═══ 演练：恢复到一个临时目录并逐项校验 ═══')
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'v13-drill-'))
  execFileSync('node', [path.join(ROOT, 'scripts/v13-restore.mjs'), '--backup', OUT, '--dest', dest, '--verify'], { stdio: 'inherit' })
  console.log(`  演练目录（可删）：${dest}`)
}
