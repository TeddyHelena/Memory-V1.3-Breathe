/**
 * 读钉住名单。
 * ⛔ 解析失败/结构不符 ⇒ 抛错（fail-closed）：调用方（扫描/公示）宁可停摆，也不许当空名单把钉住的条目忘了。
 * 只有“文件不存在”（ENOENT）才返回空集。
 */
export declare function loadPins(root: string): Set<string>;
/**
 * 返回**落盘后**的真实状态（写失败返回 null，⛔ 不许谎报“已钉”）。
 * 锁被占用且重试耗尽 ⇒ 抛 WriteError(LOCK_BUSY)；条目不存在 ⇒ WriteError(ENTRY_NOT_FOUND)。
 */
export declare function setPin(root: string, id: string, pinned: boolean): boolean | null;
