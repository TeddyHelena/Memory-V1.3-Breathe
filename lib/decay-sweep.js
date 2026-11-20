/**
 * 自动降层的**执行侧**（判定在 `decay.ts`，那里是纯函数、有七条测试）。
 *
 * 设计见 `docs/decay-design.md`。这一层只做三件事：
 *   ① 读/写"这次该不该跑"的状态（`.decay-sweep.json`，一天一次）；
 *   ② 把 `planDecaySweep` 的结果**逐条走容器既有写入通道**（`relocate`，单一写入时刻）；
 *   ③ 逐条落审计（`.decay-audit.jsonl`，只追加）⇒ 支持**整体回滚**。
 *
 * ⛔ 硬约束：这里**永不抛到启动路径上**（调用方必须 try/catch）；⛔ 不自己拼文件写入，
 * 一律 `relocate` —— 多通道写容器会把索引整份覆盖（2026-09-14 踩过两次）。
 */
import fs from 'node:fs';
import { appendLog, readLog, replay } from './decay-log.js';
import { acquireWriteLock } from './lock.js';
import path from 'node:path';
import { dayKey } from './day-boundary.js';
import { planDecaySweep, sweepDecision } from './decay.js';
const SWEEP_STATE_FILE = '.decay-sweep.json';
const AUDIT_FILE = '.decay-audit.jsonl';
/**
 * 【G1 · 2026-10-14】**审计意图日志**（只追加）。
 *
 * ## 堵的是哪道缝
 * 一次搬运的顺序是「`relocate`（写文件→搬文件→同步索引→落索引）→ append 审计行」。
 * 进程若死在**两者之间**，条目已经归档、**审计里却没有它** ⇒
 * 标准回滚路径（靠审计找）**找不到它**，也没人会发现。代码 10-11 就把这道缝标注为"残余风险"。
 *
 * ## 怎么堵
 * 搬之前先落一行**意图**；搬完再落正式审计行。
 * 启动时对账：**有意图、无审计、且条目确实已在目标层** ⇒ 就是那次崩溃 ⇒ **补写审计行**（自愈）。
 * 有意图、无审计、条目**不在**目标层 ⇒ 搬没发生（无害，什么都不用做）。
 *
 * ⛔ 为什么**另开一个文件**而不是在审计里加个 `phase` 字段：审计是被 `/decay-state` 与
 *    `rollbackLastBatch` 直接读的既有契约，往里插新行会让"最近一批"的判断多一层语义。
 *    另开文件 = 对既有读者**零影响**。
 */
const INTENT_FILE = '.decay-intent.jsonl';
/** 写容器**之外**的旁挂文件（⛔ 不是容器内容，别走 relocate）*/
function atomicWrite(file, text) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, text, 'utf-8');
    fs.renameSync(tmp, file);
}
/**
 * 【L1 · 2026-10-15】**薄适配**（⛔ 不再自己读文件）：`readSweepStateEx` 是**唯一读**。
 *
 * 契约保留：**缺失 / 损坏 都返回 `null`**（与改造前一致）。
 * ⚠️ **一处细微行为差异（如实标注）**：改前用 `typeof === 'number'`（`NaN` 能通过），
 *    改后继承 `Ex` 的 `Number.isFinite`（`NaN` 算损坏）。
 *    下游 `sweepDecision` 本来就 `Number.isFinite` 兜底 ⇒ **效果中性**。
 * ⛔ **退役条款**：本薄适配**只服务老调用方**；新代码一律直接用 `readSweepStateEx`。
 */
export function readSweepState(root) {
    return readSweepStateEx(root).state;
}
/**
 * 读状态并**补齐** `lastDayKey`（旧状态文件没有这个字段 ⇒ 由 `lastAt` 现算）。
 * ⛔ 只读、不改盘；调用方拿到的形状是完整的 `SweepState`。
 * 兼容性说明：旧文件照样能读；新文件对旧代码是多一个字段而已（回滚安全）。
 * ⛔ **必须导出**（2026-10-14）：启动路径（`index.ts`）也要用它 —— 用原始 `readSweepState` 的话，
 *   旧格式状态文件（缺 `lastAutoAt`）会让 `lastAutoAt` 变成 `undefined` ⇒ `sweepDecision` 里
 *   `autoKey === null` ⇒ **"一天一次"那道判据被整条跳过**，退化成"每 6 小时可跑一次"。
 *   实测现场：10-14 07:39 已扫过，14:31 重启**又扫了一遍**（跨了 6h 但同一自然日）。
 */
/**
 * 【L1 · 2026-10-15】**薄适配**：唯一的读是 `readSweepStateEx`，本函数只补旧格式缺的两个字段。
 * ⛔ **退役条款**：真身状态文件一旦全部含 `lastAutoAt`/`lastDayKey`（由 `checkSweepState` 报出），
 *    本函数**退休**，改用 `readSweepStateEx(root).state` 直接读。
 */
export function readSweepStateCompat(root) {
    const raw = readSweepState(root);
    if (!raw)
        return null;
    return {
        ...raw,
        lastDayKey: raw.lastDayKey ?? dayKey(new Date(raw.lastAt)),
        // ⛔ 这一行是**"一天一次"判据在旧文件上的唯一依托**（2026-10-14 差点被我删掉）：
        //    缺它 ⇒ `lastAutoAt` undefined ⇒ 判定里 `autoKey=null` ⇒ **同日判据整条失效**，
        //    退化成"每 6h 可跑一次"（实测：07:39 扫过、14:31 又扫一遍）。
        //    旧文件没有这个字段 ⇒ 拿 `lastAt` 兜底（语义="上次扫描那次也算自动那次"）。
        lastAutoAt: typeof raw.lastAutoAt === 'number' && Number.isFinite(raw.lastAutoAt) ? raw.lastAutoAt : raw.lastAt,
    };
}
/**
 * 【F1 · 2026-10-14 对抗验证 B】读状态并**区分三种情况**：没有文件 / 有文件但坏了 / 读到了。
 *
 * 为什么非要区分：`readSweepState` 把"没有文件"和"文件是垃圾"**都返回 null** ⇒
 * `checkSweepState(null)` 返回 `[]`（首启本来就该没问题）⇒ **状态文件损坏时自检一片安静，
 * 而闸门会把它当"首次运行"照跑**（实测：同日连跑多批）。
 * ⛔ 这两种情况的处置完全不同：没有文件 = 正常首启；有文件读不出 = **必须喊**。
 */
