#!/usr/bin/env node
/**
 * dead-exports.mjs —— 零调用点扫描（V1.2 工程纪律第二条的机械执行）
 *
 * 纪律原文（理想形态提案 §四-2）：
 *   **零调用点 = 一等缺陷。** 导出符号（函数 / 常量 / 缓存）没有调用方，就是缺陷，
 *   不是"预留"。零调用点数量必须为 0，或进白名单并写明原因。
 *
 * 为什么必须是机械扫描：同一个跟头栽过两次，两次都靠"人记得"兜不住——
 *   ① `classifyDecayType` / `contentFingerprint` / `findDuplicate`：写得很好，
 *      `writer.ts` 既不 import 也不调用；调用方看到注释就以为它生效了。
 *   ② `verifyChecksum`：声称守护内容完整性，全 src 零调用点。
 *   "下次记得接线"不是机制；扫描器才是机制。
 *
 * ── 判定口径（写死，避免以后各说各话）──────────────────────────────
 *   · 范围：`src/**\/*.ts(x)` 的**运行期导出**（function / class / const / enum / export 子句）。
 *     `interface` / `type` 编译后不存在，不进本扫描。
 *   · **生产引用** = 在 src / scripts / tools 的其它文件里，以**标识符 token** 出现
 *     （跳过注释与字符串；`x.name` 这种属性访问不算引用该导出）。
 *     声明所在文件内部的用法不算 —— 内部用得上就不必 `export`，那也是多余的导出面。
 *   · **仅测试引用** = 只有 test/ 引用。不算调用方，单独列出给人看。
 *   · **零引用** = 谁都没用 → fail（除非在 scripts/dead-exports.allow.json 里写明原因）。
 *
 * ── 这个工具自己踩过的三个坑（写在这里，防止后人重犯）──────────────
 *   ① **注释冒充调用方**：第一版按整篇正则数引用，扫描器**自己注释里**提到的
 *      `classifyDecayType` 被算成"有人在用"，真·零调用点因此没报出来。
 *      ⇒ 只数代码 token。（一个会报假绿的扫描器，比没有扫描器更坏。）
 *   ② **`export { … }` 子句漏采**：子句自己没有 `export` 修饰符，被 `if (!isExport) continue`
 *      挡在门外，整个宿主接口面（name / inject / Config / apply）凭空消失，扫描却报全绿。
 *   ③ **行号错位**：为了跳注释，把"去掉注释的文本"当成解析输入，行号随之压缩。
 *      ⇒ 解析用原文、数引用用 token，两份数据分开。
 *   ④ **模板字符串截流（最危险的一个）**：裸 `ts.createScanner` 不懂模板字符串，
 *      扫到第一个反引号就停（要么把剩下的吐成 EndOfFileToken，要么彻底跑偏）。
 *      后果：`src/contract/layer.ts` 里用了 4 次的 `fingerprint` 只数到 1 次，
 *      被判成"零调用点"——**照着这个结论删代码，就会删掉活的**。
 *      ⇒ 数引用一律走 AST（`ts.createSourceFile` + forEachChild），模板/注释/字符串天然不参与。
 *      **教训：工具报"死"的时候，先验证它自己活着。**
 *
 * 用法：
 *   node scripts/dead-exports.mjs                    # 扫本仓，非零退出 = 有未豁免的零调用点
 *   node scripts/dead-exports.mjs --json             # 机器可读（给测试/CI 用）
 *   node scripts/dead-exports.mjs --root <dir>       # 扫别的仓（给扫描器自己的测试用）
 *   DSH_DEBUG_EXPORTS=1 node scripts/dead-exports.mjs  # dump 全量行
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import ts from 'typescript'

const argv = process.argv.slice(2)
const rootIdx = argv.indexOf('--root')
const ROOT = path.resolve(rootIdx >= 0 ? argv[rootIdx + 1] : path.join(import.meta.dirname, '..'))
const AS_JSON = argv.includes('--json')
const ALLOW_FILE = path.join(ROOT, 'scripts', 'dead-exports.allow.json')

const PROD_GLOB = ['src', 'scripts', 'tools']   // 算"有调用方"
const SRC_GLOB = ['src']                        // 导出面只统计源码
const TEST_GLOB = ['test']

function walk(dir, exts, out = []) {
  const abs = path.join(ROOT, dir)
  if (!fs.existsSync(abs)) return out
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const p = path.join(abs, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      walk(path.relative(ROOT, p), exts, out)
    } else if (exts.some((e) => entry.name.endsWith(e))) {
      out.push(path.relative(ROOT, p))
    }
  }
  return out
}

const lineOf = (sf, node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1

/** 解析成 AST（坑 ①③④ 的根治办法：模板/注释/字符串天然不参与） */
function parseFile(relFile, text) {
  const kind = /\.tsx$/.test(relFile) ? ts.ScriptKind.TSX
    : /\.jsx$/.test(relFile) ? ts.ScriptKind.JSX
      : /\.(mjs|js)$/.test(relFile) ? ts.ScriptKind.JS
        : ts.ScriptKind.TS
  return ts.createSourceFile(relFile, text, ts.ScriptTarget.ESNext, /* setParentNodes */ true, kind)
}

