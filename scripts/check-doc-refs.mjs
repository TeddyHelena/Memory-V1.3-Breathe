#!/usr/bin/env node
/**
 * **文档自指检查**：⛔ 不许有落空的指向。
 *
 * ## 为什么要有它
 * MemoryV1.3-Lite 的外审里，**头号病叫"账面自指"**：
 * 一张专门用来"防止整套诊断在换题时丢失"的映射表，**自己指错了两处地方**——
 * §八 写着「⇒ 列 §五」，而 §五 里根本没有那一行。
 * 人的同类错误：**"查完了"不等于"结项了"，账必须回填**。
 * ⇒ 机械守：**每个 `§X` / `0.N` 引用，必须在同一份文档里真的有落点。**
 *
 * ## 用法
 *   node scripts/check-doc-refs.mjs <文件.md> [更多.md ...]
 *   node scripts/check-doc-refs.mjs --glob 'docs/*.md'
 * 退出码：有落空引用 ⇒ 1
 */
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
let files = []
if (args[0] === '--glob') {
  const dir = path.dirname(args[1]); const pat = path.basename(args[1])
  files = fs.readdirSync(dir).filter((f) => new RegExp('^' + pat.replace('*', '.*') + '$').test(f)).map((f) => path.join(dir, f))
} else files = args
if (!files.length) { console.error('用法：node scripts/check-doc-refs.mjs <文件.md> … | --glob "docs/*.md"'); process.exit(2) }

