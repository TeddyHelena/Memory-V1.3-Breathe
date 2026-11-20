import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 构建身份 —— **D0 · 部署状态物化**（2026-10-09）
 *
 * 要解决的问题：**"现在跑的是哪一版"以前只能靠人记**。
 *   · 插件目录是**软链**，`lib/` 就是生产加载路径 ⇒ 改了盘上的代码、**不重启等于没改**；
 *   · `/selftest` 的 `product` 块是**硬编码的字面量** —— 它说的是"这版代码**自称**是谁"，
 *     不是"**盘上现在是哪一版**"，更不是"进程里加载的是哪一版"；
 *   · 实测踩过：跑验收前我改了 `lib/`，而运行中的进程仍是旧构建，
 *     唯一能发现的办法是**去比 productVersion 字符串**（还得人记得去比）。
 *
 * 做法（一句话）：**启动时给"运行期会加载的那批产物"算一个内容哈希**；
 * `/selftest` 每次再算一遍盘上的。两者不一致 ⇒ 盘上已经换了、进程里还是旧的 ⇒ **必须重启**。
 *
 * ⛔ 边界（如实写）：
 *   · 它证明的是"**盘上与进程内是否同一个构建**"，**不**证明"这个构建是不是 tag 那一版"——
 *     后者要 git，运行期不做（也不该做）；
 *   · `lib/client.js`（浏览器侧 bundle）**刻意不在清单里**：它由页面每次加载时读盘，
 *     不存在"进程内陈旧"这一说；它的刷新条件是页面刷新，不是重启。
 */

/**
 * 运行期真正会被加载的那批产物。**顺序固定** ⇒ 哈希可比（⛔ 不许改成动态遍历）。
 *
 * ⚠️ **不导出**：它只服务本模块。测试要验它，就**拿真实 `lib/` 当夹具** ——
 *    抄一份清单到测试里必然分叉（实测：抄的那份写着 `ingestion.js`，真名是 `ingest.js`，
 *    于是模块漏哈希而单测全绿）。
 */
const BUILD_FILES = [
  'index.js',
  'container.js',
  'writer.js',
  'persona.js',
  'policy.js',
  'search.js',
  'ingest.js',
  'injection.js',
  'injection-ledger.js',
  'hot-invalidation.js',
  'build-identity.js',
  'checksum.js',
  'contract/fields.js',
  'route/router.js',
  'route/recall.js',
  'route/score.js',
  'route/budget.js',
  'route/gate.js',
] as const

export interface BuildHash {
  /** 内容哈希前 16 位（sha256） */
  hash: string
  /** 参与哈希且存在的文件数 */
  files: number
  /** 清单里**找不到**的文件（如实列出，⛔ 不许静默跳过） */
  missing: string[]
}

/** 给一个 lib 目录算构建哈希。纯读，无副作用。**不导出**：唯一调用方是本模块与真身验收。 */
function computeBuildHash(libDir: string): BuildHash {
  const h = crypto.createHash('sha256')
  const missing: string[] = []
  let files = 0
  for (const rel of BUILD_FILES) {
    try {
      const buf = fs.readFileSync(path.join(libDir, rel))
      // 文件名 + 长度 + 内容都要进哈希：只哈希内容的话，两个产物互换文件名会撞哈希
      h.update(rel).update(String(buf.length)).update(buf)
      files += 1
    } catch {
      missing.push(rel)
    }
  }
  return { hash: h.digest('hex').slice(0, 16), files, missing }
}

export interface BuildIdentity extends BuildHash {
  /** 启动（插件装载）时刻 */
  loadedAt: string
  /** 启动时那一刻的哈希 */
  loadedHash: string
  /** 刚刚现算的盘上哈希 */
  diskHash: string
  /** **盘上 ≠ 进程内** ⇒ 改了代码没重启（这时"改了等于没改"） */
  stale: boolean
}

/**
 * 生成一次构建身份快照。
 * @param libDir 插件产物目录（运行时传 `import.meta.dirname`）
 * @param loaded 启动时捕获的那份（见 `captureBuild`）
 */
export function buildIdentity(libDir: string, loaded: { hash: string; at: string }): BuildIdentity {
  const now = computeBuildHash(libDir)
  return {
    ...now,
    loadedAt: loaded.at,
    loadedHash: loaded.hash,
    diskHash: now.hash,
    stale: now.hash !== loaded.hash,
  }
}

/** 启动时捕获一次（进程生命周期内不再变）。 */
export function captureBuild(libDir: string): { hash: string; at: string; files: number; missing: string[] } {
  const b = computeBuildHash(libDir)
  return { ...b, at: new Date().toISOString() }
}
