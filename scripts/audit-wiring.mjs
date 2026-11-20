#!/usr/bin/env node
/**
 * 「机制 ↔ 界面」挂载对账（Teddy：怀疑有些机制没挂到页面上）。
 *
 * 判据（**调用点**，不是名字出现）：
 *   宿主侧每条 API 路由 / 每个注入给客户端的方法
 *     ⇒ 在 `src/client/*.tsx` 里是否有**真实调用**（正则 `\bname\(`），glyph 出现在注释/类型里不算。
 * 输出三栏：能力 → 调用点（文件:行）→ 判定。
 * ⛔ 没有调用点的，要么补 UI，要么**在下面的"设计上无 UI"清单里写明原因** —— 不许默认忽略。
 */
import fs from 'node:fs'
import path from 'node:path'

const SRC = path.resolve(import.meta.dirname, '..', 'src')
const CLIENT = path.join(SRC, 'client')

const apiSrc = fs.readFileSync(path.join(SRC, 'api.ts'), 'utf-8')
const idxSrc = fs.readFileSync(path.join(CLIENT, 'index.ts'), 'utf-8')

/** 宿主路由 */
const routes = [...new Set([...apiSrc.matchAll(/['"](\/[a-z][a-z0-9/:.-]*)['"]/g)].map((m) => m[1]))]
  .filter((r) => !r.startsWith('/selftest'))

/** 注入给客户端的方法名（index.ts 里 `const xxx = async`，以及返回对象里的键） */
const injected = [...new Set([...idxSrc.matchAll(/^\s{2}const ([a-zA-Z]+) = /gm)].map((m) => m[1]))]

/** 客户端组件（不含 index.ts —— 它只是接线） */
const files = fs.readdirSync(CLIENT).filter((f) => f.endsWith('.tsx')).map((f) => path.join(CLIENT, f))
const sources = files.map((f) => ({ f: path.basename(f), text: fs.readFileSync(f, 'utf-8') }))

/**
 * 别名：组件里常把注入方法**解构改名**（`graph: graphApi`），
 * 或者叫法不同（`identity: identityApi`）⇒ 只按原名找会**误报"没调用"**。
 * 这里把"注入名 → 组件里的实际变量名"补上（有新的改名就加一行）。
 */
const ALIASES = {
  graph: ['graphApi'],
  identity: ['identityApi'],
  updateEntry: ['updateEntry'],
  getEntry: ['getEntry'],
}

/** 只认真正的注入方法（过滤掉 index.ts 里的局部变量 / 形参） */
const INJECTED_REAL = ['list', 'graph', 'getEntry', 'updateEntry', 'confirmPending', 'discardPending',
  'relocate', 'supersede', 'expire', 'onboarding', 'identity', 'saveIdentity', 'markOnboarded']

const callSites = (name) => {
  const hits = []
  for (const s of sources) {
    s.text.split('\n').forEach((line, i) => {
      if (line.trim().startsWith('*') || line.trim().startsWith('//')) return
      if (new RegExp(`\\b${name}\\s*\\(`).test(line) && !new RegExp(`(function|const|async)\\s+${name}\\b`).test(line)) {
        hits.push(`${s.f}:${i + 1}`)
      }
    })
  }
  return hits
}

/** 路由 → 客户端调用点：按路由名去组件里找（relocate / supersede / expire / pending / identity / onboarding …） */
const ROUTE_UI = {
  '/list': 'list',
  '/graph': 'graph',
  '/entry/': 'getEntry / updateEntry',
  '/entry-relocate/': 'relocate',
  '/entry-supersede/': 'supersede',
  '/entry-expire/': 'expire',
  '/pending/': 'confirmPending / discardPending',
  '/identity': 'identity / saveIdentity',
  '/onboarding': 'onboarding / markOnboarded',
  // ⚠️ 新加路由**必须同步登记这里** —— 否则脚本会把"已接好"误报成"缺调用点"（2026-10-10 就误报过 3 条）
  '/decay-state': 'decayState',
  '/decay-sweep': 'decaySweep',
  '/decay-rollback': 'decayRollback',
}

/** 设计上就没有 UI 的（必须写原因，不许空着） */
const NO_UI_BY_DESIGN = {
  '/selftest': '运维探针（给人/给脚本看的），不是用户功能 —— 已排除',
  '/decay-sweep': '**开机自动跑**（一天一次）；手动触发属运维动作（与 /selftest 同类），不挂界面 —— 2026-10-10 定',
  // 【2026-10-14】两个只读排障探针。⛔ 归这里是因为**它们本来就不该有界面**，
  // 不是为了把红消掉 —— 别把"缺调用点"糊成"设计如此"。
  '/decay-why': '排障探针：问"**这条为什么没退场**"（给人/给脚本 curl 的），不是用户功能 —— 2026-10-14 定',
  '/decay-batches': '排障探针：列出**可回滚的批次**（运维查批次号用，配合 POST /decay-rollback 的 batch 参数），不是用户功能 —— 2026-10-14 定',
}

const pad = (s, n) => String(s).padEnd(n)
console.log('\n════ 机制 ↔ 界面 挂载对账 ════\n')
let missing = 0
console.log(pad('宿主路由', 26) + pad('经哪个注入面', 30) + '客户端调用点 / 判定')
console.log('─'.repeat(110))
for (const r of routes) {
  // ⚠️ "设计上无 UI"的必须**先跳过**（否则那句理由只出现在打印里、计数照样算缺 —— 2026-10-10 实测的脚本 bug）
  if (NO_UI_BY_DESIGN[r]) { console.log(pad(r, 26) + pad('(设计上无 UI)', 30) + 'ℹ️  ' + NO_UI_BY_DESIGN[r]); continue }
  const via = ROUTE_UI[r] ?? '(未登记)'
  const names = via.split('/').map((s) => s.trim()).filter((s) => /^[a-zA-Z]+$/.test(s))
  const hits = names.flatMap((n) => [...callSites(n), ...(ALIASES[n] ?? []).flatMap((a) => callSites(a))])
  const ok = hits.length > 0
  if (!ok) missing++
  console.log(pad(r, 26) + pad(via, 30) + (ok ? `✅ ${hits.slice(0, 2).join(', ')}${hits.length > 2 ? ` +${hits.length - 2}` : ''}` : '❌ 没有调用点'))
}
console.log('\n── 注入面里**从没被组件调用**的方法 ──')
const unused = INJECTED_REAL.filter((n) => callSites(n).length === 0 && (ALIASES[n] ?? []).every((a) => callSites(a).length === 0))
console.log(unused.length ? unused.map((n) => '  ❌ ' + n).join('\n') : '  （全部有调用点）')

console.log('\n── 设计上无 UI（写明原因才算数）──')
for (const [k, why] of Object.entries(NO_UI_BY_DESIGN)) console.log(`  · ${k}：${why}`)

console.log(`\n结论：路由 ${routes.length} 条，缺调用点 ${missing} 条；注入方法 ${INJECTED_REAL.length} 个，无调用 ${unused.length} 个。\n`)
process.exit(missing || unused.length ? 1 : 0)
