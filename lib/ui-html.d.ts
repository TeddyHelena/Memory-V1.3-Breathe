import type { MemoryContainer } from './container.js';
import type { SubjectStore } from './subjects.js';
import type { InjectionLedger } from './injection-ledger.js';
import type { ChainStore } from './chains.js';
export declare function buildExactUiHtml(opts: {
    container: MemoryContainer;
    subjects: SubjectStore;
    ledger: InjectionLedger;
    token: string;
    apiPrefix: string;
    chainStore?: ChainStore;
    allowEdit?: boolean;
    chainUnavailableReason?: string;
    /** 首启向导是否需要的只读投影；调用方传入，渲染层当前不消费。 */
    onboardingNeeded?: boolean;
}): string;
