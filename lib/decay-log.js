/**
 * **L4 全量 · 一份事务日志（append-only）+ 一个可重建的投影**
 *
 * ## 这个文件要解决什么（施工单 §一 的账单）
 *
 * 修前有**三条事件流说同一件事**——"谁、在什么时候、把哪条从哪层搬到哪层"：
 *
 * | 文件 | 它其实是这日志的哪一段 |
 * |---|---|
 * | `.decay-intent.jsonl`（打算搬谁） | **`begin` 段** |
 * | `.decay-audit.jsonl`（搬了谁） | **`step` 段** |
 * | `.decay-sweep.json`（上次何时/批次） | **`commit` 段 + 投影** |
 *
 * **⇒ 三者不是三件事，是同一事务的三个阶段。** 被人为拆成三个文件，才需要互相补——
 * 而"互相补"就是 `decay-sweep.ts` **一天 226 → 833 行**里那 **600 行对账**的来源
 * （`healAuditFromIntents` / `compactIntents` / `intentHealth` / 意图形状校验 …）。
 *
 * ## 铁律（本模块的立足点）
 *
 * > **从日志重建出来的投影，必须与盘上投影逐字节一致。**
 *
 * ⛔ 这一条成立，"日志是真源、投影是派生物"才是**被证明的**而不是被声明的。
 * 修前那三件**没有任何一条这样的判据**——所以才需要"自愈"那种东西。
 *
 * ## 事务语义（崩溃可识别）
 *
 * - `begin` → `step`* → `commit` ＝ 完整批次
 * - **`begin` 有、`commit`/`abort` 无 ＝ 崩在中途** ⇒
 *   **`step` 段照样生效**（条目**在盘上真的搬了**，⛔ 不假装没发生），
 *   但**事务被标记为未完成**、**`lastBatch` 不推进** ⇒
 *   **读者不需要 `intent` 来"补审计"**了 —— 因为"搬了哪些"本来就在 `step` 段里。
 * - `abort` ⇒ 显式记"这批没成"
 *
 * ## ⛔ 本模块**只读不写**（步 ①）
 *
 * 施工单是三步走：**① 只增**（本文件）→ ② 双写 → ③ 切读。
 * **本步不改任何旧件**：旧三件照旧写、读侧一字未动。
 */
/** 事务的四个阶段 —— 少一个都读不出"这批到底成没成" */
import fs from 'node:fs';
import path from 'node:path';
const EMPTY = {
    lastCommitAt: null,
    lastBatch: null,
    lastMoved: 0,
    lastAutoAt: null,
    archivedAll: [],
    layers: {},
    incompleteTxns: [],
};
/**
 * **重放日志 → 投影。**
 *
 * ⛔ 不抛异常（日志坏了也要能读出"坏在哪"）；坏行/坏结构一律进 `problems`。
 * 这就是"篡改一行 ⇒ 必须报出不一致"那条判据的落点。
 */
