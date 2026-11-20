export interface BuildHash {
    /** 内容哈希前 16 位（sha256） */
    hash: string;
    /** 参与哈希且存在的文件数 */
    files: number;
    /** 清单里**找不到**的文件（如实列出，⛔ 不许静默跳过） */
    missing: string[];
}
export interface BuildIdentity extends BuildHash {
    /** 启动（插件装载）时刻 */
    loadedAt: string;
    /** 启动时那一刻的哈希 */
    loadedHash: string;
    /** 刚刚现算的盘上哈希 */
    diskHash: string;
    /** **盘上 ≠ 进程内** ⇒ 改了代码没重启（这时"改了等于没改"） */
    stale: boolean;
}
/**
 * 生成一次构建身份快照。
 * @param libDir 插件产物目录（运行时传 `import.meta.dirname`）
 * @param loaded 启动时捕获的那份（见 `captureBuild`）
 */
export declare function buildIdentity(libDir: string, loaded: {
    hash: string;
    at: string;
}): BuildIdentity;
/** 启动时捕获一次（进程生命周期内不再变）。 */
export declare function captureBuild(libDir: string): {
    hash: string;
    at: string;
    files: number;
    missing: string[];
};
