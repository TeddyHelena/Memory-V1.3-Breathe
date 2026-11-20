#!/usr/bin/env node
/**
 * 【审美术对照表】把「唤醒」特效层的**审美参数**摆出来给人挑。
 *
 * 为什么要有它：`spread`（炸开多大）/ 粒子数这类**只能看**——
 *   "0.18 像一坨疙瘩、0.32 好一点"这种话，说了不如摆一张图。
 * 做法：`?wake=flight&spread=…&particles=…` 在同一时刻（默认 150ms，炸开中段）各拍一张，
 *   并打印像素统计（非空像素 / 包围盒）当**可核对的数**。
 * ⛔ 只读开发页，不碰生产；调参口缺省 = 常量 ⇒ 生产行为一字不变。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PLAYWRIGHT = '/Users/admin/Desktop/Harness/dsh-src-0.1.7-rc.2/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs'
const CHROME = path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
const ROOT = path.resolve(import.meta.dirname, '..')
const PAGE = path.join(ROOT, 'sandbox.html')
const OUT = process.argv[2] ?? path.join(ROOT, '.screens', 'wake-variants')
if (!fs.existsSync(path.join(ROOT, 'lib', 'sandbox.js'))) {
  console.error('❌ 缺少 lib/sandbox.js —— 先跑 `npm run sandbox`')
  process.exit(2)
}
fs.mkdirSync(OUT, { recursive: true })
const { chromium } = await import(PLAYWRIGHT)
const browser = await chromium.launch({ executablePath: CHROME })

/** 每一行 = 一组审美参数（可自行加行） */
const VARIANTS = [
  { spread: 0.18, particles: 170, note: '紧凑：像一坨密集的疙瘩' },
  { spread: 0.32, particles: 170, note: '当前值（我猜的）' },
  { spread: 0.5, particles: 170, note: '张得开' },
  { spread: 0.75, particles: 260, note: '很炸 + 更密' },
]

console.log('── 唤醒特效层：审美参数对照表（都在 flight 中段 150ms 拍）──')
const rows = []
for (const v of VARIANTS) {
  const page = await browser.newPage({ viewport: { width: 1279, height: 819 }, deviceScaleFactor: 1 })
  const errs = []
  page.on('pageerror', (e) => errs.push(String(e)))
  await page.goto(`file://${PAGE}?wake=flight&spread=${v.spread}&particles=${v.particles}`, { waitUntil: 'load' })
  await page.waitForFunction(() => !!document.querySelector('canvas[data-wake-canvas]'), { timeout: 8000 }).catch(() => {})
  await new Promise((r) => setTimeout(r, 150))
  const st = await page.evaluate(() => {
    const c = document.querySelector('canvas[data-wake-canvas]')
    if (!c) return { found: false }
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
    let n = 0, minX = 1e9, maxX = -1, minY = 1e9, maxY = -1
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 8) {
        n++
        const px = (i / 4) % c.width, py = Math.floor(i / 4 / c.width)
        if (px < minX) minX = px
        if (px > maxX) maxX = px
        if (py < minY) minY = py
        if (py > maxY) maxY = py
      }
    }
    return { found: true, n, w: maxX - minX, h: maxY - minY, box: [minX, minY, maxX, maxY] }
  })
  const name = `spread-${String(v.spread).replace('.', '_')}-particles-${v.particles}.png`
  await page.screenshot({ path: path.join(OUT, name) })
  rows.push({ ...v, ...st, name, err: errs.length })
  console.log(`  spread=${String(v.spread).padEnd(4)} × ${String(v.particles).padStart(3)} 粒  ⇒ 像素 ${String(st.n).padStart(6)} ｜ 铺开 ${st.w}×${st.h}  ｜ ${v.note}`)
  await page.close()
}
fs.writeFileSync(path.join(OUT, 'variants.json'), JSON.stringify(rows, null, 1))
console.log(`\n  图在 ${OUT}`)
await browser.close()
