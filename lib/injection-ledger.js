import fs from 'node:fs';
export class InjectionLedger {
    filePath;
    buffer = [];
    flushed = 0;
    /**
     * 去重窗口。分两种：
     *   · **有轮次号**：一个窗口 = `(session, turn)`，两个面共用（同一轮里谁投的都算同一轮）；
     *   · **无轮次号**（退化）：**按面各自维护**一个窗口，窗口键 = 该面这一次的集合指纹。
     * ⛔ 退化路径的边界如实写下：两个面交替投递时，某一面的窗口会被另一面顶掉 ⇒ 可能多记一次。
     *    实践中宿主给了轮次号，退化路径只在拿不到时用。
     */
    turnWindow = null;
    setWindows = {
        hot: { key: '', counted: new Set() },
        route: { key: '', counted: new Set() },
    };
    lastEvent = null;
    /**
     * 每条目**最近一次被投递**的记录（供 `clock.elapsed` 用）。
     * 口径：只记 **route 面**（面① 不计唤起 ⇒ 它不该推进"上次被想起"）。
     */
    lastRoute = new Map();
    constructor(filePath = null) {
        this.filePath = filePath;
    }
    /**
     * 记一次投递。返回**本次应当计入"唤起"的 id**（调用方据此推进 `last_accessed`）。
     *
     * 去重口径：
     *   · 有 `turn` ⇒ 按 `(session, turn, id)` 去重 —— 同一轮里宿主装配 N 次，只算 1 次；
     *   · 没有 `turn`（宿主未提供）⇒ 退化为"**集合变了才算一次**"，
     *     并在事件里如实缺省 turn（⛔ 不许拿时间戳假装是轮次）。
     */
    recordDelivery(input) {
        const ids = [...new Set(input.ids)].sort();
        if (ids.length === 0)
            return { touchIds: [] };
        const at = (input.at ?? new Date()).toISOString();
        // 选窗口：有轮次号用 (session, turn)；没有则退化为"该面这一次的集合指纹"
        let window;
        if (input.turn !== undefined) {
            const key = `${input.sessionId ?? ''}|${input.turn}`;
            if (this.turnWindow?.key !== key)
                this.turnWindow = { key, counted: new Set() };
            window = this.turnWindow;
        }
        else {
            const key = `${input.face}|${ids.join(',')}`;
            if (this.setWindows[input.face].key !== key)
                this.setWindows[input.face] = { key, counted: new Set() };
            window = this.setWindows[input.face];
        }
        // 面① 如实记录，但不计唤起（理由见文件头：名单每轮必投 + fresh 对它无意义）
        const touchIds = [];
        for (const id of ids) {
            if (window.counted.has(id))
                continue;
            window.counted.add(id);
            if (input.face === 'route')
                touchIds.push(id);
        }
        const event = { at, face: input.face, ids };
        if (input.sessionId)
            event.session = input.sessionId;
        if (input.turn !== undefined)
            event.turn = input.turn;
        if (input.face === 'route') {
            const rec = { session: input.sessionId, turn: input.turn, at };
            for (const id of ids)
                this.lastRoute.set(id, rec);
        }
        this.buffer.push(event);
        this.lastEvent = event;
        return { touchIds };
    }
    /** 把缓冲的事件**追加**落盘（JSONL，一行一事件）。返回写入条数。 */
    flush() {
        if (this.buffer.length === 0)
            return 0;
        if (this.filePath === null) {
            // 无落盘路径（测试/只读装配）：缓冲清掉但计数保留，⛔ 不假装写过盘
            this.flushed += 0;
            this.buffer = [];
            return 0;
        }
        const lines = this.buffer.map((e) => JSON.stringify(e)).join('\n') + '\n';
        fs.appendFileSync(this.filePath, lines, 'utf-8');
        const n = this.buffer.length;
        this.buffer = [];
        this.flushed += n;
        return n;
    }
    /**
     * ⭐【2026-10-17】**每条被投递过几次**（面①+面② 都算"被投递"）。
     *
     * ## 为什么要它（真身事故的止血）
     * 衰减判据的第一排序键是 `access_count`，而 `count=0` 有两种含义被混成一种：
     *   · **刚写、从没被投递过** ⇒ 没机会被用 ⇒ 信息为零
     *   · **投递过、之后再没被用** ⇒ 试过了 ⇒ 真信号
     * 首扫（10-17 00:03）就因此吃了三条最新记录。判据需要"有没有给过机会"这个量。
     *
     * ## 口径边界（如实写）
     * · **面①（hot）也算"被投递"**：本条测的是"有没有给过机会"，不是"算不算唤起"——
     *   唤起口径仍然是面②专用（`lastDeliveryOf` / `touchIds`），两者**刻意不同**。
     * · 数据源 = 落盘文件 + 内存缓冲；坏行跳过（⛔ 不因一行坏字节让整份判空）。
     */
    deliveredCounts() {
        const out = new Map();
        const add = (ids) => {
            if (!Array.isArray(ids))
                return;
            for (const id of ids) {
                if (typeof id !== 'string' || !id)
                    continue;
                out.set(id, (out.get(id) ?? 0) + 1);
            }
        };
        if (this.filePath) {
            try {
                for (const line of fs.readFileSync(this.filePath, 'utf-8').split('\n')) {
                    if (!line.trim())
                        continue;
                    try {
                        add(JSON.parse(line).ids);
                    }
                    catch { /* 坏行跳过 */ }
                }
            }
            catch { /* 文件不存在 ⇒ 只有内存里的那点 */ }
        }
        for (const e of this.buffer)
            add(e.ids);
        return out;
    }
    /** 某条目最近一次**被投递**（route 面）的记录；没有则 null。 */
    lastDeliveryOf(id) {
        return this.lastRoute.get(id) ?? null;
    }
    snapshot() {
        return {
            events: this.flushed + this.buffer.length,
            flushed: this.flushed,
            buffered: this.buffer.length,
            last: this.lastEvent,
            countedThisTurn: this.turnWindow?.counted.size ?? 0,
        };
    }
}
