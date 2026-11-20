/**
 * Canvas 主题取色：运行时读 DSH CSS 变量，明暗主题自适应。
 * Canvas 无法直接用 var()，必须 getComputedStyle 解析成具体颜色。
 */
/** 主题化文字颜色（主标签色） */
export declare function labelColor(): string;
/** 主题化次级文字颜色 */
export declare function labelSecondaryColor(): string;
/** 主题化描边颜色 */
export declare function strokeColor(alpha?: number): string;
