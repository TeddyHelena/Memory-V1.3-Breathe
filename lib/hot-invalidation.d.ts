/**
 * 算出"下一个会改变 hot 段内容的时刻"。
 * @returns 毫秒时间戳；null = 没有任何未来边界（此时这个触发永不生效）
 */
export declare function computeNextBoundary(entries: Array<{
    valid_to?: string;
    expires?: string;
    status?: string;
    superseded_by?: string;
}>, nowMs: number): number | null;
/** 边界已过？（`null` = 没有边界 ⇒ 永远 false） */
export declare function boundaryPassed(nextBoundary: number | null, nowMs: number): boolean;
export interface RevisionProbe {
    /** 盘上索引的修订是否变了（含首次探测：首次返回 false，只登记基线） */
    changed(): boolean;
    /**
     * **重新登记基线**（我们自己写盘之后必须调）。
     *
     * ⛔ 外审第 4 条（当时点名过）：`saveIndex()` **自己**会改 `(mtimeMs, size)` ——
     *    不重新登记的话，下一次装配会把"我们自己的写"误判成"外部改盘"，
     *    于是白跑一次 `container.load()` + hot 重算。写入路径必须在这里销账。
     */
    rebaseline(): {
        mtimeMs: number;
        size: number;
    } | null;
    /** 当前登记的修订（自检/审计用） */
    stamp(): {
        mtimeMs: number;
        size: number;
    } | null;
}
/**
 * 索引文件修订探针：用 `(mtimeMs, size)` 判断"盘上这份是不是我们上次看到的那份"。
 * 成本：每次调用一次 `statSync`（常数级，满足 C1/C6）。
 *
 * ⚠️ 已知盲区（如实写下）：`(mtimeMs, size)` 抓不住"同一毫秒内、同字节数"的改写。
 *    这是**已知并接受**的边界 —— 更严的做法要内容哈希（每次装配付不起）。
 */
export declare function makeRevisionProbe(indexPath: string, extraPaths?: readonly string[]): RevisionProbe;