export function readSweepStateEx(root) {
    const file = path.join(root, SWEEP_STATE_FILE);
    let text;
    try {
        text = fs.readFileSync(file, 'utf-8');
    }
    catch {
        return { state: null, missing: true, corrupt: false, from: 'file' };
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return { state: null, missing: false, corrupt: true, from: 'file' };
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        return { state: null, missing: false, corrupt: true, from: 'file' };
    const raw = parsed;
    if (typeof raw.lastAt !== 'number' || !Number.isFinite(raw.lastAt))
        return { state: null, missing: false, corrupt: true, from: 'file' };
    return { state: raw, missing: false, corrupt: false, from: 'file' };
}
export function resolveGateSnapshot(root, nowMs) {
    const ex = readSweepStateEx(root);
    const st = readSweepStateCompat(root);
    const audit = readAudit(root);
    /**
     * 【C3 · 对抗验证 C 修】**只认"像扫描"的行，且未来行不参与。**
     *
     * 修前是"把审计里的 `at` 最大值当 `lastAutoAt`"，而 `readAudit` 对行**零形状校验**
     * （审计是旁挂文件，谁都能写）⇒ 实测：一行 `at=今天` ⇒ 当天判 `same-day`、**衰减停摆一天**；
     * 一行 `at=未来` ⇒ 判 `clock-back`、**停摆到现实时间追上**（实测 10 天）。
     * ⇒ 现在只认：批次格式合规 + `from/to` 是衰减那一对 + `at` 有限**且不晚于现在**。
     */
    const scanLike = audit.filter((r) => typeof r.batch === 'string' && /^sweep-\d{8,}/.test(r.batch)
        && r.from === 'longterm' && r.to === 'archive'
        && typeof r.at === 'number' && Number.isFinite(r.at) && r.at <= nowMs);
    const auditNewestAt = scanLike.reduce((m, r) => (m === null || r.at > m ? r.at : m), null);
    const stateAt = st && typeof st.lastAt === 'number' && Number.isFinite(st.lastAt) ? st.lastAt : null;
    // 状态比审计**落后**（A9：状态没落盘）⇒ 取审计那个更晚的 ⇒ 闸门才知道"今天已经扫过了"
    const stale = stateAt !== null && auditNewestAt !== null && auditNewestAt > stateAt + 1000;
    if (stateAt !== null && !stale) {
        // ⭐【L4 步④c-β 前置二 · 2026-10-15】**来源如实** —— `readSweepStateEx` 会说它从哪儿读的。
        //   · 读自状态文件 ⇒ `'state'`（历史行为）
        //   · 读自**日志的 commit** ⇒ `'log'`（⛔ 那时报 `'state'` 就是**读数撒谎**）
        //   ⚠️ `'log'` 那一支要等 ④c-β 的"读侧日志优先"才可达 —— 本步只是**把档位挂上**。
        const src = ex.from === 'log' ? 'log' : 'state';
        return {
            snap: snapshotOf(st),
            from: src,
            block: false,
            ...(src === 'log' ? { note: '状态读自**扫描日志**（状态文件已停写）—— 真源是日志的 commit 记录' } : {}),
        };
    }
    if (auditNewestAt !== null) {
        // ⛔ lastAutoAt 也取审计值：审计里的扫描都是**自动扫描**（force 不写审计，它是"手动"，不占当天额度）
        return {
            snap: { lastAt: auditNewestAt, lastAutoAt: auditNewestAt, lastDayKey: null },
            from: 'audit',
            block: false,
            note: stale ? '状态文件落后于审计（上次状态没落盘）⇒ 已用审计兜底' : '状态文件读不出 ⇒ 已用审计兜底',
        };
    }
    if (ex.missing)
        return { snap: { lastAt: null, lastAutoAt: null, lastDayKey: null }, from: 'none', block: false };
    // 有状态文件、读不出来、审计也空 ⇒ 真无从得知 ⇒ 本次不扫（唯一的硬拦）
    return { snap: { lastAt: null, lastAutoAt: null, lastDayKey: null }, from: 'none', block: true, note: '状态文件损坏且审计为空 ⇒ 无法判断今天扫没扫，本次不扫' };
}
/** 把一个 `SweepState` 折成判定用的快照（⛔ 判定只看绝对时刻，不看日键字符串）*/
export function snapshotOf(st) {
    return st === null
        ? { lastAt: null, lastAutoAt: null, lastDayKey: null }
        : { lastAt: st.lastAt, lastAutoAt: st.lastAutoAt, lastDayKey: st.lastDayKey };
}
/** 读意图日志（只读、逐行容错；读不到当空）*/
export function readIntents(root) {
    return readJsonlTolerant(path.join(root, INTENT_FILE)).rows;
}
// ⛔【L4 步④c · 2026-10-15】**此处原有 `intentHealth`（意图文件的健康读数），已删。**
//   ⭐ 为什么能删：③c-3 起**意图文件不再增长** ⇒ 读数恒"0 行/0 坏行" ⇒ 再读是**对着一份冻住的历史报健康**。
//   ⛔ `auditHealth` **不在本列**（审计还在写，④d 才停）。
/**
 * **意图形状校验**（2026-10-14 对抗验证第 1.x 条的修法）。
 *
 * ⛔ 修前**零校验**：旁挂文件里任何一个 JSON 对象都被当意图 ⇒ 只手写一行就能让自愈
 *   凭空补出"扫描归档"的审计行，回滚随之把条目搬进**它从没待过的层**（实测 longterm→hot）。
 *
 * 校验五条（每条都对着一个攻击）：
 *   ① `phase === 'begin'` —— 挡住"任何 JSON 对象"（第 1.3 条）
 *   ② `from === 'longterm' && to === 'archive'` —— 衰减流水线**只有这一种跃迁**
 *      ⇒ 直接杀掉"from 写假"（第 1.1/1.2 条：撤销把活条目归档 / 搬进 hot）
 *   ③ `batch` 必须匹配本容器发过的批次格式 `/^sweep-…/` —— 挡住 `sweep-legacy` 这类手写批次
 *   ④ `id` 非空字符串、`at` 有限数
 *   ⑤ `to !== from`
 * ⚠️ 诚实边界：这**挡不住**"手写一行完全合规的意图"——那需要签名或写权限隔离，
 *    当前口径是"旁挂文件在本机、与容器同权限"，不做加密。但合规伪造的最坏后果已经降到
 *    "把一条已在 archive 的条目回滚回 longterm"（= 它本来该来的地方），**不再是搬进 hot**。
 */
function isValidIntent(o) {
    if (o === null || typeof o !== 'object')
        return false;
    const r = o;
    return r.phase === 'begin'
        && r.from === 'longterm' && r.to === 'archive'
        && typeof r.id === 'string' && r.id.length > 0
        && typeof r.batch === 'string' && /^sweep-\d{8,}/.test(r.batch)
        && typeof r.at === 'number' && Number.isFinite(r.at);
}
/**
 * 【G1 · 自愈】把"搬了但没记上"的那条补进审计。
 *
 * @param layerOf 查某个 id 现在在哪个层（容器索引的真值）
 * @returns 补了几条 + 补了哪些（⛔ 如实回报，静默修复等于换个地方藏问题）
 */
// ⛔【L4 步③c-2 · 2026-10-15 · 自愈退役】**此处原有 `compactIntents` 与 `healAuditFromIntents`，已删。**
//   ⭐ **为什么能删**：`readAudit` 现在并入日志的 **`moved`** 段（③c-1 已验）⇒
//      「搬了但审计没写」那一缝**由日志直接顶上** ⇒ 自愈成了冗余（白名单 **W10**）。
//   ⚠️ **它的判据没丢**：`test/decay-wiring.test.mjs` 留了改写后的那条 ——
//      「**审计文件被删空 ⇒ 日志的 `moved` 段顶上来**」（正是取代自愈的行为）。
//   ⛔ **坏行读数不在此列**：`auditHealth` / `intentHealth` 仍在（那两个文件还在写，③c-4' 才停）。
/**
 * 【G2 · 2026-10-14】**状态一致性自检**：把 `.decay-sweep.json` 里三种语义互相对账。
 *
 * 为什么要有它：这个文件挤着**运行账**（`lastAt`/`lastAutoAt`）、**闸门账**（`lastDayKey`）、
 * **回滚锚**（`lastBatch`/`lastCount`）。2026-10-14 真出过一次事：旧格式缺 `lastAutoAt`
 * ⇒ "一天一次"整条判据**静默失效**（同日跑了第二遍）。
 * 那道闸门是补了，但**"三语义互相不一致时没人知道"**这件事本身还在 ⇒ 这个自检就是堵它。
 *
 * 返回**问题清单**（空数组 = 一致）。⛔ 只报不改 —— 修不修由调用方决定。
 *
 * ⛔⛔ **必须传「原始读」的结果（`readSweepState`），不许传「兼容读」（`readSweepStateCompat`）**：
 *   兼容读会把缺失的 `lastAutoAt` / `lastDayKey` **兜底补上** ⇒ 那道检查**永远不响**。
 *   2026-10-14 自查实测：同一个"旧格式缺 lastAutoAt"的状态，
 *   原始读报 1 条问题，兼容读报 **0 条** —— 等于这个自检白装。
 *   （**决策**用兼容读，**审计这个文件**用原始读 —— 两种读法各有其位，⛔ 别混。）
 */
/** 安全时间戳格式化：极端值/非有限**不抛**（⛔ 报错文案不许把自检自己搞炸） */
function fmtTs(ms) {
    return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : `非法时间戳(${String(ms)})`;
}
export function checkSweepState(st, nowMs, opts = {}) {
    const issues = [];
    // 【F1】文件在但读不出来 ⇒ 这一条比任何字段级检查都重要（闸门会把它当首启）
    if (opts.corrupt) {
        issues.push('状态文件存在但**读不出来**（JSON 坏 / lastAt 形状非法）⇒ 判定会当成"首次运行"，同日可能重复扫描');
    }
    if (!st)
        return issues;
    const { lastAt, lastAutoAt, lastDayKey } = st;
    /** 【F2】时间戳合法性守卫：`dayKey(new Date(ms))` 在 |ms| > 8.64e15 时**抛 RangeError**
     *  —— 修前它会在自检里抛出去，被 index.ts 的空 catch 吞掉 ⇒ **零日志**。 */
    const tsOk = (ms) => typeof ms === 'number' && Number.isFinite(ms) && Math.abs(ms) <= 8.64e15;
    if (!tsOk(lastAt))
        issues.push('lastAt 非法（运行账坏了）');
    // 【F5】修误报：`lastAutoAt === 0` 是**代码自己写的合法态**（force 首次跑的占位），
    //   修前把它报成"判据失去依托"，但此时 lastAt 有效 ⇒ 判定其实正常。
    //   真正该报的是"缺失/非法/非零却无效"。
    const autoMissing = lastAutoAt === undefined || lastAutoAt === null;
    const autoBroken = !autoMissing && !(lastAutoAt === 0 || tsOk(lastAutoAt));
    if (autoMissing) {
        issues.push('lastAutoAt 缺失 —— **"一天一次"判据会失去依托**（旧格式文件或迁移不全）');
    }
    else if (autoBroken) {
        issues.push('lastAutoAt 非法（既不是 0 也不是合法时间戳）');
    }
    else if (lastAutoAt !== 0 && tsOk(lastAutoAt)) {
        const derived = dayKey(new Date(lastAutoAt));
        /**
         * 【A3 · 对抗验证 B】修前这里写的是 `if (lastDayKey && lastDayKey !== derived)` ——
         * **空串是 falsy ⇒ 检查被整条短路**。而 `lastDayKey: ''` 恰好是代码在
         * `lastAutoAt <= 0` 时自己写的值 ⇒ "空串 + 合法 lastAutoAt"这种组合可以悄悄溜过去。
         * 修后：`lastAutoAt` 合法且非 0 时，`lastDayKey` **必须**等于现算值 ——
         * 缺失/空串/不符**都算不一致**（"不知道" != "对得上"）。
         */
        if (!lastDayKey) {
            issues.push(`lastAutoAt 有值（${derived}）但 lastDayKey 缺失/为空 ⇒ 对账面不完整`);
        }
        else if (lastDayKey !== derived) {
            issues.push(`lastDayKey=${lastDayKey} 与 lastAutoAt 现算的 ${derived} 不一致（对账面被改过 / 迁移不全）`);
        }
        if (tsOk(lastAt) && lastAutoAt > lastAt)
            issues.push('lastAutoAt 晚于 lastAt（自动那次不可能晚于任何一次）');
    }
    if (tsOk(lastAt) && lastAt > nowMs)
        issues.push('lastAt 在未来（时钟回拨过）—— 判定会保守不跑');
    // 【F4】回滚锚（第三种语义）以前**从不参审** ⇒ "三语义对账"是空话。补上。
    if (st.lastCount !== undefined && (!Number.isInteger(st.lastCount) || st.lastCount < 0)) {
        issues.push(`lastCount 非法（应为非负整数）：${String(st.lastCount)}`);
    }
    if (st.lastBatch !== undefined && st.lastBatch !== '' && !/^sweep-\d{8,}/.test(String(st.lastBatch))) {
        issues.push(`lastBatch 形状非法（不是本容器发的批次）：${String(st.lastBatch)}`);
    }
    // 【F4 · 跨文件对账】审计里有比 lastAt **更新**的扫描记录 ⇒ 上一次状态没写进去
    //   （对抗验证 A9 那个场景：状态写失败 ⇒ 闸门不推进 ⇒ 同日连跑多批而日志全绿）
    if (opts.auditNewestAt != null && tsOk(lastAt) && opts.auditNewestAt > lastAt + 1000) {
        // 【C5】`new Date(x).toISOString()` 在 |x|>8.64e15 或非有限时会抛 RangeError
        //   ⇒ 自检自己炸掉（G2 从"报"退化成"自检坏了"）。文案里一律走安全格式化。
        issues.push(`审计里有比 lastAt 更新的扫描记录（审计 ${fmtTs(opts.auditNewestAt)} > lastAt ${fmtTs(lastAt)}）⇒ **上次状态没落盘，闸门没推进**`);
    }
    return issues;
}
/**
 * **逐行容错读 JSONL**（2026-10-14 对抗验证第 2.1/2.4 条的修法）。
 *
 * ⛔ 修前的写法是 `.split('\n').map(l => JSON.parse(l))` 一把梭 —— **一行半截 JSON 就让整份判空**：
 *    · 审计一份判空 ⇒ 真孤儿永久漏 + 零信号（**正是 G1 要堵的那种崩溃**）
 *    · 意图一份判空 ⇒ 自愈整体失效
 *    · 一行 `null` / `{}` ⇒ `JSON.parse` 成功但形状是垃圾 ⇒ 自愈或回滚在后面炸
 * ⇒ 改成逐行 try/catch：坏行**跳过并计数**，绝不整份判空。坏行数必须能被报出来（⛔ 不许静默）。
 */
function readJsonlTolerant(file) {
    let text;
    try {
        text = fs.readFileSync(file, 'utf-8');
    }
    catch {
        return { rows: [], badLines: 0 };
    }
    const rows = [];
    let badLines = 0;
    for (const line of text.split('\n')) {
        if (!line.trim())
            continue;
        try {
            const o = JSON.parse(line);
            if (o === null || typeof o !== 'object' || Array.isArray(o)) {
                badLines++;
                continue;
            }
            rows.push(o);
        }
        catch {
            badLines++;
        }
    }
    return { rows, badLines };
}
function isAuditRecordShape(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    const r = value;
    return typeof r.batch === 'string' && r.batch.length > 0 &&
        typeof r.id === 'string' && r.id.length > 0 &&
        typeof r.from === 'string' && r.from.length > 0 &&
        typeof r.to === 'string' && r.to.length > 0 &&
        typeof r.at === 'number' && Number.isFinite(r.at) && Math.abs(r.at) <= 8.64e15 &&
        (r.fresh === undefined || r.fresh === null || (typeof r.fresh === 'number' && Number.isFinite(r.fresh))) &&
        (r.rolledBack === undefined || typeof r.rolledBack === 'boolean') &&
        (r.rollbackTxn === undefined || (typeof r.rollbackTxn === 'string' && r.rollbackTxn.length > 0)) &&
        (r.healed === undefined || typeof r.healed === 'boolean');
}
/**
 * 从完整重放通过的事务日志建立唯一可信的搬运索引。
 * `.decay-audit.jsonl` 是投影/兼容记录，不得独立创造可回滚事实。
 */
function trustedMovedIndex(root) {
    const log = readLog(root);
    const replayed = replay(log.records);
    const trusted = log.problems.length === 0 && replayed.problems.length === 0;
    const moved = new Map();
    const rolledBack = new Map();
    if (!trusted)
        return { trusted: false, moved, rolledBack };
    for (const r of log.records) {
        if (r.phase === 'step' && r.action === 'moved' && typeof r.id === 'string' &&
            typeof r.from === 'string' && typeof r.to === 'string') {
            const key = `${r.txn}\u0000${r.id}`;
            if (!moved.has(key))
                moved.set(key, { from: r.from, to: r.to, at: r.at, ...(typeof r.why === 'string' ? { why: r.why } : {}) });
        }
        if (r.phase === 'commit' && typeof r.rollbackOf === 'string' && Array.isArray(r.rolledBackIds)) {
            for (const id of r.rolledBackIds) {
                if (typeof id !== 'string')
                    continue;
                rolledBack.set(`${r.rollbackOf}\u0000${id}`, { rollbackTxn: r.txn, at: r.at });
            }
        }
    }
    return { trusted: true, moved, rolledBack };
}
export function readAudit(root) {
    const rawRows = readJsonlTolerant(path.join(root, AUDIT_FILE)).rows;
    const shapedRows = rawRows.filter(isAuditRecordShape);
    const { trusted, moved, rolledBack } = trustedMovedIndex(root);
    // 日志缺失、损坏或重放失败时 fail-closed：旧审计投影也不能独立进入回滚。
    if (!trusted)
        return [];
    const rows = [];
    const seen = new Set();
    const seenRollback = new Set();
    for (const r of shapedRows) {
        const key = `${r.batch}\u0000${r.id}`;
        const source = moved.get(key);
        if (!source || source.from !== r.from || source.to !== r.to)
            continue;
        if (r.rolledBack === true) {
            const rollback = rolledBack.get(key);
            // rolledBack 标记不是事实来源；必须精确绑定已提交的回滚事务及其时间。
            if (!rollback || !r.rollbackTxn || r.rollbackTxn !== rollback.rollbackTxn || r.at !== rollback.at)
                continue;
            if (!seenRollback.has(key)) {
                rows.push(r);
                seenRollback.add(key);
            }
            continue;
        }
        if (source.at !== r.at)
            continue;
        if (!seen.has(key)) {
            rows.push(r);
            seen.add(key);
        }
    }
    // 日志 moved 是原始搬运事实源；审计投影缺行时由它补齐。
    for (const [key, source] of moved) {
        const split = key.indexOf('\u0000');
        const batch = key.slice(0, split);
        const id = key.slice(split + 1);
        if (!seen.has(key)) {
            rows.push({
                batch, id, from: source.from, to: source.to,
                fresh: null, at: source.at,
                reason: source.why ?? '由事务日志恢复',
            });
            seen.add(key);
        }
        const rollback = rolledBack.get(key);
        if (rollback && !seenRollback.has(key)) {
            rows.push({
                batch, id, from: source.from, to: source.to,
                fresh: null, at: rollback.at,
                reason: `由回滚事务 ${rollback.rollbackTxn} 恢复回滚标记`,
                rolledBack: true,
                rollbackTxn: rollback.rollbackTxn,
            });
            seenRollback.add(key);
        }
    }
    return rows;
}
/* ⛔【L4 步③b · 2026-10-15 判据抓出的第二处】**合并不是 no-op ⇒ 留到 ③c**
 *
 * 我原以为"旧文件 ∪ 日志（键 batch:id 去重）"在双写期是零新增 ⇒ 行为不变。
 * **G1 测试当场推翻**：它的场景是"**搬了但审计没写**"（模拟崩在 relocate 与审计之间），
 * 而日志里**有 `moved`** ⇒ 合并会把那一行**补出来** ⇒ **`healAuditFromIntents` 那套自愈当场失去意义**。
 *
 * ⭐ 这不是坏消息 —— 它是 L4 的**收益**：**日志已经把"自愈"这件事从机制降级成冗余**。
 * 但它**是行为变化**，所以：
 *   · **③b（双写期）**：⛔ 不合并 —— 保住"旧行为一字不变"这条纪律
 *   · **③c（停写旧件）**：合并 + 自愈退役 —— 那时才有资格改行为，且要进白名单
 */
/** 审计文件的健康读数（坏行数要能被看见，⛔ 不许静默）*/
export function auditHealth(root) {
    const r = readJsonlTolerant(path.join(root, AUDIT_FILE));
    const shaped = r.rows.filter(isAuditRecordShape);
    const badShapes = r.rows.length - shaped.length;
    const { trusted, moved, rolledBack } = trustedMovedIndex(root);
    const unboundRows = trusted ? shaped.filter((row) => {
        const key = `${row.batch}\u0000${row.id}`;
        const source = moved.get(key);
        if (!source || source.from !== row.from || source.to !== row.to)
            return true;
        if (row.rolledBack === true) {
            const rollback = rolledBack.get(key);
            return !rollback || !row.rollbackTxn || row.rollbackTxn !== rollback.rollbackTxn || row.at !== rollback.at;
        }
        return source.at !== row.at;
    }).length : shaped.length;
    const log = readLog(root);
    const replayed = replay(log.records);
    return {
        rows: r.rows.length,
        badLines: r.badLines,
        badShapes,
        unboundRows,
        logProblems: log.problems.length + replayed.problems.length,
    };
}
/**
 * 跑一次扫描。**调用方负责 try/catch** —— 见文件头硬约束。
 * 幂等口径（Breathe-R1 起）：**当地自然日最多一次** ＋ **最小间隔 6h**。
 * ⛔ 只要有任何一条 `relocate` 抛错，**立即停止**并如实回报（不做"尽力而为"的部分成功）。
 *
 * ## `force` 的口径（审查①第 3 条抓到的陷阱，2026-10-14）
 * `force: true` 只绕过"今天跑过"这一层，**⛔ 不写 `lastDayKey`**。
 * 为什么：若强制跑把今天标成"已扫"，**当天真正的自动扫描就被顶掉了**——
 * 那正是本轮要修的那类静默少跑。`lastAt` 照常推进（6h 最小间隔要靠它）。
 */
/**
 * **到点就跑**：闸门解析 + 执行，**一个权威**（2026-10-14 goal ④ / 架构主线一）。
 *
 * ## 为什么必须有这个函数
 * 同一个"今天该不该扫"的决策，此前有**两个入口、兜底还不对等**：
 *   · 宿主**启动**路径 → `resolveGateSnapshot`（**带审计兜底 + 损坏检测**）
 *   · **手动**路径（界面上那个按钮）→ 不传 `snap` ⇒ `runSweep` 内部**裸读状态**、无兜底
 * ⇒ 状态文件损坏时两边**结论不同**（启动会拦/兜，手动当"首次运行"照跑）。
 * 这正是本仓 2026-10-14 追了一整天的病：**一个决策，多处各算一遍**。
 *
 * ⇒ 三条路（**启动 / 定时 / 手动**）一律走这里 ⇒ 闸门只有一份实现。
 *
 * @param deps.gate 调用方已解析过的闸门（启动路径已经算过一次，⛔ 别重复读盘）；
 *                  不传则本函数自己 `resolveGateSnapshot`（**仍然是同一个权威**）。
 */
function runDueSweepLocked(deps) {
    const gate = deps.gate ?? resolveGateSnapshot(deps.root, deps.now ?? Date.now());
    if (gate.block) {
        // ⛔ 只填**真实存在**的字段（第一版塞了 `skipped`/`verified` 这些不存在的 ⇒ tsc 当场抓出来）
        return { ran: false, archived: [], blocked: 0, reason: `⛔ 不扫：${gate.note ?? '闸门不可用'}`, decidedBy: 'gate-blocked', gateFrom: gate.from };
    }
    const out = runSweepLocked({ ...deps, snap: gate.snap });
    return { ...out, gateFrom: gate.from };
}
function runSweepLocked(deps) {
    const now = deps.now ?? Date.now();
    const state = readSweepStateCompat(deps.root);
    const forced = deps.force === true;
    const decision = sweepDecision(deps.snap ?? snapshotOf(state), now);
    if (!forced && !decision.run) {
        return { ran: false, archived: [], blocked: 0, reason: decision.reason, decidedBy: decision.decidedBy };
    }
    // 【#6】不传 limit ⇒ 交给 `planDecaySweep` 按池规模派生（自带上下限），⛔ 不再写死 20
    let plan = deps.planOverride ?? planDecaySweep(deps.entries, deps.limit);
    // 【P0-2 修复】钉住=否决：任何来源的计划都过一遍 pins，不只在链级判据里生效
    if (deps.pins && deps.pins.size) {
        const pinned = deps.pins;
        const kept = plan.moves.filter((m) => !pinned.has(m.id));
        if (kept.length !== plan.moves.length) {
            const blocked = [...plan.blocked];
            const classes = { ...plan.classes };
            for (const m of plan.moves) {
                if (!pinned.has(m.id))
                    continue;
                blocked.push({ id: m.id, why: '被钉住（pins.json）', cls: 'roster-anchor' });
                classes['roster-anchor'] = (classes['roster-anchor'] ?? 0) + 1;
            }
            plan = { ...plan, moves: kept, blocked, classes };
        }
    }
    // 批次号带**毫秒**：秒级口径下同一秒内的两次扫描会并成一批（回滚会把两批一起撤）。
    // 仍与上一批撞号（同一毫秒重入）时加后缀，⛔ 不靠随机数。
    const base = `sweep-${new Date(now).toISOString().slice(0, 23).replace(/[-:T.]/g, '')}`;
    const batch = state?.lastBatch === base ? `${base}-2` : base;
    const archived = [];
    const intentFailures = [];
    let stateWriteFailed = false;
    const auditPath = path.join(deps.root, AUDIT_FILE);
    // ⭐【L4 步②·双写】批次开始 ⇒ 落 `begin`。
    //   ⛔ 纪律：**新的坏了不能影响旧的** —— appendLog 内部吞异常（不抛），扫描该照常完成。
    const txn = batch;
    let logSeq = 0;
    let commitAutoAt = 0; // ⭐【步④a】状态块里算出后，带进 commit 记录
    // ⭐【步④c-α · 2026-10-15】日志写失败 ⇒ **必须传出来**（⛔ 不许静默）
    let logWriteFailed = false;
    if (!appendLog(deps.root, [{ txn, seq: logSeq++, phase: 'begin', at: now }]).ok)
        logWriteFailed = true;
    try {
        for (const m of plan.moves) {
            // 【G1】先落**意图**：万一死在"搬完→审计没写"之间，启动时的自愈能把审计补回来。
            //    ⛔ 意图写失败**不挡搬运**（记账次要点，不能因为记账坏了就不干活）。
            // 【修 6】意图写失败 ⇒ 记在案，别让 G1 对这条静默缺席
            // ⛔【L4 步③c-3 · 2026-10-15】**停写意图文件** —— 它那一份，日志的 `step` 段已经有了：
            //   · `intent`（"我要搬它"）= 日志的 **`intent` 记录**（写于 `relocate` 之前）
            //   · `audit`（"搬成了"）  = 日志的 **`moved` 记录**（写于 `relocate` 之后）
            // ⇒ 两个文件记的**同一件事**，日志已经分开记了两态（③b/③c-1 已验）。
            // ⚠️ 文件**保留不删**（⛔ 历史在里面）；`readIntents` / `intentHealth` 仍能读它（读到的是历史）。
            // ⛔ 无意图 ⇒ `intentFailures` 恒空（字段保留，⛔ 不动 `SweepResult` 的形状）。
            // ⭐【L4 步②·双写】`step` 写在 **relocate 之前** —— 一份记录**同时覆盖**
            //   `intent`（打算搬）与 `audit`（搬了）：有 `commit` ⇒ 真搬了；
            //   没 `commit` ⇒ 可能搬了没记上（而 `step` 已经在这儿，读者知道该查谁）。
            if (!appendLog(deps.root, [{ txn, seq: logSeq++, phase: 'step', at: now, id: m.id, action: 'intent', from: m.from, to: m.to, why: m.reason }]).ok)
                logWriteFailed = true;
            deps.relocate(m.id, m.to, { operator: 'decay-sweep', reason: m.reason });
            archived.push(m.id);
            // ⛔ **逐条落审计**，不许等整批跑完再一次性写：
            //    2026-10-11 实测——第 5 条写入抛错时，前 4 条**已经搬走了**，而审计 0 条
            //    ⇒ 那 4 条查不到来源、也回滚不了（回滚靠审计找），等于静默降层。
            //    （残余风险：relocate 成功、紧接着的 append 失败，仍会漏一条；那需要跨文件事务，
            //      当前口径是"先搬后记"，这里已是最小的那道缝。）
            // ⭐【L4 步③b · §9.3】**这一条才是"它确实被搬了"**（上一条只是"我要搬它"）。
            //   ⛔ 两者分开是判据抓出来的：原设计用一个 `move` 兼两义 ⇒ `readAudit` 一合并就撒谎
            //   （F2：relocate 抛错 ⇒ 没搬成 ⇒ 却被算进审计 ｜ expected 4 ｜ actual 5）。
            // 【P1-3 修复 · 2026-10-19】`moved` **先于**审计行写：修前审计 append 抛错时 moved 也没写
            //   ⇒ 日志只剩 begin+intent，G1 自愈又已退役 ⇒ 这条归档查不到来源、回滚不了。
            //   现在最坏情形是「日志有 moved、审计缺行」，readAudit 会并 moved 兜住。
            if (!appendLog(deps.root, [{ txn, seq: logSeq++, phase: 'step', at: now, id: m.id, action: 'moved', from: m.from, to: m.to, why: m.reason }]).ok)
                logWriteFailed = true;
            fs.appendFileSync(auditPath, JSON.stringify({ batch, id: m.id, from: m.from, to: m.to, fresh: m.fresh, at: now, reason: m.reason }) + '\n', 'utf-8');
            // 【G3】后置校验：搬完立刻回查索引真值，⛔ 不符即抛（静默漂移比搬运失败更坏）
            if (deps.readLayer) {
                const actual = deps.readLayer(m.id);
                if (actual !== m.to) {
                    throw new Error(`[G3] 搬运后置校验失败：${m.id} 期望 layer=${m.to}，索引实际为 ${actual ?? '(查不到)'}`);
                }
            }
        }
    }
    finally {
        // 状态：**无论成败都推进**。失败也推进是刻意的——否则同一天/每次启动都会把同一批重来一遍，
        // 而每重来一次就再搬走几条（那才是真正的滚雪球）。代价只是"这次失败要等下一次扫描"。
        // 读旧状态再合并：⛔ 不覆盖既有字段（尤其 `lastDayKey` 在 `force` 时不许动）。
        try {
            const prev = readSweepStateCompat(deps.root);
            // ⛔ `force` 不推进 `lastDayKey`：强制跑不许占掉当天自动扫描的额度（见函数头注释）。
            //    非强制跑：写今天。**这次是"真实扫过"这个事实的落盘**，与 `sweepDecision` 同源同名。
            // ⛔ force **不推进** `lastAutoAt`（不占当天额度）；非强制跑才写"今天自动扫过了"
            const lastAutoAt = forced ? (prev?.lastAutoAt ?? 0) : now;
            commitAutoAt = lastAutoAt; // ⭐【步④a】带进日志的 commit 记录（闸门的同日判据靠它）
            const next = {
                lastAt: now,
                lastCount: archived.length,
                lastBatch: batch,
                lastAutoAt,
                // ⚠️ `lastDayKey` 是**从 `lastAutoAt` 现算**的对账面，不是"这次扫描的日期"——
                //    否则 force 一次就会把它写成今天，让它对"上次自动扫描是哪天"撒谎（回归测试当场红过）。
                lastDayKey: lastAutoAt > 0 ? dayKey(new Date(lastAutoAt)) : '',
            };
            atomicWrite(path.join(deps.root, SWEEP_STATE_FILE), JSON.stringify(next, null, 2));
        }
        catch (e) {
            // 【F3】写失败必须传出去（修前：`onStateWriteFail` 全仓零调用方 ⇒ 异常被静默吞掉）
            stateWriteFailed = true;
            deps.onStateWriteFail?.(e);
        }
    }
    // ⭐【L4 步②·双写】批次结束 ⇒ 落 `commit`（**"这批成了"的唯一凭据**；
    //   ⛔ 没有 commit 的批次 = 崩在中途，`replay` 会把它标进 `incompleteTxns`）
    if (!appendLog(deps.root, [{ txn, seq: logSeq++, phase: 'commit', at: now, moved: archived.length, blocked: plan.blocked.length, archived: [...archived], lastAutoAt: commitAutoAt }]).ok)
        logWriteFailed = true;
    return {
        ran: true, archived, blocked: plan.blocked.length, forced,
        blockedByClass: plan.classes,
        ...(intentFailures.length ? { intentFailures } : {}),
        ...(stateWriteFailed ? { stateWriteFailed: true } : {}),
        // ⭐【步④c-α】日志写失败 —— 停写之后它是**唯一真源** ⇒ 这个信号必须能传出去
        ...(logWriteFailed ? { logWriteFailed: true } : {}),
        ...(deps.readLayer ? { verified: true } : {}),
    };
}
/** 回滚**最近一批**：按审计反向搬回（⛔ 只动层，不碰 status / 正文）*/
/**
 * **回滚目标层的白名单**（2026-10-14 对抗验证 C 修）。
 *
 * ⛔ 修前 `relocate(r.id, r.from as 'longterm', …)` 里那句 `as` 是**类型断言、不是校验**：
 * 审计行是**旁挂文件**，任何人都能写。实测两个后果：
 *   · 伪造 `from:"hot"` ⇒ 把一个**根本没降层**的活条目搬进 `hot`（= 进系统提示词）
 *   · `from:"longterm "`（多一个空格）⇒ 非法 layer 写进索引 ⇒ **下次加载容器直接抛**
 * ⇒ 衰减流水线**只有一种跃迁**（longterm → archive），回滚只可能回到 `longterm`。
 *   别的值一律**拒绝执行**（并如实报出来），⛔ 不许拿断言当护栏。
 */
const ROLLBACK_TARGETS = new Set(['longterm']);
/**
 * **回滚指定批次**（2026-10-14 新增 · 作者 拍「干吧」）。
 *
 * ## 为什么必须有它（我列过的第 4 条架构债）
 * 修前只有 `rollbackLastBatch`，写死"最近一批" ⇒ 一旦新扫描产生下一批，
 * **更早的批次就永远撤不了**。而 G1 自愈补写回来的记录**恰恰属于老批次**
 * ⇒ G1 的承诺只兑现一半：**找得到、动不了**。这个函数把那一半补上。
 *
 * ## 顺带修的同类问题：逐条落标记
 * 修前是"整批 relocate 完 → 一次性写标记" ⇒ 中途失败就**半程执行**：
 * 撤了一半、标记一条没落 ⇒ 重试时已撤的条目再撤一次 ⇒ 撞「已在 longterm 层」⇒ **永久 500**。
 * 改成**每撤一条立刻落它的标记**（与扫描侧同一套纪律：逐条落审计，不许等整批）。
 * 代价：撤 20 条 = 20 次 append。换来"任何时刻中断，重试都能接着撤"。
 */
function rollbackBatchLocked(deps) {
    const all = readAudit(deps.root);
    const batchId = deps.batch;
    if (!batchId)
        return { rolledBack: [], reason: '没有指定批次' };
    /**
     * ⚠️ 审计的设计是**只追加**：回滚不改写原行，而是**再追加一行带 `rolledBack: true` 的同 id 记录**。
     * 所以"这一批撤没撤"**不能看"有没有标记行"**，必须**按 id 算剩余**：
     *   · 有标记行 ⇒ 那个 id 撤过了
     *   · 没标记行的 id ⇒ 还没撤 ⇒ 继续撤
     * ⛔ 修前写成"有任一标记行就整批拒收" ⇒ 半程中断之后**永远拒绝重试**（另一半永远撤不回来）。
     */
    const rolledIds = new Set(all.filter((r) => r.batch === batchId && r.rolledBack).map((r) => r.id));
    /**
     * ⛔ **按 id 去重**（对抗验证 C：同一个 `(batch,id)` 有两行时，`remaining` 会有两条
     * ⇒ 第一条撤完，第二条再撤撞「已在 longterm 层」⇒ 半程 + 500）。同一 id 只撤一次。
     */
    const seen = new Set();
    const remaining = all.filter((r) => {
        if (r.batch !== batchId || r.rolledBack || rolledIds.has(r.id) || seen.has(r.id))
            return false;
        seen.add(r.id);
        return true;
    });
    if (!remaining.length) {
        const known = all.some((r) => r.batch === batchId);
        return { rolledBack: [], batch: batchId, reason: known ? '这一批已经撤过了（空操作）' : `审计里找不到这一批：${batchId}` };
    }
    // 【C1】先过一遍白名单：不合规的行**不执行**，如实报出来
    const rejected = remaining.filter((r) => !ROLLBACK_TARGETS.has(String(r.from)));
    const rows = remaining.filter((r) => ROLLBACK_TARGETS.has(String(r.from)));
    if (!rows.length) {
        return { rolledBack: [], batch: batchId, reason: `这一批的 ${remaining.length} 行**回滚目标层都不合规**（审计被篡改或格式异常）：${[...new Set(remaining.map((r) => String(r.from)))].join(' / ')}` };
    }
    const now = deps.now ?? Date.now();
    const auditPath = path.join(deps.root, AUDIT_FILE);
    const done = [];
    const skipped = [];
    // 每个条目独立提交一个回滚事务：中途失败时，已完成的条目仍有可信提交，
    // 未完成的条目可在重试时依据 readLayer 幂等补齐。
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        let currentLayer;
        if (deps.readLayer) {
            currentLayer = deps.readLayer(r.id);
            if (currentLayer === undefined) {
                skipped.push(r.id);
                continue;
            }
        }
        const logBefore = readLog(deps.root);
        const rollbackTxn = `rollback-${batchId}-${now}-${logBefore.records.length}-${i}`;
        if (!appendLog(deps.root, [{ txn: rollbackTxn, seq: 0, phase: 'begin', at: now }]).ok) {
            return { rolledBack: done, batch: batchId, reason: `无法为 ${r.id} 写入回滚事务 begin；未继续执行` };
        }
        if (currentLayer !== 'longterm') {
            try {
                deps.relocate(r.id, 'longterm', { operator: 'decay-rollback', reason: `回滚 ${r.batch}（自动降层撤销）` });
            }
            catch (error) {
                // 普通异常明确 abort；若进程被强杀，则保留 incomplete begin 供启动诊断。
                appendLog(deps.root, [{
                        txn: rollbackTxn, seq: 1, phase: 'abort', at: now,
                        reason: `回滚 ${r.id} 失败：${String(error).slice(0, 160)}`,
                    }]);
                throw error;
            }
            done.push(r.id);
        }
        else {
            // 已经回到目标层：通过可信事务补记，不重复搬运。
            skipped.push(r.id);
        }
        const committed = appendLog(deps.root, [{
                txn: rollbackTxn, seq: 1, phase: 'commit', at: now,
                rollbackOf: batchId, rolledBackIds: [r.id],
            }]);
        if (!committed.ok) {
            return { rolledBack: done, batch: batchId, reason: `条目 ${r.id} 已回到目标层，但可信回滚提交未能落盘；请检查容器层状态后重试` };
        }
        // 审计文件只作为投影写入；即使这里写失败，readAudit 也会从已提交事务重建。
        try {
            fs.appendFileSync(auditPath, JSON.stringify({
                ...r, at: now, rolledBack: true, rollbackTxn,
                reason: `回滚 ${batchId}`,
            }) + '\n', 'utf-8');
        }
        catch { /* trusted sweep-log commit is authoritative; projection is rebuildable */ }
    }
    const st = readSweepStateCompat(deps.root);
    // ⛔ 只把 `lastCount` 归零，**不许**动 `lastDayKey`/`lastAutoAt`（回滚的是"层"，不是"今天扫过没有"）
    if (st)
        atomicWrite(path.join(deps.root, SWEEP_STATE_FILE), JSON.stringify({ ...st, lastCount: 0 }, null, 2));
    return {
        rolledBack: done, batch: batchId,
        // 如实回报：跳过/拒绝的都要说得出（⛔ 静默跳过 = 换个地方藏问题）
        ...(skipped.length ? { skipped } : {}),
        ...(rejected.length ? { rejected: rejected.map((r) => `${r.id}:from=${String(r.from)}`) } : {}),
    };
}
/**
 * 回滚也走 `.sweep.lock`：手动回滚与启动/手动扫描不许交错。
 * rollbackLastBatch 内部调用本函数；两者都不嵌套持锁。
 */
