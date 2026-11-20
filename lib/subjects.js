/**
 * ── 【P2 · 2026-10-18】subject 结构表（只写不读）────────────────────
 *
 * 一句话：**切口处建会话 subject，写进 subjects/；索引带 count+sha256 自校验。**
 * 设计口径见研究记录 §13.6：环 = 父链上的子 subject；对话 = 项目链上的一环。
 *
 * ⛔ P2 阶段**只记录、不驱动任何判定**；`about[]` 只标次事，不刷时间。
 * ⛔ 表头自校验（count + sha256）：表坏了要能当场发现，不许静默读成空表。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { normalizeForMatch } from './session-buffer.js';
import { acquireWriteLock } from './lock.js';
const ROOT_ID = 'root-me';
/** 【B6】原子写：tmp + rename（写一半被杀也不会留下截断文件） */
function atomicWrite(file, text) {
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, text, 'utf-8');
    fs.renameSync(tmp, file);
}
const SYSTEM_ID = 'sys-default';
const PROJECT_ID = 'proj-unfiled';
function sha256Of(subjects) {
    return createHash('sha256').update(JSON.stringify(subjects)).digest('hex').slice(0, 32);
}
function iso(now = Date.now()) { return new Date(now).toISOString(); }
/** 与条目写事务分开的锁文件（subjects 是另一份资源） */
const SUBJECTS_LOCK_FILE = '.subjects.lock';
/** 切口首句 → 临时名字（只记录；正式命名由后续人工/模型补） */
export function provisionalName(text) {
    const clean = text.replace(/\s+/g, ' ').trim();
    return clean.slice(0, 24) || '未命名会话';
}
export class SubjectStore {
    root;
    dir;
    indexFile;
    byId = new Map();
    bySession = new Map();
    /** 本实例删过的 id：save 合并磁盘时必须跳过（防复活） */
    removed = new Set();
    log;
    constructor(root, options = {}) {
        this.root = root;
        this.dir = path.join(root, 'subjects');
        this.indexFile = path.join(this.dir, 'index.json');
        this.log = options.log ?? { error: () => { } };
        this.load();
    }
    load() {
        let raw = null;
        try {
            raw = fs.readFileSync(this.indexFile, 'utf-8');
            const data = JSON.parse(raw);
            if (data?.version === 1 && Array.isArray(data.subjects)) {
                if (data.count !== data.subjects.length || data.sha256 !== sha256Of(data.subjects)) {
                    throw new Error('自校验失败（count/sha256 不符）');
                }
                for (const s of data.subjects) {
                    this.byId.set(s.id, s);
                    if (s.session_id)
                        this.bySession.set(s.session_id, s.id);
                }
                // 【并发修复 · 2026-10-19】index 合法 ≠ 没丢：s4 实测 24 个会话 md 在、索引少 4 个，
                // 而索引自校验仍通过。加载时按 md 补齐缺失的会话，重启即可自愈；补到就落盘。
                const healed = this.reconcileFromFiles();
                if (healed > 0) {
                    this.log.warn?.(`[subjects] 索引缺 ${healed} 个会话 md，已按文件补回`);
                    this.save();
                }
                return;
            }
            throw new Error('index 版本或结构不符');
        }
        catch (e) {
            // 【B6】坏表：隔离原文件 → 从 subjects/*.md 重建；⛔ 不许静默 seed 覆盖
            if (raw !== null) {
                try {
                    fs.renameSync(this.indexFile, `${this.indexFile}.corrupt-${Date.now()}`);
                }
                catch { /* 隔离失败也继续重建 */ }
            }
            const rebuilt = this.rebuildFromFiles();
            if (rebuilt > 0) {
                this.save();
                return;
            }
            this.seed();
        }
    }
    /** 【B6】从 subjects/*.md 的 frontmatter 重建索引（解析坏的文件跳过并告警） */
    rebuildFromFiles() {
        let files = [];
        try {
            files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.md'));
        }
        catch {
            return 0;
        }
        let n = 0;
        for (const f of files) {
            try {
                const text = fs.readFileSync(path.join(this.dir, f), 'utf-8');
                const m = text.match(/^---\n([\s\S]*?)\n---/);
                if (!m)
                    continue;
                const kv = {};
                for (const line of m[1].split('\n')) {
                    const i = line.indexOf(':');
                    if (i > 0)
                        kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
                }
                if (!kv.id || !kv.kind)
                    continue;
                const rec = {
                    id: kv.id,
                    name: kv.name || kv.id,
                    aliases: [],
                    kind: kv.kind,
                    parent: kv.parent || null,
                    ...(kv.session_id ? { session_id: kv.session_id } : {}),
                    ...(kv.transcript_ref ? { transcript_ref: kv.transcript_ref } : {}),
                    created_at: kv.created_at || new Date(0).toISOString(),
                    last_grown: kv.last_grown || kv.created_at || new Date(0).toISOString(),
                    last_activated: kv.last_activated || kv.created_at || new Date(0).toISOString(),
                };
                this.byId.set(rec.id, rec);
                if (rec.session_id)
                    this.bySession.set(rec.session_id, rec.id);
                n++;
            }
            catch { /* 单文件坏跳过 */ }
        }
        return n;
    }
    /**
     * 把 `subjects/*.md` 里存在、但索引没有的记录补回内存（只补缺，不改已有字段）。
     * ⛔ 已 remove 的 id 跳过（防复活）；返回补回条数。
     */
    reconcileFromFiles() {
        let files = [];
        try {
            files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.md'));
        }
        catch {
            return 0;
        }
        let n = 0;
        for (const f of files) {
            try {
                const text = fs.readFileSync(path.join(this.dir, f), 'utf-8');
                const m = text.match(/^---\n([\s\S]*?)\n---/);
                if (!m)
                    continue;
                const kv = {};
                for (const line of m[1].split('\n')) {
                    const i = line.indexOf(':');
                    if (i > 0)
                        kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
                }
                if (!kv.id || !kv.kind || this.removed.has(kv.id) || this.byId.has(kv.id))
                    continue;
                const rec = {
                    id: kv.id,
                    name: kv.name || kv.id,
                    aliases: [],
                    kind: kv.kind,
                    parent: kv.parent || null,
                    ...(kv.session_id ? { session_id: kv.session_id } : {}),
                    ...(kv.transcript_ref ? { transcript_ref: kv.transcript_ref } : {}),
                    created_at: kv.created_at || new Date(0).toISOString(),
                    last_grown: kv.last_grown || kv.created_at || new Date(0).toISOString(),
                    last_activated: kv.last_activated || kv.created_at || new Date(0).toISOString(),
                };
                this.byId.set(rec.id, rec);
                if (rec.session_id)
                    this.bySession.set(rec.session_id, rec.id);
                n++;
            }
            catch { /* 单文件坏跳过 */ }
        }
        return n;
    }
    seed() {
        const now = iso();
        const seeds = [
            { id: ROOT_ID, name: '我', aliases: [], kind: 'root', parent: null, created_at: now, last_grown: now, last_activated: now },
            { id: SYSTEM_ID, name: '记忆系统', aliases: ['Memory', '记忆'], kind: 'system', parent: ROOT_ID, created_at: now, last_grown: now, last_activated: now },
            { id: PROJECT_ID, name: '未归属项目', aliases: [], kind: 'project', parent: SYSTEM_ID, created_at: now, last_grown: now, last_activated: now },
        ];
        for (const s of seeds) {
            this.byId.set(s.id, s);
            this.writeFile(s, '');
        }
        this.save();
    }
    writeFile(s, body) {
        try {
            fs.mkdirSync(this.dir, { recursive: true });
            const fm = [
                '---',
                `id: ${s.id}`,
                `name: ${s.name}`,
                `kind: ${s.kind}`,
                `parent: ${s.parent ?? ''}`,
                ...(s.session_id ? [`session_id: ${s.session_id}`] : []),
                ...(s.transcript_ref ? [`transcript_ref: ${s.transcript_ref}`] : []),
                `created_at: ${s.created_at}`,
                `last_grown: ${s.last_grown}`,
                `last_activated: ${s.last_activated}`,
                '---',
                '',
                body,
            ].join('\n');
            atomicWrite(path.join(this.dir, `${s.id}.md`), fm);
        }
        catch { /* 写不进去也不能拖垮会话 */ }
    }
    /**
     * 落盘。**锁内**重读合并再写（s4 实测：只“写前重读”不互斥，4 进程仍丢 4/24）。
     * 锁失败不写（内存与 md 都还在，下次重试/重启 reconcile 兜底），并报 error，不静默。
     */
    save() {
        let lock;
        try {
            lock = acquireWriteLock(this.root, {
                lockFile: SUBJECTS_LOCK_FILE,
                holder: 'subjects',
                staleMs: 10_000,
                retry: { attempts: 10, budgetMs: 1_500 },
            });
        }
        catch (e) {
            this.log.error(`[subjects] 索引写锁获取失败（本次不落盘；内存/md 保留）：${e instanceof Error ? e.message : String(e)}`);
            return false;
        }
        try {
            // 锁内重读：锁外读到的那份可能已被别的进程改过
            try {
                const disk = JSON.parse(fs.readFileSync(this.indexFile, 'utf-8'));
                if (disk?.version === 1 && Array.isArray(disk.subjects)) {
                    for (const s of disk.subjects) {
                        if (this.removed.has(s.id) || this.byId.has(s.id))
                            continue;
                        this.byId.set(s.id, s);
                        if (s.session_id)
                            this.bySession.set(s.session_id, s.id);
                    }
                }
            }
            catch { /* 盘上无/坏：按内存写，后续 rebuild 会兜底 */ }
            const subjects = [...this.byId.values()];
            const data = { version: 1, count: subjects.length, sha256: sha256Of(subjects), subjects };
            fs.mkdirSync(this.dir, { recursive: true });
            atomicWrite(this.indexFile, JSON.stringify(data, null, 2));
            return true;
        }
        catch (e) {
            this.log.error(`[subjects] 索引落盘失败：${e instanceof Error ? e.message : String(e)}`);
            return false;
        }
        finally {
            lock.release();
        }
    }
    /** 切口：会话首条真人消息 ⇒ 建会话 subject（只建一次） */
    openConversation(sessionId, text) {
        if (!sessionId)
            return null;
        const exists = this.bySession.get(sessionId);
        if (exists)
            return exists;
        const now = iso();
        const id = `conv-${createHash('sha256').update(sessionId).digest('hex').slice(0, 10)}`;
        const rec = {
            id,
            name: provisionalName(text),
            aliases: [],
            kind: 'conversation',
            parent: PROJECT_ID,
            session_id: sessionId,
            transcript_ref: `transcripts/${sessionId}.md`,
            created_at: now,
            last_grown: now,
            last_activated: now,
        };
        this.byId.set(id, rec);
        this.bySession.set(sessionId, id);
        this.writeFile(rec, text.trim().slice(0, 500));
        this.save();
        return id;
    }
    /**
     * 【P3】认亲：在文本里找 subject 名字/别名（**不传递闭包**，只做一跳）。
     * · 同名多命中 ⇒ 按 `last_activated` 最近者胜（同名最近活跃裁决）；
     * · root/system 不参与（“我”“记忆系统”出现在几乎每句话里，不是认亲信号）。
     */
    scan(text, mainId, excludeId) {
        const norm = normalizeForMatch(text);
        if (!norm)
            return [];
        const hits = new Map();
        for (const s of this.byId.values()) {
            if (s.kind === 'root' || s.kind === 'system')
                continue;
            // 【B2/自匹配】当前会话自己的 subject 不算“提及”（名字就是开场白，必自指）
            if (excludeId && s.id === excludeId)
                continue;
            const names = [s.name, ...s.aliases].filter((n) => n && n.trim().length >= 2);
            for (const n of names) {
                const nn = normalizeForMatch(n);
                if (nn && norm.includes(nn)) {
                    const cur = hits.get(s.id);
                    if (!cur)
                        hits.set(s.id, { id: s.id, name: s.name, matched: n, primary: s.id === (mainId ?? null) });
                    break;
                }
            }
        }
        // 同名最近活跃裁决：同一 name 只留 last_activated 最新的一条
        const byName = new Map();
        for (const h of hits.values()) {
            const prev = byName.get(h.name);
            if (!prev) {
                byName.set(h.name, h);
                continue;
            }
            const a = this.byId.get(h.id)?.last_activated ?? '';
            const b = this.byId.get(prev.id)?.last_activated ?? '';
            if (a > b)
                byName.set(h.name, h);
        }
        return [...byName.values()];
    }
    /** 【P3】更新活跃时间（人工提及才刷新；P3 只记 mention，不驱动判定） */
    touchActivated(id, at = iso()) {
        const s = this.byId.get(id);
        if (!s)
            return;
        s.last_activated = at;
        this.save(); // 【B2】内存改了必须落盘，否则重启丢提及、selfCheck 必报不一致
    }
    /** 回填用：设置 last_grown/last_activated 并落盘（不碰名字/父链） */
    setLastGrown(id, iso) {
        const s = this.byId.get(id);
        if (!s || !iso)
            return false;
        s.last_grown = iso;
        s.last_activated = iso;
        this.writeFile(s, '');
        this.save();
        return true;
    }
    mainSubjectOf(sessionId) {
        return this.bySession.get(sessionId) ?? null;
    }
    /** 删除（冒烟/误建清理；⛔ 不用于正常遗忘——那由 §13 的公示制走） */
    remove(id) {
        const rec = this.byId.get(id);
        if (!rec)
            return false;
        this.byId.delete(id);
        this.removed.add(id);
        if (rec.session_id)
            this.bySession.delete(rec.session_id);
        try {
            fs.rmSync(path.join(this.dir, `${id}.md`), { force: true });
        }
        catch { /* 文件不在也无妨 */ }
        this.save();
        return true;
    }
    get(id) {
        return this.byId.get(id);
    }
    list() {
        return [...this.byId.values()];
    }
    /**
     * 自检：索引 sha 对上 + **会话 md 与索引一致**。
     * 【并发修复 · 2026-10-19】修前只比内存↔索引 ⇒ 索引丢 4 个会话仍 ok:true（s4 实测假绿）。
     */
    selfCheck() {
        const subjects = [...this.byId.values()];
        const data = { version: 1, count: subjects.length, sha256: sha256Of(subjects), subjects };
        let mdOrphans = 0;
        try {
            let files = [];
            try {
                files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.md'));
            }
            catch { /* no dir */ }
            for (const f of files) {
                try {
                    const text = fs.readFileSync(path.join(this.dir, f), 'utf-8');
                    const m = text.match(/^---\n([\s\S]*?)\n---/);
                    if (!m)
                        continue;
                    const kv = {};
                    for (const line of m[1].split('\n')) {
                        const i = line.indexOf(':');
                        if (i > 0)
                            kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
                    }
                    if (kv.kind === 'conversation' && kv.session_id && !this.byId.has(kv.id))
                        mdOrphans++;
                }
                catch {
                    mdOrphans++;
                }
            }
        }
        catch { /* skip */ }
        try {
            const disk = JSON.parse(fs.readFileSync(this.indexFile, 'utf-8'));
            const ok = disk.count === data.count && disk.sha256 === data.sha256 && mdOrphans === 0;
            const note = ok ? undefined : (mdOrphans ? `md 有 ${mdOrphans} 个会话未进索引` : 'disk 与内存不一致');
            return { ok, count: data.count, sha256: data.sha256, mdOrphans, ...(note ? { note } : {}) };
        }
        catch (e) {
            return { ok: false, count: data.count, sha256: data.sha256, mdOrphans, note: e instanceof Error ? e.message : String(e) };
        }
    }
}
/** 【P3】疑问式判定：疑问式算 1 次提及（不是 2 次） */
export function isQuestionForm(text) {
    return /[?？]|吗|呢|怎么|为什么|如何|哪|是不是|有没有/.test(text);
}
