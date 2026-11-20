/**
 * 【P7】钉住名单：被钉住的条目永不遗忘（旁挂文件，⛔ 不改条目 frontmatter）。
 *
 * 【2026-10-19 并发修复】s4 沙箱实测：4 进程 16 次 `setPin` 全报成功，盘上只剩 6 条。
 * 根因是 `loadPins → add → savePins` 裸读改写。现在：
 *   · 读改写放进 `.pins.lock`（与条目写事务的 `.memory-write.lock` **分开**，互不误伤）；
 *   · 锁内**重读**再改，锁失败抛 LOCK_BUSY（工具回 ok:false，不谎报已钉）；
 *   · `pins.json` 坏了 **fail-closed 抛错**，不再静默返回空集（否则一次坏文件=全体解钉）；
 *   · pin 前校验条目真实存在（防 ghost id 把名单撑虚）。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { acquireWriteLock } from './lock.js'
import { ERR, WriteError } from './idem.js'

/** 与条目写事务分开的锁文件 */
const PINS_LOCK_FILE = '.pins.lock'
const PIN_LOCK = { lockFile: PINS_LOCK_FILE, holder: 'pin', staleMs: 10_000, retry: { attempts: 10, budgetMs: 1_500 } }

/**
 * 读钉住名单。
 * ⛔ 解析失败/结构不符 ⇒ 抛错（fail-closed）：调用方（扫描/公示）宁可停摆，也不许当空名单把钉住的条目忘了。
 * 只有“文件不存在”（ENOENT）才返回空集。
 */
export function loadPins(root: string): Set<string> {
  const file = path.join(root, 'pins.json')
  let text: string
  try {
    text = fs.readFileSync(file, 'utf-8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return new Set()
    throw new Error(`[pins] pins.json 读取失败（fail-closed，不当作空名单）：${e instanceof Error ? e.message : String(e)}`)
  }
  let data: { ids?: unknown }
  try {
    data = JSON.parse(text) as { ids?: unknown }
  } catch (e) {
    throw new Error(`[pins] pins.json 解析失败（fail-closed，禁止全体解钉）：${e instanceof Error ? e.message : String(e)}`)
  }
  if (!data || !Array.isArray(data.ids)) {
    throw new Error('[pins] pins.json 结构不符（缺 ids 数组；fail-closed，禁止全体解钉）')
  }
  return new Set(data.ids.filter((x): x is string => typeof x === 'string' && x.length > 0))
}

function savePins(root: string, ids: ReadonlySet<string>): boolean {
  try {
    const file = path.join(root, 'pins.json')
    const tmp = `${file}.tmp-${process.pid}`
    fs.writeFileSync(tmp, JSON.stringify({ ids: [...ids].sort() }, null, 2), 'utf-8')
    fs.renameSync(tmp, file)   // 原子：写一半被杀不会留下截断文件
    return true
  } catch { return false }
}

/** 条目文件是否真实存在（四层按 `<id>.md` 找；不读 index.json，避免 delta 尚未折平时误判） */
function entryFileExists(root: string, id: string): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return false
  for (const layer of ['hot', 'longterm', 'archive', 'pending']) {
    try { if (fs.existsSync(path.join(root, layer, `${id}.md`))) return true } catch { /* skip */ }
  }
  return false
}

/**
 * 返回**落盘后**的真实状态（写失败返回 null，⛔ 不许谎报“已钉”）。
 * 锁被占用且重试耗尽 ⇒ 抛 WriteError(LOCK_BUSY)；条目不存在 ⇒ WriteError(ENTRY_NOT_FOUND)。
 */
export function setPin(root: string, id: string, pinned: boolean): boolean | null {
  if (!entryFileExists(root, id)) {
    throw new WriteError(ERR.ENTRY_NOT_FOUND, `条目不存在（先确认 id）: ${id}`)
  }
  const lock = acquireWriteLock(root, PIN_LOCK)
  try {
    const pins = loadPins(root)   // ⛔ 锁内重读：锁外读到的那份可能已被别的进程改过
    if (pinned) pins.add(id); else pins.delete(id)
    return savePins(root, pins) ? pinned : null
  } finally {
    lock.release()
  }
}