/**
 * "长得像引用、其实不是"的标识符：
 *   · 属性访问的成员名 `obj.name` / `obj?.name`
 *   · 对象字面量 / 接口 / 类里的键名与成员名 `{ name: 1 }` / `{ name() {} }` / `name: string`
 *   · 限定名的右半边 `A.name`
 * 简写属性 `{ name }` **算**引用（那是真的用了这个变量）。
 */
function isNonRefIdentifier(node) {
  const p = node.parent
  if (!p) return false
  if (ts.isPropertyAccessExpression(p) && p.name === node) return true
  if (ts.isQualifiedName(p) && p.right === node) return true
  if (ts.isPropertyAssignment(p) && p.name === node) return true
  if (ts.isPropertySignature(p) && p.name === node) return true
  if (ts.isPropertyDeclaration(p) && p.name === node) return true
  if (ts.isMethodDeclaration(p) && p.name === node) return true
  if (ts.isMethodSignature(p) && p.name === node) return true
  return false
}

/** 该标识符在这个文件里出现几次（AST 口径，见 isNonRefIdentifier） */
function countRefs(relFile, name) {
  const sf = astOf.get(relFile)
  if (!sf) return 0
  let n = 0
  const visit = (node) => {
    if (ts.isIdentifier(node) && node.text === name && !isNonRefIdentifier(node)) n++
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return n
}

/** 收集一个文件的运行期导出（用**原文**解析，行号才对得上 —— 坑 ③） */
function collectExports(relFile, text) {
  const sf = ts.createSourceFile(relFile, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX)
  const found = []
  const push = (name, kind, node) => found.push({ name, kind, file: relFile, line: lineOf(sf, node) })
  for (const node of sf.statements) {
    // ⚠️ `export { … }` 子句**没有 export 修饰符**（它本身就是导出声明），
    //    必须排在下面那道 continue 之前 —— 坑 ②。
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const el of node.exportClause.elements) push((el.propertyName ?? el.name).text, 're-export', el)
      continue
    }
    const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined
    if (!mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue
    if (ts.isFunctionDeclaration(node) && node.name) push(node.name.text, 'function', node)
    else if (ts.isClassDeclaration(node) && node.name) push(node.name.text, 'class', node)
    else if (ts.isEnumDeclaration(node)) push(node.name.text, 'enum', node)
    else if (ts.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) push(d.name.text, 'const', d)
      }
    }
  }
  return found
}

const srcFiles = walk(SRC_GLOB[0], ['.ts', '.tsx'])
const prodFiles = [...srcFiles, ...walk('scripts', ['.mjs', '.js']), ...walk('tools', ['.mjs', '.js', '.ts'])]
const testFiles = walk('test', ['.mjs', '.js'])

const astOf = new Map()
for (const f of [...new Set([...prodFiles, ...testFiles])]) {
  astOf.set(f, parseFile(f, fs.readFileSync(path.join(ROOT, f), 'utf-8')))
}

