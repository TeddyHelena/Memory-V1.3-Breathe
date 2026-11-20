#!/usr/bin/env node
/**
 * 从原型**机械生成**样式表（⛔ 不是手抄）。
 *
 * 为什么要有它：我前面几轮一直"手抄参数"进内联样式 ⇒ **两份手写真源** ⇒ 漂移必然发生、
 * 且没有东西能发现。改成：原型 CSS 是**唯一真源**，本脚本把它**原样搬**成 TS 模块
 * （只加一层作用域前缀，避免污染宿主 DOM）。
 *
 * 用法：node scripts/gen-agent-css.mjs [--proto <html>] [--out src/client/agent-css.ts]
 * 生成物由 git 跟踪：**原型一变，重跑即可**（对账判据会提醒你）。
 */
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const arg = (n, fb) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : fb }
const PROTO = path.resolve(arg('--proto', '/Users/admin/Documents/Obsidian Vault/03_项目/记忆插件UI沙箱/01-Memory.html'))
const OUT = path.resolve(arg('--out', path.join(import.meta.dirname, '..', 'src', 'client', 'agent-css.ts')))
const SCOPE = 'mc-agent'

const html = fs.readFileSync(PROTO, 'utf-8')
const raw = html.match(/<style>([\s\S]*?)<\/style>/)?.[1]
if (!raw) { console.error('❌ 原型里没找到 <style>'); process.exit(2) }

/** 去掉注释（保留结构），再按规则拆 */
const css = raw.replace(/\/\*[\s\S]*?\*\//g, '')
const out = []
let i = 0
let skipped = 0
while (i < css.length) {
  const open = css.indexOf('{', i)
  if (open < 0) break
  let depth = 1, j = open + 1
  while (j < css.length && depth > 0) { if (css[j] === '{') depth++; else if (css[j] === '}') depth--; j++ }
  const sel = css.slice(i, open).trim()
  const body = css.slice(open + 1, j - 1)
  i = j
  if (!sel) continue
  if (sel.startsWith('@')) { skipped++; continue }        // 关键帧/媒体查询先不动（面板用不到）
  if (sel.includes(':root')) {
    // ⚠️ 第一版我把 :root **跳过**了 —— 结果原型那 251 条规则全靠 `var(--bg)/var(--card)/var(--text)`，
    //    变量一没定义，整份样式表**全部落空**（等于没搬）。⇒ 变量块必须跟着一起搬，只是改成作用域形式。
    out.push(`.${SCOPE} {${body}}`)
    continue
  }
  // 作用域：每条选择器都挂到 .mc-agent（逗号分开逐个加）
  const scoped = sel.split(',').map((one) => {
    const s = one.replace(/\s+/g, ' ').trim()
    if (!s) return ''
    if (s.startsWith('#')) return `.${SCOPE} ${s}`          // #cv / #list 这类 id 也挂进去
    return `.${SCOPE} ${s}`
  }).filter(Boolean).join(', ')
  out.push(`${scoped} {${body}}`)
}

const header = `/**
 * ⚠️ **别手改这个文件** —— 它由 \`scripts/gen-agent-css.mjs\` 从原型**机械生成**：
 *   \`node scripts/gen-agent-css.mjs\`
 * 真源：\`03_项目/记忆插件UI沙箱/01-Memory.html\` 的 <style>。原型一变就重跑，
 * 这样"我们这份"与"原型那份"永远同源（⛔ 不再靠手抄参数）。
 * 作用域：每条规则都挂在 \`.${SCOPE}\` 下 ⇒ 不污染宿主 DOM 的类名空间。
 */
export const AGENT_CSS = ${JSON.stringify(out.join('\n'))}
`

fs.writeFileSync(OUT, header, 'utf-8')
console.log(`✅ 已生成 ${path.basename(OUT)}：${out.length} 条规则（跳过 @/root ${skipped} 条），作用域 .${SCOPE}`)