export function replay(records) {
    const problems = [];
    const p = { ...EMPTY, archivedAll: [], layers: {}, incompleteTxns: [] };
    const seen = new Map();
    const order = [];
    const movedByTxnId = new Map();
    const rolledBackKeys = new Set();
    // 【性能修 · 2026-11-22】archivedAll 去重原本用 Array.includes ⇒ O(n²)。
    // 2 万条归档时 replay 要 300ms+，而它被 readAudit/listRollbackBatches 每次调用都走一遍。
    // 改成 Set 去重、数组保持首次出现顺序（语义与 includes 版逐字一致）。
    const archivedSeen = new Set();
    for (let i = 0; i < records.length; i++) {
        const r = records[i];
        const at = `第 ${i + 1} 条`;
        if (!r || typeof r !== 'object') {
            problems.push(`${at}：不是对象`);
            continue;
        }
        if (typeof r.txn !== 'string' || !r.txn) {
            problems.push(`${at}：缺 txn`);
            continue;
        }
        if (typeof r.seq !== 'number' || !Number.isInteger(r.seq) || r.seq < 0) {
            problems.push(`${at}（${r.txn}）：seq 不是非负整数`);
            continue;
        }
        if (!['begin', 'step', 'commit', 'abort'].includes(r.phase)) {
            problems.push(`${at}（${r.txn}）：未知 phase=${String(r.phase)}`);
            continue;
        }
        if (typeof r.at !== 'number' || !Number.isFinite(r.at) || Math.abs(r.at) > 8.64e15) {
            problems.push(`${at}（${r.txn}）：at 必须是有限的 Unix 毫秒时间戳`);
            continue;
        }
        const st = seen.get(r.txn);
        if (r.phase === 'begin') {
            if (st) {
                problems.push(`${at}（${r.txn}）：重复的 begin`);
                continue;
            }
            if (r.seq !== 0) {
                problems.push(`${at}（${r.txn}）：begin 的 seq 必须是 0，实为 ${r.seq}`);
                continue;
            }
            seen.set(r.txn, { seq: 0, closed: false, beganAt: r.at });
            order.push(r.txn);
            continue;
        }
        if (!st) {
            problems.push(`${at}（${r.txn}）：没有 begin 就先出现 ${r.phase}`);
            continue;
        }
        if (st.closed) {
            problems.push(`${at}（${r.txn}）：已 ${r.phase === 'commit' ? '提交' : '关闭'}后又有记录`);
            continue;
        }
        if (r.seq !== st.seq + 1) {
            problems.push(`${at}（${r.txn}）：seq 跳号 —— 期望 ${st.seq + 1}，实为 ${r.seq}（日志被改过？）`);
            continue;
        }
        st.seq = r.seq;
        if (r.phase === 'step') {
            if (typeof r.id !== 'string' || !r.id.trim()) {
                problems.push(`${at}（${r.txn}）：step 缺少有效字符串 id`);
                continue;
            }
            if (!r.action || !['intent', 'moved', 'block', 'skip'].includes(r.action)) {
                problems.push(`${at}（${r.txn}）：step 的 action 非法（${String(r.action)}）`);
                continue;
            }
            // ⭐ 情形分三种（⛔ 这是"一条日志取代三件"的立足点）：
            //   · `moved`  ⇒ **确实搬了** ⇒ 推进层归属
            //   · `intent` ⇒ **只是想搬** ⇒ ⛔ **不推进**（崩在中途时它可能根本没搬成）
            //   · `block`/`skip` ⇒ 没搬
            if (r.action === 'moved') {
                if (typeof r.from !== 'string' || !r.from || typeof r.to !== 'string' || !r.to) {
                    problems.push(`${at}（${r.txn}）：moved 缺 from/to`);
                    continue;
                }
                if (r.from !== 'longterm' || r.to !== 'archive') {
                    problems.push(`${at}（${r.txn}）：moved 层跃迁非法（${r.from} → ${r.to}）`);
                    continue;
                }
                p.layers[r.id] = r.to;
                movedByTxnId.set(`${r.txn}\u0000${r.id}`, { from: r.from, to: r.to });
            }
            else if (r.action === 'intent') {
                if (typeof r.from !== 'string' || !r.from || typeof r.to !== 'string' || !r.to) {
                    problems.push(`${at}（${r.txn}）：intent 缺 from/to`);
                    continue;
                }
                if (r.from !== 'longterm' || r.to !== 'archive') {
                    problems.push(`${at}（${r.txn}）：intent 层跃迁非法（${r.from} → ${r.to}）`);
                    continue;
                }
            }
            continue;
        }
        st.closed = true;
        if (r.phase === 'commit') {
            const hasRollback = r.rollbackOf !== undefined || r.rolledBackIds !== undefined;
            if (hasRollback) {
                if (typeof r.rollbackOf !== 'string' || !r.rollbackOf ||
                    !Array.isArray(r.rolledBackIds) ||
                    r.rolledBackIds.some((id) => typeof id !== 'string' || !id.trim()) ||
                    new Set(r.rolledBackIds).size !== r.rolledBackIds.length) {
                    problems.push(`${at}（${r.txn}）：回滚提交缺少有效 rollbackOf/rolledBackIds`);
                    continue;
                }
                for (const id of r.rolledBackIds) {
                    const key = `${r.rollbackOf}\u0000${id}`;
                    const source = movedByTxnId.get(key);
                    if (!source || source.from !== 'longterm' || source.to !== 'archive' || rolledBackKeys.has(key)) {
                        problems.push(`${at}（${r.txn}）：回滚条目没有唯一可信 moved 来源或已回滚：${id}`);
                        continue;
                    }
                    rolledBackKeys.add(key);
                    p.layers[id] = 'longterm';
                }
            }
            else {
                p.lastCommitAt = r.at;
                p.lastBatch = r.txn;
                p.lastMoved = typeof r.moved === 'number' ? r.moved : 0;
                p.lastAutoAt = typeof r.lastAutoAt === 'number' ? r.lastAutoAt : null;
                if (Array.isArray(r.archived)) {
                    for (const id of r.archived)
                        if (!archivedSeen.has(id)) {
                            archivedSeen.add(id);
                            p.archivedAll.push(id);
                        }
                }
            }
        }
        // abort：显式关闭，⛔ 不推进 lastCommitAt/lastBatch（"这批没成"）
    }
    for (const t of order) {
        const st = seen.get(t);
        if (!st.closed)
            p.incompleteTxns.push(t);
    }
    return { projection: p, problems };
}
/**
 * **逐字节比较**：投影一致吗？（施工单里最硬的那条判据的入口）
 * ⚠️ 用**规范化 JSON**（键序固定）比，⛔ 不用 `===`（对象引用比不出内容）。
 */
