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
/** 锁文件相对容器根的路径 */
export declare const LOCK_FILE = ".memory-write.lock";
export interface LockOptions {
    /**
     * 锁文件名（相对容器根）。默认 `.memory-write.lock`。
     * 【2026-10-19 并发修复】pins / subjects 用各自的锁文件：
     * 它们与条目写事务是**不同资源**，共用一把锁会让“钉一下”和“写一条”互相 LOCK_BUSY。
     */
    lockFile?: string;
    /** @deprecated 兼容旧调用方；不再以心跳超时作为接管依据。 */
    staleMs?: number;
    /** 持有者标识（写日志用），如 'assistant' / 'cli' */
    holder?: string;
    /**
     * 有界短重试（2026-09-15 · 压测评审 §1.4）。
     *
     * 背景：跨进程实测 8 进程并发写时 **87.5% 直接失败**——拒绝是对的（不能被重试糊过去），
     * 但"恰好撞上"的瞬时冲突本可被短重试吸收，让双实例场景可用。
     *
     * **四条边界（必须全部守住）**：
     *   ① 有界：次数与总时长都封顶（默认 3 次 / 200ms），超限如实报错
     *   ② 不掩盖真竞争：真被占用时最终仍抛 LOCK_BUSY，只是晚一点
     *   ③ 不延长接管时间：重试**只读锁状态**、不续期也不改心跳，锁接管判据不受重试影响
     *   ④ 重试成功后必须重读索引：见 writer.runTransaction() —— 事务建立快照时先 container.load()，
     *      否则拿到的可能是"别的进程释放锁之前"的旧索引，等于用一个补丁踩另一个补丁的坑
     */
    retry?: {
        attempts?: number;
        budgetMs?: number;
    };
}
/** 锁句柄：release() 幂等 */
export interface LockHandle {
    readonly token: string;
    release: () => void;
}
/**
 * 尝试获取写入锁（含有界短重试）。
 * @throws WriteError(LOCK_BUSY) 当锁被另一个存活实例持有，且重试预算耗尽
 */
export declare function acquireWriteLock(containerRoot: string, options?: LockOptions): LockHandle;