export function rollbackBatch(deps) {
    const lock = acquireWriteLock(deps.root, {
        lockFile: '.sweep.lock',
        holder: 'rollback',
        staleMs: 10 * 60_000,
        retry: { attempts: 1, budgetMs: 0 },
    });
    try {
        return rollbackBatchLocked(deps);
    }
    finally {
        lock.release();
    }
}
/**
 * 回滚**最近一批**。身份由 `.decay-sweep.json` 的 `lastBatch` 决定，⛔ 不由"审计文件末行"决定。
 *
 * 【对抗验证 4.4】修前用 `all.filter(!rolledBack).at(-1)` ⇒ 谁最后被追加谁就是"最近一批"：
 *   G1 自愈补写一行**老批次**的审计后，它就抢走这个身份 ⇒ 撤销去撤老批次，
 *   而 `/decay-state` 显示的仍是 `state.lastBatch` ⇒ **显示与动作脱钩**。
 * 修后：先认 state（权威），state 读不到才退回"最新的非自愈行"。
 */
export function rollbackLastBatch(deps) {
    const all = readAudit(deps.root);
    if (!all.filter((r) => !r.rolledBack).length)
        return { rolledBack: [] };
    const st = readSweepStateCompat(deps.root);
    const fromState = st?.lastBatch ? all.filter((r) => r.batch === st.lastBatch && !r.rolledBack) : [];
    const pool = fromState.length ? fromState : all.filter((r) => !r.rolledBack && !r.healed);
    const chosen = pool.at(-1) ?? all.filter((r) => !r.rolledBack).at(-1);
    if (!chosen)
        return { rolledBack: [] };
    return rollbackBatch({ ...deps, batch: chosen.batch });
}
/** 列出**可回滚的批次**（人要知道"还有哪些能撤"）—— 只读 */
export function listRollbackBatches(root) {
    /**
     * 【2026-10-14 性能修 · 并且更正一处**我自己的错误归因**】
     *
     * 修前是"先取出所有批号，再对**每个批号**扫一遍全部行" ⇒ **O(批数 × 行数) = 平方级**。
     * 实测：1000 批 10ms、10000 批 **547ms**、30000 批 **4127ms** ——
     * 而它挂在**活端点** `GET /decay-batches` 上 ⇒ 一个 4 秒的 HTTP 请求。
     *
     * ⚠️ 我一开始把这条债归因到"意图日志不轮转"，**那是错的**：
     *    这个函数读的是**审计**（`.decay-audit.jsonl`），跟意图日志无关
     *    ⇒ 轮转能把意图文件从 3.8MB 清到 0，但对它**一点帮助都没有**。
     *    靠实测才发现归因错了（107ms vs 4127ms，量级差 40 倍）。
     *
     * 修法：**一趟扫完**（按批号分组，行内维护"见过谁/撤过谁"）⇒ O(行数)。
     */
    const byBatch = new Map();
    for (const r of readAudit(root)) {
        if (!r.batch)
            continue;
        let e = byBatch.get(r.batch);
        if (!e) {
            e = { ids: new Set(), rolled: new Set(), healed: false };
            byBatch.set(r.batch, e);
        }
        if (r.rolledBack)
            e.rolled.add(r.id);
        else {
            e.ids.add(r.id);
            if (r.healed)
                e.healed = true;
        }
    }
    const out = [];
    for (const [batch, e] of byBatch) {
        // ⛔ 同 rollbackBatch 的口径：**按 id 算剩余**（不能看"有没有标记行"）
        let remaining = 0;
        for (const id of e.ids)
            if (!e.rolled.has(id))
                remaining++;
        out.push({ batch, count: remaining, rolledBack: remaining === 0, healed: e.healed });
    }
    return out.sort((a, b) => (a.batch < b.batch ? 1 : -1));
}
/**
 * 【启动/手动/定时共用 · 2026-10-26】扫描级互斥：同一容器同一时刻只允许一个 runDueSweep。
 * 修前 concurrent startup 会各写一条 begin/commit（10-24 实证：同一 txn 两条空 commit），
 * 搬空条目时看不出，真到 due 就可能双账。锁拿不到直接 LOCK_BUSY（不排队），由调用方记日志。
 */
export function runDueSweep(deps) {
    const lock = acquireWriteLock(deps.root, {
        lockFile: '.sweep.lock',
        holder: 'sweep',
        staleMs: 10 * 60_000,
        retry: { attempts: 1, budgetMs: 0 },
    });
    try {
        return runDueSweepLocked(deps);
    }
    finally {
        lock.release();
    }
}
/**
 * 手动/强制扫描的同一把 `.sweep.lock`：force 也不能绕过单生产者。
 * runDueSweep 内部调用 runSweepLocked，避免自己锁自己。
 */
export function runSweep(deps) {
    const lock = acquireWriteLock(deps.root, {
        lockFile: '.sweep.lock',
        holder: 'sweep-manual',
        staleMs: 10 * 60_000,
        retry: { attempts: 1, budgetMs: 0 },
    });
    try {
        return runSweepLocked(deps);
    }
    finally {
        lock.release();
    }
}