const CN = '〇一二三四五六七八九十'
// ⭐【RMM-e / RQW-e】**跨文档份数一致**：施工稿声称的份数必须 == 名册文件的实际行数。
//   为什么：治计数漂移的"份数 = 表行数"刚立起来，就漂在了两份文档之间（台账 14 / 施工稿 11）。
//   ⇒ MiniMax 的规律：**"每次把 X 收归单一来源，都会留下一个复述 X 的地方，而复述不计入来源数。"**
//   ⇒ 唯一有效的不是再收一次，而是**让复述本身能红**。
const rosterCounts = []
const allText = files.map((f) => fs.readFileSync(f, 'utf-8'))
for (const t of allText) {
  const n = [...t.matchAll(/^\| *(R[A-Z]{2}-[a-z]) *\|/gm)].length
  if (n) rosterCounts.push(n)
}
const ROSTER = rosterCounts.length ? Math.max(...rosterCounts) : 0
let bad = 0
for (const f of files) {
  // ⚠️ **引用块（`>`）不算本文档的引用主张**：里面常引外审原文，那些 `§X` 指的是**别的文档**。
  //    第一版没跳 ⇒ 把三处引用误报成落空（工具自己的错）。
  const raw = fs.readFileSync(f, 'utf-8')
  const rawLines = raw.split('\n')
  // ⚠️ **反引号内的内容也要豁免**（2026-10-15）：把"坏形状"当示例写进文档时，
  //    门禁会把**引用**当成**真形状**（实测：我写演习记录，自己被自己的门禁抓住）。
  //    ⇒ 与引用块同理：**引用坏形状的地方不该被查**。
  const stripInlineCode = (t) => t.replace(/`[^`]*`/g, ' `·` ')
  // ⚠️ 行号要报**原文件**的：先前报的是"过滤掉引用块之后"的行号 ⇒ 对不上文件（实测误导过一次）
  const lineNo = (filteredIdx) => {
    let seen = -1
    for (let k = 0; k < rawLines.length; k++) {
      if (/^\s*>/.test(rawLines[k])) continue
      seen++
      if (seen === filteredIdx) return k + 1
    }
    return filteredIdx + 1
  }
  const s = stripInlineCode(raw.split('\n').filter((l) => !/^\s*>/.test(l)).join('\n'))
  // 真实存在的锚点
  // ⚠️ 标题里的 `§` 是**可选的**：本仓 v2/v3 的标题写「一 · 目标」而引用写「§一」——
  //    第一版要求标题必须带 `§` ⇒ 把这两份**误报**成 10 处落空（工具自己的错，不是文档的）
  const heads = new Set([...s.matchAll(new RegExp(`^#+ *§?([${CN}]+)`, 'gm'))].map((m) => '§' + m[1]))
  // ⚠️ 两类小节标题都算数：`§8.1` 与 `### 8.1`（本仓两种写法都有 —— 只认前者会把后者误报）
  const subs = new Set([
    ...[...s.matchAll(/^#+ *(§[\d.]+)/gm)].map((m) => m[1]),
    ...[...s.matchAll(/^#+ *(\d+\.\d+)/gm)].map((m) => '§' + m[1]),
  ])
  const rows = new Set([...s.matchAll(/^\| \*\*(0\.\d+)\*\*/gm)].map((m) => m[1]))
  const hasL0 = /^#+ *§三/m.test(s)          // 有 §三 才算"L0 行号"这种引用合法

  const dangling = []
  for (const m of s.matchAll(new RegExp(`§([${CN}]+)`, 'g'))) {
    if (!heads.has('§' + m[1])) dangling.push('§' + m[1])
  }
  for (const m of s.matchAll(/§(\d+(?:\.\d+)?)/g)) {
    const t = '§' + m[1]
    if (!subs.has(t) && !heads.has(t) && !heads.has('§' + m[1].split('.')[0])) dangling.push(t)
  }
  if (hasL0) {
    for (const m of s.matchAll(/(?<![\d.])(0\.\d+)(?![\d])/g)) {
      if (!rows.has(m[1])) dangling.push(m[1] + '（L0 行）')
    }
  }
  // ── 【2026-10-15 第 12 次外审】补三项本职 ──
  //   ⚠️ 第一版三项**全写错了对象**：文档的子节标题是 `### 2.3`（阿拉伯数字），
  //      我却按中文数字去匹配 ⇒ 一条都没抓到（"该抓没抓"的真原因）。
  //   ⇒ 现在按**文档真实形状**查：`### N.M` 归属于它上面最近的 `## §X`。
  const lines = s.split('\n')
  const subByMain = {}          // §中文 → [M, ...]（按文档顺序）
  let curMain = null
  const headAt = []
  for (let i = 0; i < lines.length; i++) {
    const h2 = /^## +§?([〇一二三四五六七八九十]+)/.exec(lines[i])
    if (h2) { curMain = h2[1]; continue }
    const h3 = /^#{3,6} *(\d+)\.(\d+)/.exec(lines[i])
    if (h3 && curMain) { (subByMain[curMain] ??= []).push(Number(h3[2])); headAt.push(i) }
  }
  // ② 同一主节内子节号必须**单调递增**（实测抓到 7.1→7.0→7.2→7.4→7.3、2.1→2.3→2.4→2.2）
  for (const [main, nums] of Object.entries(subByMain)) {
    for (let i = 1; i < nums.length; i++) {
      if (nums[i] < nums[i - 1]) dangling.push(`§${main} 子节号倒序（${nums[i - 1]} → ${nums[i]}）`)
    }
  }
  // ① `§X M.N` 引用的小节号必须真的存在
  for (const m of s.matchAll(new RegExp(`§([${CN}]+)\\s*(\\d+)\\.(\\d+)`, 'g'))) {
    if (m[2] === '0') continue        // ⚠️ `§三 0.12` 指的是 **L0 表行**（单独校验），⛔ 不是小节号（误报过一次）
    const want = Number(m[3])
    const have = subByMain[m[1]] ?? []
    if (have.length && !have.includes(want)) dangling.push(`§${m[1]} 的 .${want} 小节不存在（现有 ${have.join('/')}）`)
  }
  // ③ 表格不许被小标题**劈成两半**：标题的上一行与下一行**都是表行**
  for (const i of headAt) {
    const prev = lines[i - 1] ?? ''; const next = lines[i + 1] ?? ''
    if (/^\|/.test(prev.trim()) && /^\|/.test(next.trim())) dangling.push(`表格被小标题劈成两半（第 ${lineNo(i)} 行「${lines[i].trim().slice(0, 24)}」）`)
  }
  // ── 【2026-10-15 RGL-c】稳定 ID 制：⛔ "第 N 份" 是指向可变列表的指针（列表一动就漂）──
  //   ✅ 引用一律 `R⟨审稿人⟩⟨轮次⟩`；② 该 ID 必须在**同一文档的 ID 名册里存在**；
  //   ③ ⛔ 裸的「第 N 份 + 审稿人名」一律红（要么改 ID，要么别写号）。
  const roster = new Set([...s.matchAll(/\| *(R[A-Z]{2}-[abc]) *\|/g)].map((m) => m[1]))
  for (const m of s.matchAll(/\b(R[A-Z]{2}-[abc])\b/g)) {
    if (roster.size && !roster.has(m[1])) dangling.push(`${m[1]}（ID 不在本册名册里）`)
  }
  // ④ **ID 是稳定锚，序号只是装饰 —— 装饰不许与锚矛盾**（2026-10-15 修）
  //    ⚠️ 第一版把不变量写错了：**"没写标签"不算错，"标签与 ID 矛盾"才算错**（误报 3 处）。
  //    实测抓到的真错是 `RGL-c` 被标成「GLM（二）」。
  const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5 }
  for (const m of s.matchAll(/\| *(R[A-Z]{2})-([abc]) *\|[^|]*\| *\*\*([^*]+)\*\*/g)) {
    const want = { a: 1, b: 2, c: 3 }[m[2]]
    const label = m[3]
    let got = CN_NUM[/（(一|二|三|四|五)）/.exec(label)?.[1]]
    if (got === undefined) {
      const g = /第([一二三四五])份/.exec(label)          // 也认「（第二份）」这种写法
      got = g ? CN_NUM[g[1]] : undefined
    }
    if (got !== undefined && got !== want) dangling.push(`${m[1]}-${m[2]} 的轮次标签是「${label}」⇒ 与 ID 矛盾（应为第 ${want} 轮）`)
  }
  for (const m of s.matchAll(/第 ?[0-9一二三四五六七八九十]+ ?份 ?(Qwen|MiniMax|GLM|DeepSeek)/g)) {
    dangling.push(`裸序数引用「${m[0]}」⇒ 改稳定 ID（序号会漂）`)
  }
  // ⑤ **孤儿表行**（RMM-d 抓到的真形态）：表格被**空行**截断后，后面的 `|` 行没有表头。
  //    ⚠️ 第一版写错了判据：我"跳过空行往上找，只要上一个是表行就算连着"——
  //      **而 GFM 里空行本身就断表** ⇒ 判据必须**要求紧邻**（上一行不是空行），实测因此漏报。
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i]
    if (!/^\s*\|/.test(cur)) continue
    if (/^\s*\|[-: |]+\|\s*$/.test(cur)) continue               // 分隔行
    const nextIsSep = /^\s*\|[-: |]+\|\s*$/.test(lines[i + 1] ?? '')
    if (nextIsSep) continue                                        // 表头（表头后面必跟分隔行）
    const prevLine = lines[i - 1] ?? ''
    const prevIsTable = /^\s*\|/.test(prevLine)
    if (!prevIsTable && cur.trim().startsWith('|')) {
      dangling.push(`孤儿表行（第 ${lineNo(i)} 行「${cur.trim().slice(0, 28)}…」上一行不是表行 ⇒ 空行断表）`)
    }
  }
  // ⑥ **份数复述必须 == 名册行数**（跨文档，2026-10-15 加）
  if (ROSTER > 0) {
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i]
      if (/当时口径|\b史\b|~~/.test(ln)) continue                 // 历史口径豁免（须显式标注）
      // ⚠️ 只认**计数主张**，⛔ 不认 `第 N 份`（那是序数引用）——
      //    第一版用裸 `(\d+)\s*份` ⇒ **误报 22 处**，全是"第 5 份""第 7 份"这类。
      for (const m of ln.matchAll(/(?:份数\s*=\s*|有效\s*|共\s*|合计\s*)(\d+)\s*份|(\d+)\s*份(?:审稿|有效)/g)) {
        const n = Number(m[1] ?? m[2])
        if (Number.isFinite(n) && n !== ROSTER && n >= 5) dangling.push(`份数主张 ${n} 份 ≠ 名册行数 ${ROSTER}（第 ${lineNo(i)} 行）`)
      }
    }
  }
  // ⑦ **同一张表内列数必须一致**（今天撞见第三次 ⇒ 该成规则）
  {
    let block = [], startIdx = 0
    const flush = () => {
      if (block.length >= 2) {
        const cols = block.map((b) => b.line.split('|').length - 2)
        if (new Set(cols).size > 1) dangling.push(`表格列数不一致（第 ${lineNo(startIdx)} 行起：${[...new Set(cols)].join(' vs ')} 列）`)
      }
      block = []
    }
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*\|/.test(lines[i])) { if (!block.length) startIdx = i; block.push({ line: lines[i], i }) }
      else flush()
    }
    flush()
  }
  // ⑧ **叠 ID**（RGL-e：批量替换正则不看上下文 ⇒ "RQW-c（RQW-c）"）：同一 ID 在括号内重复
  for (const m of s.matchAll(/(R[A-Z]{2}-[a-z])[（(]\1[）)]/g)) {
    dangling.push(`叠 ID「${m[0]}」（第 ${lineNo(s.split('\n').findIndex((x) => x.includes(m[0])))} 行）—— 批量替换撞上下文的产物`)
  }
  // ⑨ **字面份数禁写**（RGL-e：散文计数是结构性必死的）——
  //    ⛔ 除"份数 = 表行数"这类**派生句**外，散文里不得出现字面份数（写"见台账 §一 表行数"）
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]
    if (/份数\s*=|表行数|当时口径|\b史\b|~~/.test(ln)) continue   // 派生句 / 历史口径豁免
    // ⚠️ 同时认**阿拉伯数字与中文数字**（第一版只认阿拉伯 ⇒ 漏掉"十四份"）
    const CN2N = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12, 十三: 13, 十四: 14, 十五: 15, 十六: 16 }
    for (const m of ln.matchAll(/(?:有效|共|合计|收)\s*(?:\*\*)?([\d一二三四五六七八九十]+)(?:\*\*)?\s*份/g)) {
      const raw = m[1]
      const n = /^\d+$/.test(raw) ? Number(raw) : CN2N[raw]
      if (Number.isFinite(n) && n !== ROSTER && ROSTER > 0) dangling.push(`散文手写份数「${m[0]}」≠ 名册行数 ${ROSTER}（第 ${lineNo(i)} 行）⛔ 应写"见台账 §一 表行数"`)
    }
  }
  // ⑩ **"逐条已落"必须联动状态**（RGL-e：散文断言无门禁）——
  //    §十二 若出现"逐条已落/全部落地"，须同时给出可查的状态指向（如 ✅/⏳ 落点行）
  const claims = [...s.matchAll(/逐条已落|全部落地|逐条已吸收/g)]
  if (claims.length && !/\|.*\|.*\|.*✅|落点见/.test(s.slice(s.indexOf('§十二') > -1 ? s.indexOf('§十二') : 0))) {
    dangling.push(`「${claims[0][0]}」是无门禁的散文断言 —— 必须逐步链接到状态行（RGL-e）`)
  }
  const uniq = [...new Set(dangling)]
  const name = path.basename(f)
  if (uniq.length) { console.log(`  ❌ ${name}：落空引用 ${uniq.join(' / ')}`); bad += uniq.length }
  else console.log(`  ✅ ${name}：零落空指向（节 ${heads.size} ｜ L0 行 ${rows.size}）`)
}
if (bad) { console.error(`\n⛔ 有 ${bad} 处落空引用 —— 指向必须落地（"账面自指"就是这么来的）`); process.exit(1) }
console.log('\n✅ 全部文档：零落空指向')
