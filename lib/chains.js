/**
 * Breathe · 手动记忆链注册表
 *
 * 独立资源：chains.json / .manual-chains-audit.jsonl / .chains.lock。
 * 不触碰记忆正文、层、写入事务或衰减状态。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { acquireWriteLock } from './lock.js';
export class ChainRegistryError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'ChainRegistryError';
    }
}
const REGISTRY_FILE = 'chains.json';
const AUDIT_FILE = '.manual-chains-audit.jsonl';
const LOCK_FILE = '.chains.lock';
const PENDING_FILE = '.chains-pending.json';
/** 旧 PROJ_GROUPS 的六个可见组。重复的「沿革」分组在这里合并。 */
const LEGACY_CHAINS = [
    // 发行版：不带任何预设链。用户首次进入自行创建，不预设分类。
];
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function nowIso() { return new Date().toISOString(); }
function norm(value) { return value.trim().toLocaleLowerCase('en-US'); }
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function slug(value) {
    const clean = value.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return clean || createHash('sha256').update(value).digest('hex').slice(0, 10);
}
function validateText(value, kind) {
    if (typeof value !== 'string')
        throw new ChainRegistryError('CHAIN_INVALID', `${kind === 'name' ? '名称' : '标签'}必须是字符串`);
    const text = value.trim();
    const max = kind === 'name' ? 40 : 32;
    if (!text || text.length > max)
        throw new ChainRegistryError('CHAIN_INVALID', `${kind === 'name' ? '名称' : '标签'}长度必须为 1–${max} 个字符`);
    if (/[\u0000-\u001f\u007f/\\<>]/.test(text))
        throw new ChainRegistryError('CHAIN_INVALID', `${kind === 'name' ? '名称' : '标签'}包含不允许的字符`);
    return text;
}
function validateRegistry(input) {
    if (!input || typeof input !== 'object')
        throw new ChainRegistryError('CHAIN_CORRUPT', 'chains.json 不是对象');
    const raw = input;
    if (raw.version !== 1 || !Array.isArray(raw.chains))
        throw new ChainRegistryError('CHAIN_CORRUPT', 'chains.json 版本或 chains 结构不合法');
    const chains = raw.chains.map((value, index) => {
        if (!value || typeof value !== 'object')
            throw new ChainRegistryError('CHAIN_CORRUPT', `chains[${index}] 不是对象`);
        const c = value;
        if (typeof c.id !== 'string' || !/^chain-[a-z0-9][a-z0-9-]{2,63}$/.test(c.id))
            throw new ChainRegistryError('CHAIN_CORRUPT', `chains[${index}].id 非法`);
        const name = validateText(c.name, 'name');
        const canonicalTag = validateText(c.canonicalTag, 'tag');
        if (!Array.isArray(c.aliases) || !c.aliases.every((a) => typeof a === 'string'))
            throw new ChainRegistryError('CHAIN_CORRUPT', `chains[${index}].aliases 非法`);
        const aliases = Array.from(new Set([canonicalTag, ...c.aliases.map((a) => validateText(a, 'tag'))]));
        if (typeof c.createdAt !== 'string' || !Number.isFinite(Date.parse(c.createdAt)) || typeof c.updatedAt !== 'string' || !Number.isFinite(Date.parse(c.updatedAt))) {
            throw new ChainRegistryError('CHAIN_CORRUPT', `chains[${index}] 时间字段非法`);
        }
        return { id: c.id, name, canonicalTag, aliases, createdAt: c.createdAt, updatedAt: c.updatedAt };
    });
    assertUnique(chains, true);
    return { version: 1, chains };
}
function assertUnique(chains, corrupt = false) {
    const names = new Set();
    const tags = new Map();
    const ids = new Set();
    const fail = (message) => {
        throw new ChainRegistryError(corrupt ? 'CHAIN_CORRUPT' : 'CHAIN_CONFLICT', message);
    };
    for (const c of chains) {
        if (ids.has(c.id))
            fail(`链 ID 冲突：${c.id}`);
        ids.add(c.id);
        const n = norm(c.name);
        if (names.has(n))
            fail(`链名称已存在：${c.name}`);
        names.add(n);
        for (const label of [c.canonicalTag, ...c.aliases]) {
            const key = norm(label);
            const owner = tags.get(key);
            if (owner && owner !== c.id)
                fail(`标签冲突：「${label}」已经属于另一条链`);
            tags.set(key, c.id);
        }
    }
}
function makeLegacyRegistry(at = nowIso()) {
    return {
        version: 1,
        chains: LEGACY_CHAINS.map((c) => ({
            id: `chain-${slug(c.name)}`,
            name: c.name,
            canonicalTag: c.canonicalTag,
            aliases: [...c.aliases],
            createdAt: at,
            updatedAt: at,
        })),
    };
}
function atomicWrite(file, text) {
    const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
    let fd;
    try {
        fd = fs.openSync(tmp, 'wx', 0o600);
        fs.writeFileSync(fd, text, 'utf-8');
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        fs.renameSync(tmp, file);
    }
    catch (error) {
        if (fd !== undefined) {
            try {
                fs.closeSync(fd);
            }
            catch { /* no-op */ }
        }
        try {
            fs.unlinkSync(tmp);
        }
        catch { /* no-op */ }
        throw error;
    }
}
function readAuditFile(root) {
    const file = path.join(root, AUDIT_FILE);
    if (!fs.existsSync(file))
        return [];
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf-8');
    }
    catch (error) {
        throw new ChainRegistryError('CHAIN_CORRUPT', `无法读取链审计日志：${String(error)}`);
    }
    const rows = [];
    const batches = new Set();
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim())
            continue;
        try {
            const row = JSON.parse(line);
            if (!row || typeof row.batch !== 'string' || !row.batch || batches.has(row.batch)
                || typeof row.at !== 'string' || !Number.isFinite(Date.parse(row.at))
                || !['migrate', 'create', 'rename', 'delete', 'rollback'].includes(row.action)
                || typeof row.id !== 'string' || !row.before || !row.after)
                throw new Error('字段不完整或 batch 重复');
            const normalized = { ...row, before: validateRegistry(row.before), after: validateRegistry(row.after) };
            if (rows.length && !same(rows[rows.length - 1].after, normalized.before))
                throw new Error('事务前后快照不连续');
            if (normalized.action === 'rollback') {
                if (typeof normalized.rollbackOf !== 'string')
                    throw new Error('rollback 缺少 rollbackOf');
                const target = rows.find((r) => r.batch === normalized.rollbackOf);
                if (!target || target.action === 'rollback' || target.id !== normalized.id
                    || !same(target.after, normalized.before) || !same(target.before, normalized.after)
                    || rows.some((r) => r.rollbackOf === normalized.rollbackOf))
                    throw new Error('rollback 与原始事务不匹配');
            }
            else if (normalized.rollbackOf !== undefined) {
                throw new Error('非 rollback 事务不允许 rollbackOf');
            }
            batches.add(normalized.batch);
            rows.push(normalized);
        }
        catch (error) {
            // 末尾的空行允许；任何非空坏行均 fail-closed，不能把坏日志当成没有历史。
            throw new ChainRegistryError('CHAIN_CORRUPT', `链审计日志第 ${i + 1} 行损坏：${error instanceof Error ? error.message : String(error)}`);
        }
    }
    return rows;
}
function appendAudit(root, row) {
    const file = path.join(root, AUDIT_FILE);
    const bytes = Buffer.from(`${JSON.stringify(row)}\n`, 'utf-8');
    let fd;
    let start = 0;
    try {
        fd = fs.openSync(file, 'a', 0o600);
        start = fs.fstatSync(fd).size;
        let offset = 0;
        while (offset < bytes.length) {
            const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
            if (written <= 0)
                throw new Error('链审计日志写入未取得进展');
            offset += written;
        }
        fs.fsyncSync(fd);
    }
    catch (error) {
        if (fd !== undefined) {
            try {
                fs.ftruncateSync(fd, start);
                fs.fsyncSync(fd);
            }
            catch (restoreError) {
                throw new ChainRegistryError('CHAIN_RECOVERY_REQUIRED', `审计追加失败且无法截断未完成尾部：${String(restoreError)}`);
            }
        }
        throw error;
    }
    finally {
        if (fd !== undefined) {
            try {
                fs.closeSync(fd);
            }
            catch { /* no-op */ }
        }
    }
}
export class ChainStore {
    root;
    registryPath;
    auditPath;
    pendingPath;
    log;
    constructor(root, options = {}) {
        this.root = root;
        this.registryPath = path.join(root, REGISTRY_FILE);
        this.auditPath = path.join(root, AUDIT_FILE);
        this.pendingPath = path.join(root, PENDING_FILE);
        this.log = options.log ?? { error: () => { } };
        fs.mkdirSync(root, { recursive: true });
        this.withLock(() => {
            this.recoverPending();
            if (!fs.existsSync(this.registryPath)) {
                const priorAudit = readAuditFile(this.root);
                if (priorAudit.length || fs.existsSync(this.auditPath)) {
                    throw new ChainRegistryError('CHAIN_CORRUPT', 'chains.json 缺失但链审计日志已存在；拒绝重新迁移或覆盖历史');
                }
                const after = makeLegacyRegistry();
                this.commitUnlocked({ version: 1, chains: [] }, after, 'migrate', 'legacy-proj-groups', false);
                this.log.info?.('[chains] 已从旧 PROJ_GROUPS 初始化 6 条手动记忆链');
            }
            else {
                const current = this.readRegistry();
                const audit = readAuditFile(this.root);
                if (!audit.length || !same(audit[audit.length - 1].after, current)) {
                    throw new ChainRegistryError('CHAIN_CORRUPT', 'chains.json 与链审计日志末尾快照不一致；拒绝继续写入');
                }
            }
        });
    }
    list() { return this.withLock(() => clone(this.readVerifiedRegistry().chains)); }
    readAudit() {
        return this.withLock(() => { this.readVerifiedRegistry(); return clone(readAuditFile(this.root)); });
    }
    resolveMatches(tags, snapshot) {
        const normalized = new Set(tags.map((t) => norm(String(t))).filter(Boolean));
        const match = (chains) => chains.filter((chain) => [chain.canonicalTag, ...chain.aliases].some((label) => normalized.has(norm(label))));
        return snapshot ? match(snapshot) : this.withLock(() => match(this.readVerifiedRegistry().chains));
    }
    assignment(tags, snapshot) { return this.resolveMatches(tags, snapshot)[0] ?? null; }
    create(nameInput, tagInput) {
        const name = validateText(nameInput, 'name');
        if (['其他', '史前/未归'].includes(name))
            throw new ChainRegistryError('CHAIN_INVALID', `「${name}」是系统保留分组名`);
        const canonicalTag = validateText(tagInput === undefined || tagInput === null || tagInput === '' ? name : tagInput, 'tag');
        const at = nowIso();
        const id = `chain-${createHash('sha256').update(`${randomUUID()}\0${name}\0${canonicalTag}`).digest('hex').slice(0, 12)}`;
        const created = { id, name, canonicalTag, aliases: [canonicalTag], createdAt: at, updatedAt: at };
        this.transact('create', id, (before) => {
            const next = [...before.chains, created];
            assertUnique(next);
            return { version: 1, chains: next };
        });
        return created;
    }
    rename(id, nameInput) {
        const name = validateText(nameInput, 'name');
        if (['其他', '史前/未归'].includes(name))
            throw new ChainRegistryError('CHAIN_INVALID', `「${name}」是系统保留分组名`);
        let renamed;
        this.transact('rename', id, (before) => {
            const index = before.chains.findIndex((c) => c.id === id);
            if (index < 0)
                throw new ChainRegistryError('CHAIN_NOT_FOUND', `链不存在：${id}`);
            const next = before.chains.map((c, i) => i === index ? { ...c, name, updatedAt: nowIso() } : c);
            assertUnique(next);
            renamed = next[index];
            return { version: 1, chains: next };
        });
        return renamed;
    }
    delete(id) {
        this.transact('delete', id, (before) => {
            if (!before.chains.some((c) => c.id === id))
                throw new ChainRegistryError('CHAIN_NOT_FOUND', `链不存在：${id}`);
            return { version: 1, chains: before.chains.filter((c) => c.id !== id) };
        });
    }
    rollback(batch) {
        this.withLock(() => {
            const rows = readAuditFile(this.root);
            const target = rows.find((r) => r.batch === batch);
            if (!target)
                throw new ChainRegistryError('CHAIN_NOT_FOUND', `找不到链操作批次：${batch}`);
            if (target.action === 'rollback' || target.action === 'migrate')
                throw new ChainRegistryError('CHAIN_CONFLICT', '迁移初始化或回滚记录不能通过此入口再次回滚');
            if (rows.some((r) => r.rollbackOf === batch))
                throw new ChainRegistryError('CHAIN_CONFLICT', `批次 ${batch} 已回滚`);
            const current = this.readVerifiedRegistry();
            if (!same(current, target.after))
                throw new ChainRegistryError('CHAIN_CONFLICT', '该批次之后已有其他链变更；为避免覆盖后续操作，只允许回滚当前仍处于顶端的状态');
            this.commitUnlocked(current, target.before, 'rollback', target.id, true, batch);
        });
    }
    transact(action, id, mutate) {
        this.withLock(() => {
            const before = this.readVerifiedRegistry();
            const after = validateRegistry(mutate(clone(before)));
            this.commitUnlocked(before, after, action, id, true);
        });
    }
    readVerifiedRegistry() {
        const current = this.readRegistry();
        const history = readAuditFile(this.root);
        if (!history.length || !same(history[history.length - 1].after, current)) {
            throw new ChainRegistryError('CHAIN_CORRUPT', 'chains.json 与链审计日志末尾快照不一致；拒绝读取或写入');
        }
        return current;
    }
    readRegistry() {
        let raw;
        try {
            raw = fs.readFileSync(this.registryPath, 'utf-8');
        }
        catch (error) {
            throw new ChainRegistryError('CHAIN_CORRUPT', `无法读取 chains.json：${String(error)}`);
        }
        try {
            return validateRegistry(JSON.parse(raw));
        }
        catch (error) {
            if (error instanceof ChainRegistryError)
                throw error;
            throw new ChainRegistryError('CHAIN_CORRUPT', `chains.json 解析失败：${String(error)}`);
        }
    }
    commitUnlocked(before, after, action, id, beforeExists, rollbackOf) {
        const history = readAuditFile(this.root);
        if (history.length && !same(history[history.length - 1].after, before)) {
            throw new ChainRegistryError('CHAIN_CORRUPT', '链审计日志与当前注册表不一致，拒绝写入');
        }
        if (!history.length && beforeExists) {
            throw new ChainRegistryError('CHAIN_CORRUPT', '注册表存在但缺少链审计历史，拒绝追加操作');
        }
        const record = {
            batch: `chain-${randomUUID()}`,
            at: nowIso(),
            action,
            id,
            before: clone(before),
            after: clone(after),
            ...(rollbackOf ? { rollbackOf } : {}),
        };
        const pending = { record, beforeExists };
        atomicWrite(this.pendingPath, JSON.stringify(pending, null, 2) + '\n');
        try {
            atomicWrite(this.registryPath, JSON.stringify(after, null, 2) + '\n');
            appendAudit(this.root, record);
            try {
                fs.unlinkSync(this.pendingPath);
            }
            catch { /* startup recovery will verify the committed audit row */ }
        }
        catch (error) {
            const recoveryRequired = error instanceof ChainRegistryError && error.code === 'CHAIN_RECOVERY_REQUIRED';
            try {
                if (beforeExists)
                    atomicWrite(this.registryPath, JSON.stringify(before, null, 2) + '\n');
                else if (fs.existsSync(this.registryPath))
                    fs.unlinkSync(this.registryPath);
                if (!recoveryRequired) {
                    if (!beforeExists && history.length === 0 && fs.existsSync(this.auditPath) && fs.statSync(this.auditPath).size === 0) {
                        try {
                            fs.unlinkSync(this.auditPath);
                        }
                        catch { /* empty audit file will make the next startup fail closed */ }
                    }
                    try {
                        fs.unlinkSync(this.pendingPath);
                    }
                    catch { /* no-op */ }
                }
            }
            catch (restoreError) {
                throw new ChainRegistryError('CHAIN_RECOVERY_REQUIRED', `链操作失败且自动恢复失败；保留 ${PENDING_FILE} 供恢复。原错误：${String(error)}；恢复错误：${String(restoreError)}`);
            }
            if (recoveryRequired)
                throw error;
            throw new ChainRegistryError('CHAIN_AUDIT_FAILED', `链操作未提交，审计写入失败，注册表已恢复：${String(error)}`);
        }
    }
    recoverPending() {
        if (!fs.existsSync(this.pendingPath))
            return;
        let pending;
        try {
            pending = JSON.parse(fs.readFileSync(this.pendingPath, 'utf-8'));
            if (!pending?.record?.batch || typeof pending.record.at !== 'string' || !Number.isFinite(Date.parse(pending.record.at))
                || !['migrate', 'create', 'rename', 'delete', 'rollback'].includes(pending.record.action)
                || typeof pending.record.id !== 'string' || !pending.record.id
                || !pending.record.before || !pending.record.after || typeof pending.beforeExists !== 'boolean')
                throw new Error('pending fields invalid');
            pending.record.before = validateRegistry(pending.record.before);
            pending.record.after = validateRegistry(pending.record.after);
        }
        catch (error) {
            throw new ChainRegistryError('CHAIN_CORRUPT', `待恢复事务文件损坏，拒绝猜测：${String(error)}`);
        }
        const history = readAuditFile(this.root);
        const committedRow = history.find((r) => r.batch === pending.record.batch);
        if (committedRow) {
            if (!same(committedRow, pending.record))
                throw new ChainRegistryError('CHAIN_CORRUPT', '待恢复事务与已提交审计记录不一致');
            atomicWrite(this.registryPath, JSON.stringify(pending.record.after, null, 2) + '\n');
        }
        else {
            if (history.length && !same(history[history.length - 1].after, pending.record.before)) {
                throw new ChainRegistryError('CHAIN_CORRUPT', '待恢复事务 before 快照与审计尾部不一致');
            }
            if (!history.length && pending.beforeExists) {
                throw new ChainRegistryError('CHAIN_CORRUPT', '存在注册表的待恢复事务缺少之前的审计历史');
            }
            if (fs.existsSync(this.registryPath)) {
                const onDisk = this.readRegistry();
                if (!same(onDisk, pending.record.before) && !same(onDisk, pending.record.after)) {
                    throw new ChainRegistryError('CHAIN_CORRUPT', '磁盘注册表既不匹配事务 before，也不匹配 after；拒绝覆盖');
                }
            }
            else if (pending.beforeExists) {
                throw new ChainRegistryError('CHAIN_CORRUPT', '待恢复事务预期存在注册表，但文件缺失');
            }
            if (pending.beforeExists)
                atomicWrite(this.registryPath, JSON.stringify(pending.record.before, null, 2) + '\n');
            else {
                try {
                    fs.unlinkSync(this.registryPath);
                }
                catch { /* not created yet */ }
            }
        }
        fs.unlinkSync(this.pendingPath);
        this.log.warn?.(`[chains] 检测到未完成事务 ${pending.record.batch}，已按审计事实${committedRow ? '恢复提交后状态' : '回退到提交前状态'}`);
    }
    withLock(fn) {
        let lock;
        try {
            lock = acquireWriteLock(this.root, { lockFile: LOCK_FILE, holder: 'breathe-chain-registry', retry: { attempts: 5, budgetMs: 300 } });
        }
        catch (error) {
            throw new ChainRegistryError('CHAIN_LOCK_BUSY', `无法取得链注册表锁：${error instanceof Error ? error.message : String(error)}`);
        }
        try {
            return fn();
        }
        finally {
            lock.release();
        }
    }
}
