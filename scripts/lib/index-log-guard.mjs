/**
 * index-log-guard.mjs —— 「第二个写入者」的护栏（Audit · A-3 前置）
 *
 * ════════════════════════════════════════════════════════════════════
 * 为什么必须有
 * ════════════════════════════════════════════════════════════════════
 * Ledger（10-09）之后，盘上索引是**两件**：`index.json`（快照）+ `index.delta.jsonl`（增量日志）。
 * 插件运行时，写入先进日志、快照按（启动期 / 20% / 5 分钟）三选一折平。
 *
 * 于是任何**直接改 `index.json` 的脚本**都会撞上同一类事故：
 *   它改的是快照，而日志里还压着更新的投影 ⇒ 下次加载**重放日志会把它的改动盖回去**
 *   （反过来也一样：它写的快照会让日志的基线哈希对不上 ⇒ 日志整份作废）。
 * 这正是 09-14 / 09-15 那两次事故的形态：**两个写入者，各写各的**。
 *
 * 口径：**有待折平的日志就拒跑**（⛔ 不是"警告一下继续跑"——静默改错比不跑更糟）。
 * 放行办法（照发布清单写死的顺序）：停插件 → `node scripts/compact-index.mjs --root <容器>` → 再跑本工具。
 */
import fs from 'node:fs'
import path from 'node:path'

/** 返回日志里的待折平记录数（0 = 干净 / 无日志） */
export function pendingLogRecords(root) {
  const logPath = path.join(root, 'index.delta.jsonl')
  try {
    if (!fs.existsSync(logPath)) return 0
    return fs.readFileSync(logPath, 'utf-8').split('\n').filter((l) => l.trim()).length
  } catch {
    return 0          // 读不动就当没有：⛔ 别把工具卡死在无关的权限问题上
  }
}

/**
 * 有待折平日志就**拒跑**（退出码 2）。写类脚本在动手之前必须调它。
 * @param {string} root 容器根
 * @param {string} tool 脚本名（打印用）
 */
export function assertIndexLogCompacted(root, tool = '本脚本') {
  const n = pendingLogRecords(root)
  if (n === 0) return
  console.error(`❌ ${tool} 被拒绝：容器有 ${n} 条待折平的增量日志`)
  console.error(`   日志：${path.join(root, 'index.delta.jsonl')}`)
  console.error('   原因：直接改 index.json 会与日志打架 —— 下次加载重放日志会把改动盖回去（或让日志整份作废）。')
  console.error('   放行办法：停插件 → node scripts/compact-index.mjs --root <容器> → 再跑本脚本。')
  process.exit(2)
}
