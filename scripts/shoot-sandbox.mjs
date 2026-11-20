#!/usr/bin/env node
/** 拍**我们自己的面板**（沙箱页）——与 shoot-prototype.mjs 同款"验明正身"。 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const PLAYWRIGHT = '/Users/admin/Desktop/Harness/dsh-src-0.1.7-rc.2/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs'
const CHROME = path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
const PAGE = path.resolve(import.meta.dirname, '..', 'sandbox.html')
// ⚠️ **先确认沙箱包在**：`npm run build`（tsdown）的 clean 会把 `lib/` 清掉 ⇒ `lib/sandbox.js` 消失
// ⇒ 页面空白 ⇒ 每张都 MISS（2026-10-10 卡了 B7 一整天，根因就是这个）。宁可在这里直接报错。
const BUNDLE = path.resolve(import.meta.dirname, '..', 'lib', 'sandbox.js')
if (!fs.existsSync(BUNDLE)) {
  console.error('❌ 缺少 lib/sandbox.js —— 先跑 `npm run sandbox`（`npm run shoot` 已包含）')
  process.exit(2)
}
const OUT = path.resolve(import.meta.dirname, '..', '.screens', 'ours')
fs.mkdirSync(OUT, { recursive: true })
const { chromium } = await import(PLAYWRIGHT)
const browser = await chromium.launch({ executablePath: CHROME })
const page = await browser.newPage({ viewport: { width: 1279, height: 819 }, deviceScaleFactor: 2 })
const errs = []
page.on('pageerror', (e) => errs.push(String(e)))
const shot = async (name, sel) => {
  const ok = sel ? await page.evaluate((s) => { const el = document.querySelector(s); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }, sel).catch(() => false) : true
  const f = path.join(OUT, `${ok ? '' : 'MISS-'}${name}.png`)
  await page.screenshot({ path: f })
  console.log(`  ${ok ? '✅' : '⚠️ '} ${path.basename(f)}`)
}
await page.goto(`file://${PAGE}`, { waitUntil: 'load' })
await new Promise((r) => setTimeout(r, 3500))   // ⚠️ 1.5s 不够了：agent-css 那份样式表 + React 变大 ⇒ 抓早了会拍空白
await shot('01-面板默认', '.item')
console.log('  pageerror:', errs.length ? errs.slice(0, 2) : '无')
// 点第一行 → 行内展开
await page.evaluate(() => { const r = document.querySelector('.item'); if (r) r.click() })
await new Promise((r) => setTimeout(r, 600))
await shot('02-点行展开', '.item')
// 点「编辑」→ 抽屉
// ⚠️ 两层坑，都在这几行里：
//  ① 之前点的是**第一行**（h01 = 只读锚点）⇒ 抽屉里的**可编辑表单从没被拍过**
//     ⇒ "标签和输入框挤成一行"这种错漏漏到今天；
//  ② 列表**默认落「热」层**，而热层全是 h*（只读）⇒ 光"找一条 l* 行"根本找不到（截图直接 MISS）。
//  ⇒ 先切层筛选到「长期」，再点编辑 —— React 受控 select 要用原生 setter 才能触发 onChange。
await page.evaluate(() => {
  const sel = document.querySelector('.filters select')
  if (!sel) return
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
  setter.call(sel, 'longterm')
  sel.dispatchEvent(new Event('change', { bubbles: true }))
})
await new Promise((r) => setTimeout(r, 600))
await page.evaluate(() => { const b = document.querySelector('.item .editbtn'); if (b) b.click() })
await new Promise((r) => setTimeout(r, 900))
await shot('03-抽屉-可编辑', '.drawer.open .dbody label.f')
// 点名字 → 身份面板（头像 / 名字 / 性别）—— 之前这块"点了没反应"，所以要拍到它才算数
await page.evaluate(() => { const el = document.querySelector('[title="点这里改名字 / 性别"]'); if (el) el.click() })
await new Promise((r) => setTimeout(r, 700))
await shot('04-身份面板', 'input[placeholder="怎么称呼你"]')
// 【B9 证据】向导第 2 步的选项必须是**原型里的真实文案**（不是 TODO）
// ⚠️ 第 1 步有**两个必填文本框** ⇒ 不填则"下一步"是禁用的（点了也不动）——
//    这就是 B9 判据第一次红的真因：脚本停在第一步，自然看不到第 2 步的选项。
//    ⇒ 走**真实交互**：按 placeholder 填值，再点下一步。
await page.fill('input[placeholder="你的名字，或你想让我怎么叫你"]', '天雨')
await page.fill('input[placeholder="你想怎么叫我"]', '助手')
await new Promise((r) => setTimeout(r, 300))
await page.evaluate(() => {
  const nx = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === '下一步')
  if (nx && !nx.disabled) nx.click()
  else console.error('⚠️ 下一步仍是禁用（必填没满足）')
})
await new Promise((r) => setTimeout(r, 700))
// ⚠️ 判据必须**能红**：不能只断言"面板在"，要断言**原型里的真实选项文案**在页面上
// （否则 TODO 占位也会拍成"通过" —— 这正是今天反复吃的亏）
{
  const ok = await page.evaluate(() => document.body.innerText.includes('同行者') && document.body.innerText.includes('你扛事，我扛立场'))
  if (!ok) { console.error('❌ 向导里没有原型真实选项文案（同行者 / 你扛事，我扛立场）⇒ 可能是 TODO 占位'); process.exit(3) }
}
await shot('05-向导-位置（真选项）', '.mc-agent')

// 【B8 证据·组件级】直接拍「唤醒」覆盖层（沙箱 ?wake=hold）。
// ⚠️ 判据**能红**：必须同时有覆盖层（`[title="点一下跳过"]`）**和**「唤醒」两个字。
{
  await page.goto(`file://${PAGE}?wake=hold`, { waitUntil: 'load' })
  await new Promise((r) => setTimeout(r, 1200))
  const ok = await page.evaluate(() => !!document.querySelector('[title="点一下跳过"]') && document.body.innerText.includes('唤醒'))
  if (!ok) { console.error('❌ 唤醒覆盖层没渲染出来'); process.exit(3) }
  await page.screenshot({ path: path.join(OUT, '08-唤醒覆盖层.png') })
  console.log('  ✅ 08-唤醒覆盖层.png')
  // ⛔ **必须导航回正常页**：`?wake=hold` 是"覆盖层永远在"的静态页，
  //    不回退的话后面 06/07 全跑在它上面 ⇒ 06 会**假绿**、07 会假红（2026-10-10 自己踩的）。
  await page.goto(`file://${PAGE}`, { waitUntil: 'load' })
  await new Promise((r) => setTimeout(r, 3500))
}


// 【B8 证据】把向导走到「完成」⇒ 触发「唤醒」转场 ⇒ 立刻拍那一帧
// 通用步进器：每步把空的必填文本框填上（React 受控 ⇒ 用原生 setter），再点"下一步/完成"
const setNative = (el, v) => {
  const d = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value')
  d.set.call(el, v)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}
for (let i = 0; i < 14; i++) {
  await page.evaluate(() => {
    const setN = (el, v) => {
      const d = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value')
      d.set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    // ⚠️ 向导的文本框是 <input> **没有 type 属性** ⇒ `input[type="text"]` 选不到（踩过）
    //    用 `input[placeholder]` 选，排除列表页那个搜索框
    document.querySelectorAll('input[placeholder]').forEach((el) => {
      if ((el.placeholder || '').startsWith('搜标题')) return
      if (!el.value) setN(el, '测试')
    })
    document.querySelectorAll('textarea').forEach((el) => { if (!el.value) setN(el, '测试') })
  })
  await new Promise((r) => setTimeout(r, 180))
  const label = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => ['下一步', '完成'].includes((x.textContent || '').trim()) && !x.disabled)
    if (!b) return null
    const t = b.textContent.trim(); b.click(); return t
  })
  if (label === '完成') break
  if (!label) {
    // 没有可点的"下一步" ⇒ 大概缺必填的 chip：点第一个未选中的 chip
    await page.evaluate(() => {
      // 必填的"选一个"（chips）没选 ⇒ 点**第一个真正的选项按钮**。
      // ⛔ 排除导航类按钮（按文案名单 —— 这些文案是向导自己的，不会和选项撞）。
      const NAV = ['下一步', '完成', '上一步', '跳过', '刷新', '选一张', '撤销', '确定', '取消', '保存', '还原', '编辑', '去掉']
      const chip = Array.from(document.querySelectorAll('button')).find((b) => {
        const t = (b.textContent || '').trim()
        return t.length > 1 && !NAV.includes(t) && !b.disabled && b.offsetParent
      })
      chip?.click()
    })
    await new Promise((r) => setTimeout(r, 150))
  }
}
await new Promise((r) => setTimeout(r, 350))   // 落在 solid/hold 之间 ⇒ 看得到「唤醒」两个字
// ⚠️ 判据必须**能红**：断言的是"唤醒覆盖层真的在"（`title="点一下跳过"` 是它独有的）+
//    页面上真的有「唤醒」两个字 —— ⛔ 不能拿"面板在不在"当判据（那正是我先前假绿的来源）
{
  const ok = await page.evaluate(() => !!document.querySelector('[title="点一下跳过"]') && document.body.innerText.includes('唤醒'))
  if (!ok) { console.error('❌ 没拍到「唤醒」覆盖层（可能向导没走到完成）'); process.exit(3) }
}
await shot('06-唤醒转场', '[title="点一下跳过"]')

// 等转场跑完 ⇒ 拍"切到 Agent 视图"那一帧（验收标准要的第二帧）。
// ⚠️ **轮询等它消失**，⛔ 不写死等待时间：转场总时长 3.9s（TL 累加）+ 定时器漂移，
//    写死 4.5s 会卡在边界上、把"正常"误报成"转场收不了尾"（2026-10-10 实测：5s 时已消失）。
{
  const deadline = Date.now() + 8000
  let gone = false
  while (Date.now() < deadline) {
    gone = await page.evaluate(() => !document.querySelector('[title="点一下跳过"]'))
    if (gone) break
    await new Promise((r) => setTimeout(r, 250))
  }
  if (!gone) { console.error('❌ 转场没有结束（8s 后覆盖层还在）⇒ 节奏或 cleanup 有问题'); process.exit(3) }
}
await shot('07-转场结束-Agent视图', '.item')
// 【衰减 UI 证据】M>0 的分支：那行提示 + 撤销按钮必须同时出现（判据能红）
{
  await page.goto(`file://${PAGE}`, { waitUntil: 'load' })
  await new Promise((r) => setTimeout(r, 3500))
  const ok = await page.evaluate(() => {
    const txt = document.body.innerText
    const hasLine = txt.includes('今天自动归档 3 条')
    const hasUndo = Array.from(document.querySelectorAll('button')).some((b) => (b.textContent || '').trim() === '撤销')
    return hasLine && hasUndo
  })
  if (!ok) { console.error('❌ 衰减那行/撤销按钮没同时出现'); process.exit(3) }
  await page.screenshot({ path: path.join(OUT, '09-衰减-今天自动归档3条-撤销.png') })
  console.log('  ✅ 09-衰减-今天自动归档3条-撤销.png')
}

console.log(`\n输出：${OUT}`)
await browser.close()
