/**
 * lock.ts —— 单写入队列（跨进程写入锁）（V1.0 / P2）
 *
 * 解决什么：两个 DSH 实例同时写同一个容器，会各自基于自己的内存索引落盘，
 * 后来者覆盖前者——表现为「刚记住的东西下一个会话没了」或 index.json 与文件脱节。
 * v0.5 一直靠「别同时开两个实例」的口头约定，P2 把它变成机制。
 *
 * 设计（对齐硅基拍档 3.6 的思路，但落到文件锁）：
 *   - 锁文件：容器根目录 `.memory-write.lock`（JSON：pid / host / startedAt / holder）
 *   - 获取：O_EXCL 原子创建；已被占用则读其元数据
 *   - 本机接管：同机 PID 已退出 ⇒ 可接管；PID 仍存活时，即使 heartbeat 很旧也拒绝接管
 *   - 远端锁：不自动接管（无法探测远端 PID，heartbeat 不是可靠租约）；管理员确认停机后人工清理
 *   - 释放：仅持有者可释放（比对 token，避免误删别人的锁）
 *   - 失败语义：拿不到锁 → 抛 WriteError(LOCK_BUSY)，**不排队、不重试**（本期不做队列）
 *
 * 边界（诚实标注）：
 *   - 这是「协作锁」不是「强制锁」：绕过插件直接改文件的编辑器不受它约束
 *   - 同进程内多次调用由内存标记短路，不做递归锁
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ERR, WriteError } from './idem.js';
/** 锁文件相对容器根的路径 */
export const LOCK_FILE = '.memory-write.lock';
function readLock(lockPath) {
    try {
        const raw = fs.readFileSync(lockPath, 'utf-8');
        const parsed = JSON.parse(raw);
        return typeof parsed?.token === 'string' ? parsed : null;
    }
    catch {
        // 文件不存在或内容损坏均返回 null；调用方用 existsSync 区分缺失与损坏，损坏时 fail-closed
        return null;
    }
}
/**
 * 同步微睡（毫秒）。用于有界重试的间隔。
 * 用 Atomics.wait 而非 busy-loop：不烧 CPU；插件侧写事务本身是同步的，不能用 await。
 */
function sleepSync(ms) {
    if (ms <= 0)
        return;
    const shared = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(shared, 0, 0, ms);
}
/**
 * 尝试获取写入锁（含有界短重试）。
 * @throws WriteError(LOCK_BUSY) 当锁被另一个存活实例持有，且重试预算耗尽
 */
