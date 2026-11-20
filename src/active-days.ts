/**
 * ── 【P0-7 · 2026-10-18】活跃日账本 ────────────────────────────────
 *
 * 一句话：**只记“哪天有真人说话”**，按 `(day, sessionId)` 去重，append-only。
 * 为什么不用存档重算：751 份里 510 份是 bench、61 份跨日、130 份重复 ⇒ 口径不可复现（§15.3）。
 * ⛔ 时间源优先 `event.time`（宿主事件时间），退回 `data.time`，最后才 `Date.now()`——
 *    用墙钟会让跨午夜累计与重建对不上。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { dayKey } from './day-boundary.js'

export interface ActiveDayRow {
  day: string
  sessionId: string
  seq: number
  at: number
  /** 时间源：event.time / data.time / now（探针 2 的现场证据） */
  timeSource: 'event.time' | 'data.time' | 'now'
}

export class ActiveDaysLog {
  private readonly file: string
  private readonly seen = new Set<string>()
  private readonly rows: ActiveDayRow[] = []

  constructor(root: string) {
    this.file = path.join(root, 'active-days.jsonl')
    this.load()
  }

  private load(): void {
    try {
      const text = fs.readFileSync(this.file, 'utf-8')
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        try {
          const r = JSON.parse(line) as ActiveDayRow
          if (typeof r.day === 'string' && typeof r.sessionId === 'string') {
            this.seen.add(`${r.day}|${r.sessionId}`)
            this.rows.push(r)
          }
        } catch { /* 坏行跳过，账本可重建 */ }
      }
    } catch { /* 首次运行无文件 */ }
  }

  /** 记录一次真人消息；同 (day, sessionId) 或同 (day, 文本指纹) 只落一次 */
  record(day: string, sessionId: string, seq: number, at: number, timeSource: ActiveDayRow['timeSource'], text?: string): boolean {
    if (!day || !sessionId) return false
    const k = `${day}|${sessionId}`
    // ⛔ 只按 (day, sessionId) 去重：按文本哈希跨会话去重会误杀“同一天另一个真实会话”
    //    （实测：两个会话都以「继续」开场 ⇒ 第二条整行不落 ⇒ 该会话永久 no-session）
    if (this.seen.has(k)) return false
    this.seen.add(k)
    const row: ActiveDayRow = { day, sessionId, seq, at, timeSource }
    this.rows.push(row)
    try {
      fs.appendFileSync(this.file, JSON.stringify(row) + '\n', 'utf-8')
      return true
    } catch {
      return false
    }
  }

  /** 活跃日集合（升序、去重） */
  days(): string[] {
    return [...new Set(this.rows.map((r) => r.day))].sort()
  }

  /** 诊断：行数 / 天数 / 时间源分布 */
  stats(): { rows: number; days: number; timeSource: Record<string, number> } {
    const ts: Record<string, number> = {}
    for (const r of this.rows) ts[r.timeSource] = (ts[r.timeSource] ?? 0) + 1
    return { rows: this.rows.length, days: this.days().length, timeSource: ts }
  }
}

/** 从事件里取时间（探针 2 的三级回退） */
export function eventTimeOf(event: unknown): { at: number; source: ActiveDayRow['timeSource'] } {
  const e = event as { time?: unknown; data?: { time?: unknown } } | undefined
  const t1 = e?.time
  if (typeof t1 === 'number' && Number.isFinite(t1)) return { at: t1, source: 'event.time' }
  if (typeof t1 === 'string' && t1) {
    const parsed = Date.parse(t1)
    if (Number.isFinite(parsed)) return { at: parsed, source: 'event.time' }
  }
  const t2 = e?.data?.time
  if (typeof t2 === 'number' && Number.isFinite(t2)) return { at: t2, source: 'data.time' }
  if (typeof t2 === 'string' && t2) {
    const parsed = Date.parse(t2)
    if (Number.isFinite(parsed)) return { at: parsed, source: 'data.time' }
  }
  return { at: Date.now(), source: 'now' }
}

/** 给定时刻算活跃日键（走 day-boundary 的唯一口径） */
export function activeDayKey(at: number): string {
  return dayKey(new Date(at))
}
