#!/usr/bin/env node
/**
 * 【2026-11-22】清 lib/ 时必须保住**客户端半身**。
 *
 * 事故：`npm run clean` 原本是 `rm -rf lib`，而 `lib/client.js`（注册侧边栏「记忆」入口 +
 * 主面板 iframe 的那份 bundle）**不在任何构建步骤的产物里** —— 它是单独打包、手工放进去的。
 * 2026-11-22 当天跑了七八次 build，把它删了，`git add -A` 又把删除一起提交（e3a212a），
 * 结果侧边栏的「记忆」入口整个消失。恢复靠 `git checkout 4059cf0 -- lib/client.js`。
 *
 * ⛔ 以后清 lib 一律走这里：只删构建产物，客户端 bundle 原样保留。
 */
import fs from 'node:fs'
import path from 'node:path'

const LIB = path.resolve(import.meta.dirname, '..', 'lib')
// 单独打包、构建链不产出、删了不会自己长回来的东西
const KEEP = new Set(['client.js', 'client.js.map'])

if (!fs.existsSync(LIB)) { console.log('clean: lib/ 不存在，跳过'); process.exit(0) }
let removed = 0, kept = 0
for (const name of fs.readdirSync(LIB)) {
  if (KEEP.has(name)) { kept++; continue }
  fs.rmSync(path.join(LIB, name), { recursive: true, force: true })
  removed++
}
console.log(`clean: 删 ${removed} 项，保留客户端 bundle ${kept} 项`)
