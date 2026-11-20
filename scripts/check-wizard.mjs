#!/usr/bin/env node
/**
 * 走完向导 **全部步骤**，逐条查"选项文案"——把原型踩过的那个坑变成门禁。
 *
 * ## 为什么要有它（原型原话，逐字抄）
 * > 选项文案的两种字段命名（单选用 b/d，底线那组用 t/s）——统一取，别再对不上。
 * > ⚠️ 2026-10-08 踩过：multi() 只认 b/d，values 用的是 t/s，整屏渲染成 undefined，
 * >    而且五轮没被发现（测试只查了守门与卡片拼句，**没查选项文案**）。
 *
 * ⇒ 判据必须覆盖"**选项文案**"，而不只是守门与卡片拼句。
 *   本仓此前只查了**一步**（`shoot-sandbox.mjs` 查第 5 步的"同行者"）
 *   —— 而那个坑的特征是**整屏 undefined**，只查一步拦不住。
 *
 * ## 判据（每条都能红）
 * ① 每步可见文本不许出现 `undefined` / `NaN` / `[object Object]`
 * ② 每步不许出现 TODO 占位（"还没从原型里抽全"）
 * ③ 每步的选项按钮文案必须非空
 * ④ ⭐ **步数必须真的前进**（否则"走了 10 步"其实是在同一步上重复拍了 10 次 —— 假绿）
 * ⑤ 全程 `pageerror` 为空
 *
 * ⛔ 只读截图台，不碰生产。
 * ⚠️ 向导全是**内联样式、没有 class** ⇒ 一律用**文字锚点**定位（步数行 / 按钮文案），
 *    ⛔ 不写 `[data-opt]`、`.mc-chip` 这类臆想出来的选择器
 *    （第一版就是这么写的，结果卡在同一步重复报"通过"，假绿）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PLAYWRIGHT = '/Users/admin/Desktop/Harness/dsh-src-0.1.7-rc.2/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs'
const CHROME = path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
const ROOT = path.resolve(import.meta.dirname, '..')
const PAGE = path.join(ROOT, 'sandbox.html')
const OUT = path.join(ROOT, '.screens', 'wizard')
if (!fs.existsSync(path.join(ROOT, 'lib', 'sandbox.js'))) {
  console.error('❌ 缺少 lib/sandbox.js —— 先跑 `npm run sandbox`')
  process.exit(2)
}
fs.mkdirSync(OUT, { recursive: true })
const { chromium } = await import(PLAYWRIGHT)
const browser = await chromium.launch({ executablePath: CHROME })
const page = await browser.newPage({ viewport: { width: 1279, height: 819 }, deviceScaleFactor: 1 })
const errs = []
page.on('pageerror', (e) => errs.push(String(e)))

/**
 * ⚠️ **所有查询都必须限定在向导子树里**：沙箱里向导是**覆盖层**，
 * 底下的 MemoryPanel 自己也有按钮（撤销 / 刷新 / 编辑）——
 * 第一版没限定，于是 `satisfy()` 点的是面板的"**撤销**"，难怪"下一步"一直不可用。
 * 向导**没有 class** ⇒ 用文字锚点定位：从 `<h2>` 往上找到"同时含步数行"的最近祖先当根。
 */
const WIZ_ROOT = `(() => {
  const h2 = document.querySelector('h2')
  let root = h2
  while (root && !/第\\s*\\d+\\s*步\\s*\\/\\s*共/.test(root.innerText || '')) root = root.parentElement
  return root
})()`