const exportsList = []
for (const f of srcFiles) exportsList.push(...collectExports(f, fs.readFileSync(path.join(ROOT, f), 'utf-8')))

const allow = fs.existsSync(ALLOW_FILE) ? JSON.parse(fs.readFileSync(ALLOW_FILE, 'utf-8')).allow ?? [] : []
const allowMap = new Map(allow.map((e) => [`${e.file}::${e.name}`, e.reason ?? '(未写原因)']))

const rows = exportsList.map((sym) => {
  let prod = 0
  let test = 0
  for (const f of prodFiles) {
    if (f === sym.file) continue
    if (countRefs(f, sym.name) > 0) prod++
  }
  for (const f of testFiles) if (countRefs(f, sym.name) > 0) test++
  // 本文件内部出现次数 > 1（第一次就是声明本身）→ 用来区分「只该删 export」和「整段可删」
  const selfCount = countRefs(sym.file, sym.name)
  return { ...sym, prod, test, selfUse: selfCount > 1, exempt: allowMap.get(`${sym.file}::${sym.name}`) }
})

// ⚠️ 两个集合必须互斥：dead = 谁都没用；testOnly = 只有测试在用。
// 第一版 dead 的过滤条件漏了 `r.test === 0`，同一个符号会同时出现在两张表里，
// 汇总数字也对不上（"零调用点 46"里其实混着 7 条只在测试里用的）。
const dead = rows.filter((r) => r.prod === 0 && r.test === 0 && !r.exempt)
const testOnly = rows.filter((r) => r.prod === 0 && r.test > 0 && !r.exempt)
const exempted = rows.filter((r) => r.exempt)
const used = rows.filter((r) => r.prod > 0)

if (process.env.DSH_DEBUG_EXPORTS === '1') {
  for (const r of rows) console.error(`[debug] ${r.file}:${r.line} ${r.kind} ${r.name} prod=${r.prod} test=${r.test} exempt=${r.exempt ? 'Y' : 'N'}`)
}

const hint = (r) => (r.selfUse ? '[本文件内部有使用→可只删 export]' : '[无任何使用→整段可删]')

if (AS_JSON) {
  console.log(JSON.stringify({
    summary: {
      scanned: rows.length,
      used: used.length,
      testOnly: testOnly.length,
      dead: dead.length,
      exempted: exempted.length,
    },
    dead: dead.map((r) => ({ name: r.name, kind: r.kind, file: r.file, line: r.line, selfUse: r.selfUse, test: r.test })),
    testOnly: testOnly.map((r) => ({ name: r.name, kind: r.kind, file: r.file, line: r.line, selfUse: r.selfUse, test: r.test })),
    exempted: exempted.map((r) => ({ name: r.name, file: r.file, reason: r.exempt })),
  }, null, 2))
} else {
  console.log(`零调用点扫描（${ROOT}）`)
  console.log(`  运行期导出 ${rows.length}｜有生产调用方 ${used.length}｜仅测试引用 ${testOnly.length}｜零调用点 ${dead.length}｜白名单 ${exempted.length}\n`)
  if (testOnly.length) {
    console.log('── 仅测试引用（测试不算调用方：要么接进生产，要么降级为测试内部件）──')
    for (const r of testOnly) console.log(`  ${r.file}:${r.line}  ${r.kind.padEnd(9)} ${r.name.padEnd(26)} ${hint(r)}`)
    console.log('')
  }
  if (dead.length) {
    console.log('── 零调用点（未豁免）──')
    for (const r of dead) console.log(`  ${r.file}:${r.line}  ${r.kind.padEnd(9)} ${r.name.padEnd(26)} ${hint(r)}`)
    console.log('')
  }
  if (exempted.length) {
    console.log('── 白名单豁免（每条必须写明原因）──')
    for (const r of exempted) console.log(`  ${r.file}:${r.line}  ${r.name} —— ${r.exempt}`)
    console.log('')
  }
}

process.exit(dead.length === 0 ? 0 : 1)
