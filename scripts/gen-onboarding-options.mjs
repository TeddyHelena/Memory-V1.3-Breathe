#!/usr/bin/env node
/**
 * 从原型**机械生成**「认识一下」向导的选项数据（⛔ 不手抄）。
 *
 * 为什么：向导在原型里是**数据驱动**的 —— `single(OPTS.role,'role','#o-role')`，
 * 所有选项都在一个 `OPTS` 对象里。我前面两轮在 **CSS** 里找它们的形状（方向就错了），
 * 所以一直只敢在界面上挂 TODO。现在直接从原型抽 `OPTS` ⇒ 生成 TS 模块。
 *
 * 用法：node scripts/gen-onboarding-options.mjs [--proto <html>] [--out <ts>]
 * 原型一变 ⇒ 重跑即可（同 `gen-agent-css.mjs`）。
 */
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const arg = (n, fb) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : fb }
const PROTO = path.resolve(arg('--proto', '/Users/admin/Documents/Obsidian Vault/03_项目/记忆插件UI沙箱/01-Memory.html'))
const OUT = path.resolve(arg('--out', path.join(import.meta.dirname, '..', 'src', 'client', 'onboarding-options.ts')))

const html = fs.readFileSync(PROTO, 'utf-8')
const m = /(?:const|let|var)\s+OPTS\s*=\s*\{/.exec(html)
if (!m) { console.error('❌ 原型里没找到 `OPTS = {`'); process.exit(2) }
const start = m.index + m[0].length - 1
let depth = 0, end = start
for (let k = start; k < html.length; k++) {
  if (html[k] === '{') depth++
  else if (html[k] === '}') { depth--; if (depth === 0) { end = k; break } }
}
const body = html.slice(start, end + 1)

const header = `/**
 * ⚠️ **别手改这个文件** —— 由 \`scripts/gen-onboarding-options.mjs\` 从原型**机械生成**：
 *   \`node scripts/gen-onboarding-options.mjs\`
 * 真源：\`03_项目/记忆插件UI沙箱/01-Memory.html\` 里的 \`const OPTS = {...}\`。
 * 原型一变就重跑 —— 这样"我们这份"与"原型那份"永远同源（⛔ 不再靠手抄，
 * 前面两轮就是因为手抄 / 找错地方，向导选项一直只敢挂 TODO）。
 */
export const OPTS = ${body} as const

export type OnboardingOptions = typeof OPTS
`
fs.writeFileSync(OUT, header, 'utf-8')
const keys = [...body.matchAll(/^\s{2}([a-zA-Z]+):\s*\[/gm)].map((x) => x[1])
console.log(`✅ 已生成 ${path.basename(OUT)}（${body.length} 字符）｜包含：${keys.join(', ')}`)
