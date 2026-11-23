#!/usr/bin/env node
/**
 * 【2026-11-22】构建清单：把「这次构建应该产出哪些运行期模块」写进 lib/build-manifest.json。
 *
 * 为什么需要它：`build-identity` 靠**动态遍历** lib 才能不漏模块（修前手写 18 文件清单
 * 漏掉 api/lock/decay-sweep/subjects/idem 等 28 个模块 ⇒ stale 恒 false）。
 * 但动态遍历有个代价：某模块**构建失败/丢失**时，它只是"不在盘上"，不会被发现。
 * 所以：构建时记一份"应有清单"，运行期拿它做 **missing 检测**，再与盘上实际文件取并集。
 */
import fs from 'node:fs'
import path from 'node:path'

const LIB = path.resolve(import.meta.dirname, '..', 'lib')
const EXCLUDE = new Set(['client.js', 'sandbox.js'])   // 浏览器侧 bundle，不被进程加载

const files = []
const walk = (dir, prefix) => {
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name)
    const rel = prefix ? `${prefix}/${name}` : name
    const st = fs.statSync(full)
    if (st.isDirectory()) { walk(full, rel); continue }
    if (!name.endsWith('.js')) continue
    if (EXCLUDE.has(rel)) continue
    files.push(rel)
  }
}
walk(LIB, '')
files.sort()
fs.writeFileSync(path.join(LIB, 'build-manifest.json'), JSON.stringify({ version: 1, files }, null, 2) + '\n', 'utf-8')
console.log(`build-manifest: ${files.length} 个运行期模块`)
