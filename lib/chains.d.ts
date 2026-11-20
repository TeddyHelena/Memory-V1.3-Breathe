export interface MemoryChain {
    id: string;
    name: string;
    canonicalTag: string;
    aliases: string[];
    createdAt: string;
    updatedAt: string;
}
export interface ChainRegistry {
    version: 1;
    chains: MemoryChain[];
}
export type ChainAction = 'migrate' | 'create' | 'rename' | 'delete' | 'rollback';
export interface ChainAuditRecord {
    batch: string;
    at: string;
    action: ChainAction;
    id: string;
    before: ChainRegistry;
    after: ChainRegistry;
    rollbackOf?: string;
}
export type ChainErrorCode = 'CHAIN_INVALID' | 'CHAIN_CONFLICT' | 'CHAIN_NOT_FOUND' | 'CHAIN_CORRUPT' | 'CHAIN_LOCK_BUSY' | 'CHAIN_AUDIT_FAILED' | 'CHAIN_RECOVERY_REQUIRED';
export declare class ChainRegistryError extends Error {
    readonly code: ChainErrorCode;
    constructor(code: ChainErrorCode, message: string);
}
export interface ChainStoreOptions {
    log?: {
        error: (message: string) => void;
        warn?: (message: string) => void;
        info?: (message: string) => void;
    };
}
export declare class ChainStore {
    private readonly root;
    private readonly registryPath;
    private readonly auditPath;
    private readonly pendingPath;
    private readonly log;
    constructor(root: string, options?: ChainStoreOptions);
    list(): MemoryChain[];
    readAudit(): ChainAuditRecord[];
    resolveMatches(tags: readonly string[], snapshot?: readonly MemoryChain[]): MemoryChain[];
    assignment(tags: readonly string[], snapshot?: readonly MemoryChain[]): MemoryChain | null;
    create(nameInput: unknown, tagInput?: unknown): MemoryChain;
    rename(id: string, nameInput: unknown): MemoryChain;
    delete(id: string): void;
    rollback(batch: string): void;
    private transact;
    private readVerifiedRegistry;
    private readRegistry;
    private commitUnlocked;
    private recoverPending;
    private withLock;
}
