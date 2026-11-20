#!/usr/bin/env node
/**
 * UI 对账：**原型（真源）↔ 我们实现** 的逐项数值比对。
 *
 * ## 为什么必须有它
 * 前面几轮我一直在"手抄参数"——把原型 CSS 的值抄进 React 内联样式，
 * 于是有了**两份手写真源**，漂移必然发生，而且**没有任何东西能发现漂移**
 * （这正是本仓纪律里那句「⛔ 不写第二份手写判据」的反面教材）。
 * 这个脚本把"眼看"换成"机器比"：从原型的 `<style>` 里抽关键规则，再去我们的源码里找同样的值。
 *
 * 用法：node scripts/audit-ui-parity.mjs [--proto <html>] [--json]
 * 退出码：0 = 全对齐；1 = 有漂移（每条都打印"原型值 / 我们值"）
 */

import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const arg = (n, fb) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : fb }
const PROTO = path.resolve(arg('--proto', '/Users/admin/Documents/Obsidian Vault/03_项目/记忆插件UI沙箱/01-Memory.html'))
const SRC = path.resolve(import.meta.dirname, '..', 'src', 'client')

const html = fs.readFileSync(PROTO, 'utf-8')
const css = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? ''
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1].replace(/\s+/g, ' ').trim(), m[2].replace(/\s+/g, ' ').trim()])

/**
 * 取某条选择器的某个属性值 —— **精确匹配选择器**（不是 includes 模糊匹配）。
 * ⚠️ 第一版写的是 `s.includes(sel)`，于是 `.dhead` 会命中 `.dhead .x` 那条 ⇒
 *    抽到的是**别的规则的 padding**，一路"全命中"，给出**假绿**。
 *    一个不会红的判据比没有判据更糟 —— 所以这里按"选择器逐段完全相等"来对。
 */
const bySel = new Map()
for (const [sel, body] of rules) {
  for (const one of sel.replace(/\/\*[\s\S]*?\*\//g, '').split(',').map((x) => x.replace(/\s+/g, ' ').trim())) {
    if (!bySel.has(one)) bySel.set(one, body)
  }
}
const val = (sel, prop) => {
  const body = bySel.get(sel.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim())
  if (!body) return null
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(body)
  return m ? m[1].trim() : null
}

/** 我们这边:把所有 client 源码拼起来找值 */
const sources = fs.readdirSync(SRC).filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'))
const ours = sources.map((f) => fs.readFileSync(path.join(SRC, f), 'utf-8')).join('\n')

/** 一条对账：原型值 vs 我们源码里是否存在该值 */
const checks = [
  ['主区 .app gap',        val('.app', 'gap'),            null],
  ['主区 .app padding',    val('.app', 'padding'),        null],
  ['左栏 .left 圆角',      val('.left', 'border-radius'), null],
  ['筛选卡 .bar padding',  val('.bar', 'padding'),        null],
  ['控件字号',             val('.filters select', 'font-size'), null],
  ['控件圆角',             val('.filters select', 'border-radius'), null],
  ['行内边距 .item .h',    val('.item .h', 'padding'),     null],
  ['行 id 字号',           val('.item .id', 'font-size'),  null],
  ['行标题字号',           val('.item .t', 'font-size'),   null],
  ['日期字号 .item .u',    val('.item .u', 'font-size'),   null],
  ['图例字号',             val('.legend ', 'font-size'),   null],
  ['图例间距',             val('.legend ', 'gap'),         null],
  ['图例圆点',             val('.legend i', 'width'),      null],
  ['胶囊内边距 .who',      val('.who', 'padding'),        null],
  ['胶囊名字号 .wname',    val('.wname ', 'font-size'),    null],
  ['抽屉头 padding',       val('.dhead ', 'padding'),      null],
  ['抽屉体 padding',       val('.dbody ', 'padding'),      null],
  ['表单标签字号',         val('.dbody label.f', 'font-size'),    null],
  ['只读区圆角 .ro',       val('.ro ', 'border-radius'),   null],
  ['只读区 padding .ro',   val('.ro ', 'padding'),         null],
  ['分段控件 .seg 圆角',   val('.seg', 'border-radius'),  null],
  ['正文框 .mdbox 圆角',   val('.mdbox ', 'border-radius'), null],
  ['正文框 .mdbox padding', val('.mdbox ', 'padding'),     null],
]

const num = (v) => (v ?? '').match(/-?[0-9.]+(px|%)?/g) ?? []
const rows = []
for (const [name, protoVal] of checks) {
  if (!protoVal) { rows.push({ name, proto: '(原型里没抽到)', ours: '—', ok: null }); continue }
  // 判据：原型这条里的**每个数值**都必须出现在我们的源码里（⛔ 少一个 = 漂移）
  const parts = num(protoVal)
  const missing = parts.filter((p) => !ours.includes(p))
  rows.push({ name, proto: protoVal, ours: missing.length ? `缺 ${missing.join(', ')}` : '✓ 全命中', ok: missing.length === 0 })
}

const bad = rows.filter((r) => r.ok === false)
if (args.includes('--json')) {
  console.log(JSON.stringify({ proto: PROTO, rows, drift: bad.length }, null, 2))
} else {
  console.log(`\n════ UI 对账（原型 ↔ 我们）════\n原型：${PROTO}\n`)
  for (const r of rows) {
    const mark = r.ok === true ? '✅' : r.ok === false ? '❌' : '⚠️ '
    console.log(`  ${mark} ${r.name.padEnd(22)} 原型 ${String(r.proto).padEnd(26)} ${r.ours}`)
  }
  console.log(`\n漂移 ${bad.length} 项 / 共 ${rows.length} 项`)
}
process.exit(bad.length ? 1 : 0)