/** 读"当前是第几步 / 叫什么"，并列出**向导内**的选项按钮（排除导航按钮） */
const readStep = () => page.evaluate(`(() => {
  const root = ${WIZ_ROOT}
  if (!root) return { step: null, total: null, title: null, opts: [], txt: '', nextLabel: null, inWizard: false }
  const txt = root.innerText
  const m = txt.match(/第\\s*(\\d+)\\s*步\\s*\\/\\s*共\\s*(\\d+)\\s*步\\s*·\\s*(.+)/)
  const NAV = /^(上一步|下一步|完成|跳过|取消|返回|先跳过)$/
  const btns = [...root.querySelectorAll('button')]
  // ⚠️ **必须拆出"标签 span"本身**：React 把 undefined 渲染成**空 span**，不是字面 "undefined"
  //    ⇒ 第一版按"按钮 innerText 非空"判，而按钮里还有描述（d）⇒ **判不出来**。
  //    实测（故障注入）：坏项的 html 是「空 span + 描述 span」，
  //    按钮 innerText = 描述 ⇒ 非空 ⇒ 假绿。所以判据必须落到 children[0] 上。
  const opts = btns.filter((b) => !NAV.test((b.innerText || '').trim())).map((b) => {
    // ⚠️ chip 有**两种**形态，判据必须同时吃下（第一版只认两-span 形态 ⇒ 单 span 的全报空标签，假红）：
    //    (a) 简单 chip：就一段文字（无子 span）      ⇒ 标签 = innerText
    //    (b) 带描述的 chip：两个 span = 标签 + 描述   ⇒ 标签 = 第一个 span
    //    (c) **坏的**：两个 span，但**第一个是空的**  ⇒ 标签位渲染成了空 = 典型 undefined 字段
    const kids = [...b.children].map((c) => (c.textContent || '').trim())
    const hasDescSlot = kids.length >= 2
    const labelSlotEmpty = hasDescSlot && kids[0] === ''
    const desc = hasDescSlot ? kids[1] : ''
    const label = kids.find((x) => x) || (b.innerText || '').trim()
    return { label, desc, hasDescSlot, labelSlotEmpty, text: (b.innerText || '').trim() }
  })
  const next = btns.find((b) => /^(下一步|完成)$/.test((b.innerText || '').trim()) && !b.disabled)
  return {
    step: m ? Number(m[1]) : null, total: m ? Number(m[2]) : null, title: m ? m[3].trim() : null,
    opts, txt, nextLabel: next ? next.innerText.trim() : null, inWizard: true,
  }
})()`)

/**
 * 满足"必填"。
 * ⛔ **必须用 Playwright 的 `fill()`（真用户输入），不许 DOM 硬改 value**：
 *    第一版用 `HTMLInputElement.prototype.value` 的 setter + `dispatchEvent('input')`，
 *    实测**填完还是空的**（React 受控组件把状态又刷回空串）⇒ 于是"下一步"一直不可用，
 *    走查卡死在第 1 步 —— 看起来在跑，其实什么都没走。
 * ⛔ 也要跳过面板自己的搜索框（`搜标题 / 标签…`），否则会把列表改掉、污染后面几步的判据。
 */
const satisfy = async () => {
  // ⛔ 选择器**不许写 「input[type="text"]」**：那些 `<input>` **没有 type 特性**
  //    （「el.type」 读的是 DOM 属性默认值 "text"，CSS 特性选择器匹配不到 ⇒ 实测找到 **0 个**输入，
  //     于是"填了但没填上"、走查卡死在第 1 步）。一律用 「input, textarea」 + 按属性过滤。
  const inputs = await page.locator('input, textarea').all()
  for (const el of inputs) {
    const ph = (await el.getAttribute('placeholder')) ?? ''
    if (ph.includes('搜标题')) continue                  // 面板的搜索框，⛔ 不碰
    if (!(await el.isVisible().catch(() => false))) continue
    if (!(await el.inputValue().catch(() => '')).trim()) await el.fill('测试值').catch(() => {})
  }
  // 选项：点**向导子树内**的第一个（⛔ 不许点到面板的"撤销"上 —— 第一版就是这么错的）
  return page.evaluate(`(() => {
    const root = ${WIZ_ROOT}
    if (!root) return 0
    const NAV = /^(上一步|下一步|完成|跳过|取消|返回|先跳过)$/
    const opts = [...root.querySelectorAll('button')].filter((b) => !NAV.test((b.innerText || '').trim()))
    if (opts[0]) opts[0].click()
    return opts.length
  })()`)
}

const clickNext = () => page.evaluate(`(() => {
  const root = ${WIZ_ROOT}
  if (!root) return null
  const next = [...root.querySelectorAll('button')].find((b) => /^(下一步|完成)$/.test((b.innerText || '').trim()) && !b.disabled)
  if (!next) return null
  const label = next.innerText.trim()
  next.click()
  return label
})()`)

