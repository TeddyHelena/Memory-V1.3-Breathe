#!/usr/bin/env node
/**
 * 原型截图台 —— Teddy 2026-10-10 教的办法：
 * 「你把 Agent 那个页面每个页面都截图，然后一个一个对着改一个一个细节找。
 *   找五轮指定比现在强老多了。」
 *
 * 这个脚本把 `01-Memory.html`（原型定稿）的**每个界面状态**截成 PNG，
 * 供实现时**逐张对照**（`read_image` 能直接看），⛔ 不再靠"印象里长什么样"。
 *
 * 用法：node scripts/shoot-prototype.mjs [--out <目录>] [--proto <html>]
 * 依赖：本地 chromium（"Google Chrome for Testing"，playwright 起）+ 源码检出里的 playwright。
 *   ⛔ 不下载任何东西；找不到浏览器就**明确跳过**（不许静默成功）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const arg = (n, fb) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : fb }
const PROTO = path.resolve(arg('--proto', '/Users/admin/Documents/Obsidian Vault/03_项目/记忆插件UI沙箱/01-Memory.html'))
const OUT = path.resolve(arg('--out', path.join(import.meta.dirname, '..', '.screens', 'prototype')))
const PLAYWRIGHT = '/Users/admin/Desktop/Harness/dsh-src-0.1.7-rc.2/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs'
const CHROME = path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')

if (!fs.existsSync(PROTO)) { console.error(`❌ 找不到原型：${PROTO}`); process.exit(2) }
if (!fs.existsSync(PLAYWRIGHT)) { console.error(`❌ 找不到 playwright：${PLAYWRIGHT}`); process.exit(2) }
if (!fs.existsSync(CHROME)) {
  console.error(`⏭  本机没有 chromium（${CHROME}）——**明确跳过**，不假装成功`)
  process.exit(3)
}

const { chromium } = await import(PLAYWRIGHT)
fs.mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({ executablePath: CHROME })
const page = await browser.newPage({ viewport: { width: 1279, height: 819 }, deviceScaleFactor: 2 })
/**
 * 截图 + **验明正身**。
 * ⛔ 2026-10-10 踩过：脚本拍了一张叫「点节点(抽屉)」的图，**和上一张一模一样**——
 * 点球心没命中节点，抽屉根本没开，而文件名却在骗人（我据此"对着"看了一轮，白看）。
 * ⇒ 每次截图必须给一个 `expect`：画面上得真有那个东西；没有就以 `MISS-` 前缀存盘并报警。
 */
const shot = async (name, expect) => {
  let ok = true, why = ''
  if (expect) {
    ok = await page.evaluate((sel) => {
      const el = document.querySelector(sel)
      if (!el) return false
      const r = el.getBoundingClientRect()
      const st = getComputedStyle(el)
      return r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden'
    }, expect).catch(() => false)
    why = ok ? '' : `（画面上看不到 ${expect} —— 这个状态没拍到）`
  }
  const file = path.join(OUT, `${ok ? '' : 'MISS-'}${name}.png`)
  await page.screenshot({ path: file })
  console.log(`  ${ok ? '✅' : '⚠️ '} ${path.basename(file)} ${why}`)
  return ok
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

await page.goto(`file://${PROTO}`)
await wait(600)

/* ── ① 首屏（装完第一次打开 ⇒ 停在「认识一下」）──────────────────────── */
await shot('01-首次打开-认识一下开场')

// 向导：点「开始」进入十步，截前两步
try {
  await page.click('#start', { timeout: 1500 })
  await wait(1200)
  await shot('02-认识一下-第一步')
  await page.click('text=下一步', { timeout: 1000 }).catch(() => {})
  await wait(600)
  await shot('03-认识一下-第二步')
} catch { console.log('  ⏭  向导入口没找到，跳过（原型改过 id 就更新这里）') }

/* ── ② Agent 页（主界面）────────────────────────────────────────────── */
// 直接切到 agent 视图（原型的路由是内部状态；用它的入口或强制切）
await page.evaluate(() => {
  const v = document.querySelector('#ob-view')
  const a = document.querySelector('#agent-view')
  if (v && a) { v.style.display = 'none'; a.style.display = 'flex' }
})
await wait(1600)   // 等记忆球画出来（rAF 循环）
await shot('04-Agent页-默认')

// 点球上的一个节点 ⇒ 抽屉打开
const canvas = await page.$('#cv')
if (canvas) {
  const box = await canvas.boundingBox()
  if (box) {
    // 环形试探：球心附近按半径递增点若干处，直到抽屉真的开了（⛔ 不再假设"点中间就会中"）
    let hit = false
    for (const [dx, dy] of [[0, 0], [0, -0.18], [0.18, 0.05], [-0.2, 0.1], [0.05, 0.24], [-0.08, -0.26]]) {
      await page.mouse.click(box.x + box.width * (0.5 + dx), box.y + box.height * (0.5 + dy))
      await wait(450)
      hit = await page.evaluate(() => {
        const d = document.querySelector('#drawer')
        if (!d) return false
        const r = d.getBoundingClientRect()
        return r.width > 0 && r.x < window.innerWidth   // 打开时它会滑进视口
      }).catch(() => false)
      if (hit) break
    }
    await wait(400)
    await shot('05-Agent页-点节点(抽屉)', '#drawer')
  }
}

// 点列表第一行 ⇒ 抽屉 + 行内展开
try {
  await page.click('#list .item', { timeout: 1500 })
  await wait(700)
  await shot('06-Agent页-点列表行', '#drawer')
} catch { console.log('  ⏭  列表行为空或结构变了') }

// 抽屉的「编辑」态：**点行不开抽屉**（行是行内展开），抽屉要走行里的「编辑」按钮
try {
  await page.evaluate(() => {
    const btn = document.querySelector('#list .item .editbtn')
    if (btn) btn.click()
  })
  await wait(900)
  await shot('07-抽屉-打开', '#drawer')
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('#d-md-seg button'))
    const edit = btns.find((b) => (b.textContent || '').includes('编辑'))
    if (edit) edit.click()
  })
  await wait(500)
  await shot('07b-抽屉-正文编辑态', '#d-f-content')
} catch { console.log('  ⏭  抽屉没打开，跳过编辑态') }

// 筛选：切"长期"
try {
  await page.selectOption('#f-layer', { index: 1 })
  await wait(500)
  await shot('08-Agent页-筛选到长期层', '#list')
} catch { console.log('  ⏭  筛选器结构变了') }

console.log(`\n截图输出：${OUT}`)
await browser.close()
