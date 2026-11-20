import fs from 'node:fs';
/**
 * hot 段的**非写入型失效触发**（D2 · 原 E6「缓存失效旁路」，2026-10-09）
 *
 * 要解决的两件事，都不是我们自己的写入造成的：
 *   ① **时间到了**：某条常驻记忆带 `valid_to`/`expires`，到点就该从系统提示词里消失 ——
 *      而**没有任何写入发生**。此前只能等"下一次别的写入"顺带置脏，
 *      意味着一条过期记忆可能**继续被注入几小时到几天**（真身实测：a36 过期 14 天仍 active）。
 *   ② **盘被外部改了**：`index.json` 被脚本/别的进程重写（真身**发生过 11 次**），
 *      而进程内毫无察觉 —— 直到下次重启。
 *
 * 成本纪律（C1/C6）：每次装配**只允许**付一次 `statSync` + 若干次整数比较 ——
 *   ⛔ 不许每次装配重算全量边界、⛔ 不许每次装配读文件内容。
 *   所以边界是**编译时算一次、缓存住**，装配时只比大小。
 */
/** 取一个条目上的"到期时刻"（`valid_to ?? expires`，日期粒度按当天 23:59:59.999 处理）。 */
function expiryOf(entry) {
    // 已废弃/已失效的状态由 temporalState 管，这里只管**时间边界**
    if (entry.status === 'expired' || entry.status === 'superseded' || entry.superseded_by)
        return null;
    const value = entry.valid_to ?? entry.expires;
    if (!value)
        return null;
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed))
        return null;
    // 与 policy.parseTime 的日期粒度口径一致：`YYYY-MM-DD` 表示**当天结束**
    return /^\d{4}-\d{2}-\d{2}$/.test(value) ? parsed + 24 * 60 * 60 * 1000 - 1 : parsed;
}
/**
 * 算出"下一个会改变 hot 段内容的时刻"。
 * @returns 毫秒时间戳；null = 没有任何未来边界（此时这个触发永不生效）
 */
export function computeNextBoundary(entries, nowMs) {
    let next = null;
    for (const e of entries) {
        const t = expiryOf(e);
        if (t === null || t <= nowMs)
            continue;
        if (next === null || t < next)
            next = t;
    }
    return next;
}
/** 边界已过？（`null` = 没有边界 ⇒ 永远 false） */
export function boundaryPassed(nextBoundary, nowMs) {
    return nextBoundary !== null && nowMs >= nextBoundary;
}
/**
 * 索引文件修订探针：用 `(mtimeMs, size)` 判断"盘上这份是不是我们上次看到的那份"。
 * 成本：每次调用一次 `statSync`（常数级，满足 C1/C6）。
 *
 * ⚠️ 已知盲区（如实写下）：`(mtimeMs, size)` 抓不住"同一毫秒内、同字节数"的改写。
 *    这是**已知并接受**的边界 —— 更严的做法要内容哈希（每次装配付不起）。
 */
export function makeRevisionProbe(indexPath, extraPaths = []) {
    /**
     * 【2026-10-14 修 · 一个**既有**的盲区，不是这次改动引入的】
     *
     * 修前只盯 `indexPath` 一个文件 —— 但**写入不一定落在它上面**：
     * 实测（临时容器，relocate 一条）`index.json` 的 `(mtime,size)` **纹丝不动**，
     * 改动进的是**增量日志** `index.delta.jsonl`（按设计"待折平"）。
     * ⇒ 本仓那条纪律「**盘上变了先重载再答**」（`/list` `/graph` `/decay-state` 都靠它）
     *    对**所有走增量路径的写**静默失效：`ensureFresh()` 永远返回 false，
     *    读路径一直拿**旧索引**应答，而且**没有任何报错**。
     *
     * ⇒ 改成盯**一组**文件：调用方把增量日志一并传进来（见 `api.ts` 的 `revision` 构造）。
     *
     * ⚠️ 已知盲区（如实写下，保留）：`(mtimeMs, size)` 抓不住"同一毫秒内、同字节数"的改写。
     *    这是**已知并接受**的边界 —— 更严的做法要内容哈希（每次装配付不起）。
     */
    const paths = [indexPath, ...extraPaths];
    const readAll = () => {
        let mtimeMs = 0;
        let size = 0;
        let any = false;
        for (const f of paths) {
            try {
                const st = fs.statSync(f);
                any = true;
                mtimeMs = Math.max(mtimeMs, st.mtimeMs);
                size += st.size;
            }
            catch {
                // 某一个不在（例：增量日志还没建）⇒ 当 0 处理，⛔ 不算"变了"
            }
        }
        return any ? { mtimeMs, size } : null;
    };
    let known = null;
    return {
        changed() {
            const now = readAll();
            if (now === null)
                return false; // 都不在（首次/异常）⇒ 不当作"变了"，交给既有加载路径处理
            if (known === null) {
                known = now;
                return false;
            }
            if (now.mtimeMs !== known.mtimeMs || now.size !== known.size) {
                known = now;
                return true;
            }
            return false;
        },
        rebaseline() {
            known = readAll();
            return known;
        },
        stamp: () => known,
    };
}
