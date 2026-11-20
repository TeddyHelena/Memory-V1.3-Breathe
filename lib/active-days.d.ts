export interface ActiveDayRow {
    day: string;
    sessionId: string;
    seq: number;
    at: number;
    /** 时间源：event.time / data.time / now（探针 2 的现场证据） */
    timeSource: 'event.time' | 'data.time' | 'now';
}
export declare class ActiveDaysLog {
    private readonly file;
    private readonly seen;
    private readonly rows;
    constructor(root: string);
    private load;
    /** 记录一次真人消息；同 (day, sessionId) 或同 (day, 文本指纹) 只落一次 */
    record(day: string, sessionId: string, seq: number, at: number, timeSource: ActiveDayRow['timeSource'], text?: string): boolean;
    /** 活跃日集合（升序、去重） */
    days(): string[];
    /** 诊断：行数 / 天数 / 时间源分布 */
    stats(): {
        rows: number;
        days: number;
        timeSource: Record<string, number>;
    };
}
/** 从事件里取时间（探针 2 的三级回退） */
export declare function eventTimeOf(event: unknown): {
    at: number;
    source: ActiveDayRow['timeSource'];
};
/** 给定时刻算活跃日键（走 day-boundary 的唯一口径） */
export declare function activeDayKey(at: number): string;
