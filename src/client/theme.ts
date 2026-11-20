/**
 * Canvas 主题取色：运行时读 DSH CSS 变量，明暗主题自适应。
 * Canvas 无法直接用 var()，必须 getComputedStyle 解析成具体颜色。
 */

/** 缓存解析结果（CSS 变量不变，一次解析够用） */
let cache: Record<string, string> | null = null

/** 读取一个 DSH 主题 CSS 变量，返回具体色值（带 fallback） */
function themeColor(variable: string, fallback: string): string {
  if (cache === null) {
    const style = typeof document !== 'undefined'
      ? getComputedStyle(document.documentElement)
      : null
    cache = {}
    if (style) {
      // 预取所有会用到的变量
      const keys = [
        '--dsw-alias-label-primary',
        '--dsw-alias-label-secondary',
        '--dsw-alias-label-tertiary',
        '--dsw-alias-bg-canvas',
        '--dsw-alias-bg-module',
        '--dsw-alias-border-l2',
      ]
      for (const key of keys) {
        const value = style.getPropertyValue(key).trim()
        if (value) cache[key] = value
      }
    }
  }
  return cache?.[variable] ?? fallback
}

/** 主题化文字颜色（主标签色） */
export function labelColor(): string {
  return themeColor('--dsw-alias-label-primary', '#1f2937')
}

/** 主题化次级文字颜色 */
export function labelSecondaryColor(): string {
  return themeColor('--dsw-alias-label-secondary', '#6b7280')
}

/** 主题化描边颜色 */
export function strokeColor(alpha = 0.35): string {
  const base = themeColor('--dsw-alias-label-primary', '#1f2937')
  // 把 hex 转成 rgba
  const hex = base.replace('#', '')
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}