await page.goto(`file://${PAGE}`, { waitUntil: 'load' })
await new Promise((r) => setTimeout(r, 3500))

const BAD = ['undefined', 'NaN', '[object Object]', '还没从原型里抽全']
const fails = []
const seen = []
console.log('── 向导逐步骤文案门禁 ──')
let last = 0
for (let i = 1; i <= 12; i++) {
  const s = await readStep()
  if (s.step === null) {
    // 已经离开向导（转场/Agent 视图）⇒ 正常结束
    console.log(`  第 ${i} 次读取：向导已收起（走完了）`)
    break
  }
  const hit = BAD.filter((b) => s.txt.includes(b))
  // ⭐ 主判据：**标签位不许是空的**（这才是"选项文案"那一层）
  const emptySlot = s.opts.filter((o) => o.labelSlotEmpty)
  const noText = s.opts.filter((o) => !o.label)
  if (hit.length) fails.push(`步骤 ${s.step}（${s.title}）坏文案：${hit.join(' / ')}`)
  if (emptySlot.length) fails.push(`步骤 ${s.step}（${s.title}）有 ${emptySlot.length} 个**标签位渲染成空**（典型 undefined 字段）：拿到的只有描述「${emptySlot.map((o) => o.desc.slice(0, 20)).join(' / ')}」`)
  if (noText.length) fails.push(`步骤 ${s.step}（${s.title}）有 ${noText.length} 个选项**完全没有文字**`)
  // 带描述位的，描述也该有（有标签没描述 = 抽漏了 d）
  const noDesc = s.opts.filter((o) => o.hasDescSlot && o.desc === '')
  if (noDesc.length) fails.push(`步骤 ${s.step}（${s.title}）有 ${noDesc.length} 个选项**缺描述**：${noDesc.map((o) => o.label).join(' / ')}`)
  // 末步是收尾页（"行了"），本来就没有选项 ⇒ 只对**非末步**要求"必须有选项"
  if (s.opts.length === 0 && s.step !== s.total) {
    fails.push(`步骤 ${s.step}（${s.title}）**一个选项按钮都没有**（可能是 TODO 占位或渲染失败）`)
  }
  seen.push({ step: s.step, title: s.title, opts: s.opts.length })
  const labels = s.opts.map((o) => o.label).filter(Boolean)
  console.log(`  步骤 ${String(s.step).padStart(2)}/${s.total}  ${String(s.title).slice(0, 20).padEnd(22)} 选项 ${String(s.opts.length).padStart(2)} ｜ 空标签位 ${emptySlot.length ? '❌ ' + emptySlot.length : '0 ✅'} ｜ ${labels.slice(0, 6).join(' / ')}`)
  await page.screenshot({ path: path.join(OUT, `step-${String(s.step).padStart(2, '0')}.png`) })
  await satisfy()
  await new Promise((r) => setTimeout(r, 150))
  const label = await clickNext()
  if (!label) { fails.push(`步骤 ${s.step} 的"下一步/完成"按钮不可用（必填没满足或控件坏了）`); break }
  await new Promise((r) => setTimeout(r, 400))
  // ⭐ 断言"真的前进了"：不然就是同一步重复拍（第一版假绿的原因）
  const after = await readStep()
  if (after.step !== null && after.step === s.step) {
    fails.push(`步骤 ${s.step} 点了"${label}"但**步数没前进** ⇒ 走查是假的（假绿）`)
    break
  }
  last = s.step
}
console.log(`\n  实际走到：第 ${last} 步 ｜ 去过 ${new Set(seen.map((x) => x.step)).size} 个不同步骤 ｜ pageerror: ${errs.length ? errs.slice(0, 2).join(' | ') : '无'}`)
if (errs.length) fails.push(`页面报错：${errs.slice(0, 2).join(' | ')}`)
if (new Set(seen.map((x) => x.step)).size < 8) fails.push(`只走到 ${new Set(seen.map((x) => x.step)).size} 个不同步骤（<8）⇒ 没真正走完，判据不成立`)

if (fails.length) {
  console.error('\n❌ 向导文案门禁不过：')
  for (const f of fails) console.error(`   · ${f}`)
  await browser.close()
  process.exit(1)
}
console.log('\n✅ 向导文案门禁通过（截图在 .screens/wizard/）')
await browser.close()