export function projectionFingerprint(p) {
    const norm = {
        lastCommitAt: p.lastCommitAt,
        lastBatch: p.lastBatch,
        lastMoved: p.lastMoved,
        lastAutoAt: p.lastAutoAt,
        archivedAll: [...p.archivedAll],
        layers: Object.fromEntries(Object.entries(p.layers).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
        incompleteTxns: [...p.incompleteTxns].sort(),
    };
    return JSON.stringify(norm);
}
/** 序列化一行（⛔ 不写盘、不碰文件 —— 落盘由调用方决定，步 ① 只提供能力）*/
export function serializeRecord(r) {
    return JSON.stringify(r);
}
/** 逐行解析（容错；坏行进 problems）—— 与 `replay` 的"坏行要报出来"同一条原则 */
export function parseLog(text) {
    const records = [];
    const problems = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line)
            continue;
        try {
            records.push(JSON.parse(line));
        }
        catch (e) {
            problems.push(`第 ${i + 1} 行不是合法 JSON：${String(e?.message ?? e).slice(0, 60)}`);
        }
    }
    return { records, problems };
}
// ══════════════════════════════════════════════════════════════════════
// 步 ②「双写」的**写**侧（2026-10-15）
//
// ⛔ 纪律：**新日志与旧三件同写，读侧仍走旧的。**
// ⛔ 而且：**新的坏了不能影响旧的** —— 所以这里**吞异常、只回报**，⛔ 绝不抛给扫描。
//    （扫描是正事，记账是次要点；这条与旧 `appendIntent` 的口径一致。）
// ══════════════════════════════════════════════════════════════════════
/** 日志文件名（相对容器根） */
export const SWEEP_LOG_FILE = '.sweep-log.jsonl';
/** 追加一批记录（append-only：⛔ 不读改写、⛔ 不截断）。**失败不抛**。 */
export function appendLog(root, records) {
    if (!records.length)
        return { ok: true };
    try {
        fs.appendFileSync(path.join(root, SWEEP_LOG_FILE), records.map(serializeRecord).join('\n') + '\n', 'utf-8');
        return { ok: true };
    }
    catch (e) {
        return { ok: false, err: String(e?.message ?? e).slice(0, 160) };
    }
}
/** 启动期对账：日志里有 begin 但没有 commit/abort 的事务（半批/崩溃现场）。⛔ 只报告，不自动修。 */
export function readIncompleteSweeps(root) {
    const { records, problems } = readLog(root);
    return { txns: replay(records).projection.incompleteTxns, problems };
}
/** 读整份日志（⛔ 容错：坏行进 problems，不抛） */
export function readLog(root) {
    try {
        const f = path.join(root, SWEEP_LOG_FILE);
        if (!fs.existsSync(f))
            return { records: [], problems: [] };
        return parseLog(fs.readFileSync(f, 'utf-8'));
    }
    catch (e) {
        return { records: [], problems: [`读日志失败：${String(e?.message ?? e).slice(0, 120)}`] };
    }
}
