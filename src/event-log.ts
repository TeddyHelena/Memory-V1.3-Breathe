/**
 * ── 【P1 · 2026-10-18】统一事件日志 ────────────────────────────────
 *
 * 一句话：**每类观测事件一个 append-only 文件**，写不进去不影响主流程，但必须 error。
 * 目录：`<容器>/events/<kind>.jsonl`
 *
 * ⛔ 为什么单独目录：`.decay-audit.jsonl` 是判据账，混进去会让 gate/rollback 误读（P2 的教训）。
 * ⛔ 每行必带 `at`；生产者可以再加任意字段，消费者按 kind 解释。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

export type EventKind =
  | 'mention'
  | 'activation'
  | 'render'
  | 'tier-change'
  | 'publication'
  | 'candidates'
  | 'chain-shadow'
  | 'orphan-report'

export const EVENT_KINDS: readonly EventKind[] = [
  'mention', 'activation', 'render', 'tier-change', 'publication', 'candidates', 'chain-shadow', 'orphan-report',
]

/** 追加一条事件；⛔ 永不抛（观测口，不拖垮主流程） */
export function appendEvent(root: string, kind: EventKind, payload: Record<string, unknown>, logger?: { error: (m: string) => void }): boolean {
  try {
    const dir = path.join(root, 'events')
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, `${kind}.jsonl`), JSON.stringify({ at: Date.now(), ...payload }) + '\n', 'utf-8')
    return true
  } catch (e) {
    logger?.error(`[events] ${kind} 写入失败（观测口静默丢失，按红处理）：${e instanceof Error ? e.message : String(e)}`)
    return false
  }
}

/** 读一类事件（诊断/自检用；坏行跳过） */
export function readEvents(root: string, kind: EventKind): Array<Record<string, unknown>> {
  try {
    const text = fs.readFileSync(path.join(root, 'events', `${kind}.jsonl`), 'utf-8')
    return text.split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) as Array<Record<string, unknown>>
  } catch {
    return []
  }
}

/** 自检：哪些类还没有任何记录（空数组 = 全有；用于 P1 退出判据） */
export function missingEventKinds(root: string): EventKind[] {
  return EVENT_KINDS.filter((k) => readEvents(root, k).length === 0)
}
