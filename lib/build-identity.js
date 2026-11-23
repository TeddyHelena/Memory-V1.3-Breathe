import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
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
 * 运行期真正会被加载的那批产物：**`lib/` 下全部 `.js`（递归、按路径排序）**。
 *
 * 【2026-11-22 修正 · 血的事实】修前这里是一张**手写的 18 文件清单**，
 * 而 `lib/` 实际有 **57** 个 `.js` —— `api.js` / `lock.js` / `decay-sweep.js` /
 * `subjects.js` / `idem.js` / `chain-render.js` 全在清单外。
 * 后果：改这些文件、重新构建，`diskHash` **一点不动** ⇒ `stale` 永远 `false` ⇒
 * 系统拍胸脯说"盘上与进程内是同一份"，其实它根本没看那些文件。
 * 实测：当天修 `idem.ts`（搬层不改 updated）后哈希仍是 `5fd4298d`，只能靠手工 grep 才敢确认。
 *
 * ⛔ 原注释写"不许改成动态遍历"，理由是"顺序必须固定才能比较"——
 *    这个理由对**无序 readdir** 成立，对**排序后的路径列表**不成立。
 *    现在：递归收集 + `sort()`，两个进程在同一棵树上必然得到同一个顺序。
 * ⛔ 唯一的排除项是**浏览器侧 bundle**（不参与进程加载，不存在"进程内陈旧"）。
 */
const BROWSER_ONLY = new Set(['client.js', 'sandbox.js']);
const MANIFEST = 'build-manifest.json';
/** 构建清单里"应该有"的模块（缺失/损坏 ⇒ 返回空，退化成只看盘上实际文件） */
function manifestFiles(libDir) {
    try {
        const j = JSON.parse(fs.readFileSync(path.join(libDir, MANIFEST), 'utf-8'));
        return Array.isArray(j.files) ? j.files.filter((f) => typeof f === 'string') : [];
    }
    catch {
        return [];
    }
}
/** 盘上实际的运行期产物（递归 + 排序；纯读） */
function presentFiles(libDir) {
    const out = [];
    const walk = (dir, prefix) => {
        let names;
        try {
            names = fs.readdirSync(dir);
        }
        catch {
            return;
        }
        for (const name of names.sort()) {
            const rel = prefix ? `${prefix}/${name}` : name;
            const full = path.join(dir, name);
            let st;
            try {
                st = fs.statSync(full);
            }
            catch {
                continue;
            }
            if (st.isDirectory()) {
                walk(full, rel);
                continue;
            }
            if (!name.endsWith('.js'))
                continue;
            if (BROWSER_ONLY.has(rel))
                continue;
            out.push(rel);
        }
    };
    walk(libDir, '');
    return out.sort();
}
/**
 * 参与哈希的模块 = **清单应有** ∪ **盘上实际**（排序后）。
 *   · 并集而不是二选一：新增文件要能影响哈希（否则"多出一个模块"永远判不出 stale）；
 *   · 清单里有、盘上没有 ⇒ 进 `missing`（构建失败/产物丢失要如实暴露，不许静默）。
 */
function runtimeBuildFiles(libDir) {
    const expected = manifestFiles(libDir);
    const present = presentFiles(libDir);
    const presentSet = new Set(present);
    const missing = expected.filter((f) => !presentSet.has(f)).sort();
    const files = [...new Set([...expected, ...present])].sort();
    return { files, missing };
}
/** 给一个 lib 目录算构建哈希。纯读，无副作用。**不导出**：唯一调用方是本模块与真身验收。 */
function computeBuildHash(libDir) {
    const h = crypto.createHash('sha256');
    const { files: list, missing: missingFromManifest } = runtimeBuildFiles(libDir);
    const missing = [...missingFromManifest];
    let files = 0;
    for (const rel of list) {
        if (missingFromManifest.includes(rel))
            continue;
        try {
            const buf = fs.readFileSync(path.join(libDir, rel));
            // 文件名 + 长度 + 内容都要进哈希：只哈希内容的话，两个产物互换文件名会撞哈希
            h.update(rel).update(String(buf.length)).update(buf);
            files += 1;
        }
        catch {
            missing.push(rel);
        }
    }
    return { hash: h.digest('hex').slice(0, 16), files, missing };
}
/**
 * 生成一次构建身份快照。
 * @param libDir 插件产物目录（运行时传 `import.meta.dirname`）
 * @param loaded 启动时捕获的那份（见 `captureBuild`）
 */
export function buildIdentity(libDir, loaded) {
    const now = computeBuildHash(libDir);
    return {
        ...now,
        loadedAt: loaded.at,
        loadedHash: loaded.hash,
        diskHash: now.hash,
        stale: now.hash !== loaded.hash,
    };
}
/** 启动时捕获一次（进程生命周期内不再变）。 */
export function captureBuild(libDir) {
    const b = computeBuildHash(libDir);
    return { ...b, at: new Date().toISOString() };
}