export function acquireWriteLock(containerRoot, options = {}) {
    const attempts = Math.max(1, Math.min(10, options.retry?.attempts ?? 1));
    const budgetMs = Math.max(0, Math.min(2_000, options.retry?.budgetMs ?? 0));
    if (attempts > 1 && budgetMs > 0) {
        const started = Date.now();
        let lastError;
        for (let i = 0; i < attempts; i++) {
            try {
                return acquireWriteLockOnce(containerRoot, options);
            }
            catch (error) {
                lastError = error;
                // 只对"被占用"重试；其它错误（权限、路径）立刻抛，重试无意义
                if (!(error instanceof WriteError) || error.code !== ERR.LOCK_BUSY)
                    throw error;
                const elapsed = Date.now() - started;
                const remaining = budgetMs - elapsed;
                if (i === attempts - 1 || remaining <= 0)
                    break;
                // 递增间隔，但不超过剩余预算
                sleepSync(Math.min(remaining, 10 * (i + 1) + 30));
            }
        }
        throw lastError;
    }
    return acquireWriteLockOnce(containerRoot, options);
}
/** 单次尝试（原实现），不含重试逻辑 */
function acquireWriteLockOnce(containerRoot, options = {}) {
    const holder = options.holder ?? 'unknown';
    const lockPath = path.join(containerRoot, options.lockFile ?? LOCK_FILE);
    const token = randomUUID();
    const now = Date.now();
    const payload = () => JSON.stringify({
        token,
        pid: process.pid,
        host: os.hostname(),
        holder,
        startedAt: new Date(now).toISOString(),
        heartbeatAt: new Date().toISOString(),
    }, null, 2) + '\n';
    try {
        // wx = O_CREAT | O_EXCL：原子创建，已存在直接失败
        fs.writeFileSync(lockPath, payload(), { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
        return {
            token,
            release: () => releaseLock(lockPath, token),
        };
    }
    catch (error) {
        if (error?.code !== 'EEXIST')
            throw error;
    }
    // 已被占用：先读取锁记录。文件存在但无法解析时必须 fail-closed，
    // 否则可能把另一进程正在创建/写入的锁误判为陈旧并删除。
    const existing = readLock(lockPath);
    if (!existing && fs.existsSync(lockPath)) {
        throw new WriteError(ERR.LOCK_BUSY, '锁文件存在但内容不可验证；为避免误接管，已拒绝写入，请检查锁文件后人工恢复');
    }
    // 【Ledger · L-1×L-2 联动修复】光看心跳不够 —— 还要看**持有者是不是一台机器上已经死掉的进程**。
    // 现场（真 SIGKILL 实测）：写入事务中途崩溃 ⇒ 锁文件留在盘上；进程重启后立刻写
    // ⇒ 心跳才过几秒（没到 60s）⇒ 报 LOCK_BUSY，**而且文案让人去找"另一个 DSH 实例"**——
    //   那个"另一个实例"就是刚刚崩掉的自己。用户体感：崩完重启，一分钟内什么都写不进去。
    // 判据：**同机 + pid 已死** ⇒ 直接按陈旧接管（仍然走下面那条**原子接管**路径，互斥不受影响）。
    // ⛔ 只对本机生效：远端 PID 无法验证，远端锁不自动接管（fail-closed）。
    // ⛔ pid 活着但拿不到信号权（EPERM）一律算"活着"——保守侧。
    if (!shouldTakeOver(existing)) {
        const who = existing
            ? `${existing.holder}(pid ${existing.pid}@${existing.host})`
            : '未知持有者';
        throw new WriteError(ERR.LOCK_BUSY, `容器被另一个实例占用（${who}，心跳 ${existing?.heartbeatAt ?? '未知'}）。` +
            (existing?.host === os.hostname()
                ? '请先关闭该 DSH 实例；确认进程退出后可自动接管。'
                : '该锁来自其他主机，当前版本无法安全判断远端进程是否存活；请先确认远端写入者已停止，再由管理员人工清理锁文件。'));
    }
    // ── 陈旧锁：接管（必须**串行化**）─────────────────────────────────
    // 【Ledger · L-2 修复】修复前这里是「读-判-写」三步裸着写：
    //   `readLock` → `isStale` → `writeFileSync(lockPath, payload())`
    // 两个进程同时判"陈旧" ⇒ 各自覆盖写入 ⇒ **后写的赢，但两个都以为自己持锁**
    // ⇒ 两个写入者并发，正是这把锁存在要防的事。
    // 实测（`scripts/lock-race.mjs`，8 进程真抢）：修复前 stale 模式 **4–6/6 轮并发持有**（最多 3 个同时持锁）；
    // fresh 模式一直正常（`wx` 原子创建本来就是对的）。
    //
    // ⚠️ 中途试过一版"rename 抢占"，**不成立**，留痕在此：rename 搬走的是 `lockPath` 上的**当前**文件，
    //   可能把别人刚建好的**新锁**搬走（判的是旧锁、搬的是新锁）⇒ 实测 6/6 仍然并发持有。
    //
    // 现在的修法：**接管令牌**（`.memory-write.lock.takeover`，`wx` 独占创建）串行化接管动作。
    //   ① 建到令牌的那个才有资格接管；建不到 ⇒ 别人正在接管 ⇒ 报 LOCK_BUSY；
    //   ② **拿到令牌之后要重新判一次陈旧**——期间真正的持有者可能已经续期/释放；
    //   ③ 令牌在手 ⇒ `unlink(lock)` + `wx` 建新锁，这一段没有竞争者；
    //   ④ 无论成败都释放令牌。
    // 令牌也记录 pid/host：只在同机 PID 已退出时回收。不能用 2s 超时抢占，
    //   因为持有接管令牌的进程可能被暂停；按时间回收会再次制造双持锁。
    const claimPath = `${lockPath}.takeover`;
    const claimToken = `${token}:${Date.now()}`;
    if (!acquireClaim(claimPath, claimToken)) {
        throw new WriteError(ERR.LOCK_BUSY, '接管陈旧锁失败：另一个实例正在接管（接管令牌被占）');
    }
    try {
        // ② 复判：拿到令牌的这一刻，锁可能已经不是陈旧锁了
        const cur = readLock(lockPath);
        if (!cur && fs.existsSync(lockPath)) {
            throw new WriteError(ERR.LOCK_BUSY, '接管复核发现锁文件不可解析；为避免误接管，已拒绝写入');
        }
        if (cur && !shouldTakeOver(cur)) {
            throw new WriteError(ERR.LOCK_BUSY, '接管陈旧锁失败：锁已被他人续期或重建');
        }
        try {
            fs.unlinkSync(lockPath);
        }
        catch { /* 已经不在了也无妨 */ }
        try {
            fs.writeFileSync(lockPath, payload(), { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
        }
        catch (error) {
            if (error?.code === 'EEXIST') {
                throw new WriteError(ERR.LOCK_BUSY, '接管陈旧锁失败：另一个实例已先建立新锁');
            }
            throw error;
        }
        return {
            token,
            release: () => releaseLock(lockPath, token),
        };
    }
    finally {
        try {
            fs.unlinkSync(claimPath);
        }
        catch { /* 令牌已被陈旧回收清掉也无妨 */ }
    }
}
/**
 * 【Ledger · L-2】拿"接管令牌"：`wx` 独占创建 ⇒ 同一时刻只有一个能拿到。
 * 令牌仅在同机 PID 已退出时回收；旧格式、远端或活进程令牌一律 fail-closed。
 */
function acquireClaim(claimPath, claimToken) {
    const write = () => fs.writeFileSync(claimPath, JSON.stringify({
        token: claimToken, at: Date.now(), pid: process.pid, host: os.hostname(),
    }) + '\n', { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
    try {
        write();
        return true;
    }
    catch (error) {
        if (error?.code !== 'EEXIST')
            throw error;
    }
    // 接管令牌只能由其同机、已退出的持有进程回收；旧格式/远端/活进程一律 fail-closed。
    try {
        const raw = JSON.parse(fs.readFileSync(claimPath, 'utf-8'));
        if (raw?.host !== os.hostname() || isProcessAlive(raw?.pid ?? 0))
            return false;
        fs.unlinkSync(claimPath);
    }
    catch {
        return false; // 读不动/解析不了 ⇒ 保守：不接管
    }
    try {
        write();
        return true;
    }
    catch {
        return false; // 回收后被别人抢先
    }
}
/**
 * 【Ledger · L-1×L-2】**该不该接管**：仅同机持有者进程已死时允许接管。
 *   心跳超时不构成租约；远端 PID 无法探测时拒绝自动接管。
 * ⚠️ 这一条**两处都要用**（进入接管前的判定、以及拿到接管令牌后的复判）——
 *    第一版只改了前一处的，结果卡在复判："锁已被他人续期或重建"（其实那条锁的主人早死了）。
 */
function shouldTakeOver(existing) {
    if (!existing)
        return true;
    // 本机锁以 PID 生死为准：心跳只是观测字段，不是租约。同步写事务可能阻塞事件循环，
    // 因而不能依赖定时 heartbeat；活进程即使 heartbeat 很旧也绝不能被接管。
    if (existing.host === os.hostname())
        return !isProcessAlive(existing.pid);
    // 其他主机的 PID 无法可靠探测，而当前实现没有独立于事件循环的续租者。
    // 因此跨主机共享文件系统时必须 fail-closed，不能把“心跳旧”误当作“进程已死”。
    // 远端崩溃锁需由操作者确认持有者已停止后人工清理；本插件的正式支持边界是单机本地容器。
    return false;
}
/**
 * 【Ledger · L-1×L-2】本机进程还活着吗：`kill(pid, 0)` 只探测不发信号。
 * 判定口径：ESRCH = 不存在（死）；EPERM = 存在但没权限动它（**算活着**，保守侧）。
 */
function isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error?.code === 'EPERM';
    }
}
/** 释放锁：只有 token 匹配才删，避免删掉别人刚接管的锁 */
function releaseLock(lockPath, token) {
    const existing = readLock(lockPath);
    if (!existing || existing.token !== token)
        return;
    try {
        fs.unlinkSync(lockPath);
    }
    catch {
        // 已被他人接管/删除：无妨
    }
}
