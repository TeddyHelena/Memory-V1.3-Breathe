#!/usr/bin/env node
/**
 * 拍「唤醒」转场的**特效层**，并把 spec §五 第 1 点变成**像素判据**。
 *
 * ## 为什么要有它（这一段是账本）
 * 2026-10-14 之前，`flight` 只是 "轻微上浮 + 放大" 的 CSS 近似 ——
 * **四个 phase 全 `hasCanvas=false`**，飞行的本体根本不存在。
 * 补上画布以后，"画出来了"不能靠肉眼说，得能在**像素上**验：
 *   ① 画布真的画了东西（非空像素数 > 0，且**画布尺寸对了**）
 *   ② 飞行**末态的包围盒**必须 ≈ `settle` 起手的包围盒 ——
 *      否则就是 spec 第 1 点要防的"**飞行终点会跳**"
 *      （第一版实测就踩了：末帧只剩 12 px 的 4×4 点，而 settle 一来是 34px 大圆 ⇒ 跳）
 *
 * ## 退出码
 * 判据不过 ⇒ 非 0（可当门禁用）。⛔ 只读截图台，不碰生产。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PLAYWRIGHT = '/Users/admin/Desktop/Harness/dsh-src-0.1.7-rc.2/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs'
const CHROME = path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
const ROOT = path.resolve(import.meta.dirname, '..')
const PAGE = path.join(ROOT, 'sandbox.html')
const BUNDLE = path.join(ROOT, 'lib', 'sandbox.js')
const OUT = path.join(ROOT, '.screens', 'wake')

if (!fs.existsSync(BUNDLE)) {
  console.error('❌ 缺少 lib/sandbox.js —— 先跑 `npm run sandbox`（`npm run shoot` 已包含）')
  process.exit(2)
}
fs.mkdirSync(OUT, { recursive: true })
const { chromium } = await import(PLAYWRIGHT)
const browser = await chromium.launch({ executablePath: CHROME })
const page = await browser.newPage({ viewport: { width: 1279, height: 819 }, deviceScaleFactor: 1 })
const errs = []
page.on('pageerror', (e) => errs.push(String(e)))

/** 读画布像素：非空数 + 包围盒 */
const canvasStat = () => page.evaluate(() => {
  const c = document.querySelector('canvas[data-wake-canvas]')
  if (!c) return { found: false }
  const ctx = c.getContext('2d')
  const d = ctx.getImageData(0, 0, c.width, c.height).data
  let nonBlank = 0, minX = 1e9, maxX = -1, minY = 1e9, maxY = -1
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] > 8) {
      nonBlank++
      const px = (i / 4) % c.width, py = Math.floor(i / 4 / c.width)
      if (px < minX) minX = px
      if (px > maxX) maxX = px
      if (py < minY) minY = py
      if (py > maxY) maxY = py
    }
  }
  return { found: true, nonBlank, box: nonBlank ? [minX, minY, maxX, maxY] : null, w: c.width, h: c.height }
})

const shots = {}
const shoot = async (phase, delayMs) => {
  await page.goto(`file://${PAGE}?wake=${phase}`, { waitUntil: 'load' })
  await page.waitForFunction(() => !!document.querySelector('canvas[data-wake-canvas]'), { timeout: 8000 }).catch(() => {})
  await new Promise((r) => setTimeout(r, delayMs))
  const st = await canvasStat()
  const name = `${phase}-${String(delayMs).padStart(4, '0')}ms`
  await page.screenshot({ path: path.join(OUT, `${name}.png`) })
  shots[name] = st
  console.log(`  📷 ${name.padEnd(18)} 像素=${String(st.nonBlank ?? 0).padStart(7)}  包围盒=${st.box ? st.box.join(',') : '-'}`)
  return st
}

console.log('──「唤醒」特效层截图（含 spec §五 第 1 点的像素判据）──')
const handoff = await shoot('handoff', 400)
const mid = await shoot('flight', 150)
const end1 = await shoot('flight', 800)
const end2 = await shoot('flight', 1300)
const settle = await shoot('settle', 60)

const fails = []
const need = (cond, msg) => { if (!cond) fails.push(msg) }

// ① 画布必须存在并真的画了东西
need(handoff.found && handoff.nonBlank > 0, 'handoff 画布没画东西（画布没接住字形）')
need(mid.nonBlank > 300, `flight 中段粒子太少（${mid.nonBlank} px）——炸开没发生`)
// ② **终点不跳**：飞行末态包围盒 ≈ settle 起手包围盒
const boxDiff = (a, b) => (a && b ? Math.max(...a.map((v, i) => Math.abs(v - b[i]))) : Infinity)
const d = boxDiff(end2.box, settle.box)
need(d <= 5, `⛔ 飞行末态与 settle 起手的包围盒差 ${d}px（>5px ⇒ "飞行终点会跳"，spec §五 第 1 点）`)
console.log(`\n  飞行末态 vs settle 起手：包围盒最大差 ${d}px ⇒ ${d <= 5 ? '✅ 不跳' : '❌ 跳'}`)
// ③ 末态不该退化成一个点
const endSize = end2.box ? [end2.box[2] - end2.box[0], end2.box[3] - end2.box[1]] : [0, 0]
need(Math.min(...endSize) >= 12, `飞行末态退化成一个点（${endSize.join('×')}）——落点没铺满`)
console.log(`  飞行末态尺寸：${endSize.join('×')} ⇒ ${Math.min(...endSize) >= 12 ? '✅ 铺满落点' : '❌ 是个点'}`)
console.log(`  pageerror: ${errs.length ? errs.slice(0, 2).join(' | ') : '无'}`)
need(errs.length === 0, `页面报错：${errs.slice(0, 2).join(' | ')}`)

if (fails.length) {
  console.error('\n❌ 特效层判据不过：')
  for (const f of fails) console.error(`   · ${f}`)
  await browser.close()
  process.exit(1)
}
console.log(`\n✅ 特效层判据全过（截图在 .screens/wake/）`)
await browser.close()
