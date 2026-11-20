/**
 * Markdown → **已转义**的 HTML（抽屉与行内展开共用一份实现）
 *
 * ⛔ 为什么必须共用：抽屉（`EntryDrawer`）和列表行内展开（`EntryRow`）都要渲染正文，
 * 两处各写一份 = "两处要同步"的老病（本仓栽过多次：checksum / 索引 / 挂载模板）。
 *
 * ⚠️ 安全纪律（原型注释里写着的）：**渲染前先整体转义**，容器正文是数据不是 HTML。
 * 支持：标题 / 段落 / 列表 / 引用 / 围栏代码 / **表格** / **粗体·斜体** / 行内码 / 链接 / 分隔线；
 * 链接只放行 http/https（⛔ 不许正文造出 javascript:）。
 */

/** ⛔ 先转义 —— 容器正文是数据不是 HTML（原型注释里那条纪律） */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

/**
 * 极简 Markdown → **已转义**的 HTML。
 * 支持：标题 / 段落 / 列表 / 引用 / 围栏代码 / **表格** / **粗体·斜体** / 行内码 / 链接 / 分隔线。
 * ⚠️ 上一版我"没实现就说没实现"地跳过了表格与粗体 —— 结果 h01 的正文（本身就是一张表）
 *    渲染成一堆 `|项|内容|` 原文，被 作者 当场抓出来。**实现不了可以说，但真需要就必须实现。**
 * 链接只放行 http/https（容器正文是数据，⛔ 不许它造出 javascript: ）。
 */
export function renderMarkdown(src: string): string {
  const lines = src.split('\n')
  const out: string[] = []
  let inCode = false
  let listBuf: string[] = []
  let tableBuf: string[] = []
  const flushList = (): void => {
    if (listBuf.length) { out.push('<ul class="md-list">' + listBuf.join('') + '</ul>'); listBuf = [] }
  }
  /** 行内：先整体转义，再只放开我们**自己生成**的标签（粗体/斜体/行内码/链接） */
  const inline = (raw: string): string => {
    let t = escapeHtml(raw)
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    t = t.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>')
    t = t.replace(/`([^`]+)`/g, '<code>$1</code>')
    // 链接只放行 http/https（容器正文是数据，别让它造出 javascript: 之类）
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    return t
  }
  const flushTable = (): void => {
    if (!tableBuf.length) return
    const rows = tableBuf.map((r) => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim()))
    tableBuf = []
    const [head, ...body] = rows
    // 第二行是 |---|---| 分隔行 ⇒ 丢掉
    const isSep = (r: string[] | undefined) => !!r && r.every((c) => /^:?-{2,}:?$/.test(c))
    const rest = isSep(body[0]) ? body.slice(1) : body
    out.push(
      '<table class="md-table"><thead><tr>' + (head ?? []).map((c) => '<th>' + inline(c) + '</th>').join('') + '</tr></thead><tbody>'
      + rest.map((r) => '<tr>' + r.map((c) => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('')
      + '</tbody></table>',
    )
  }
  for (const raw of lines) {
    if (/^\s*\|.*\|\s*$/.test(raw)) { flushList(); tableBuf.push(raw); continue }
    flushTable()
    if (/^```/.test(raw)) {
      flushList()
      out.push(inCode ? '</pre>' : '<pre class="md-code">')
      inCode = !inCode
      continue
    }
    if (inCode) { out.push(escapeHtml(raw)); continue }
    const h = /^(#{1,6})\s+(.*)$/.exec(raw)
    if (h) { flushList(); const n = h[1].length; out.push('<h' + n + ' class="md-h">' + inline(h[2]) + '</h' + n + '>'); continue }
    if (/^\s*[-*]\s+/.test(raw)) { listBuf.push('<li>' + inline(raw.replace(/^\s*[-*]\s+/, '')) + '</li>'); continue }
    flushList()
    if (/^>\s?/.test(raw)) { out.push('<blockquote class="md-quote">' + inline(raw.replace(/^>\s?/, '')) + '</blockquote>'); continue }
    if (/^\s*(---|\*\*\*)\s*$/.test(raw)) { out.push('<hr class="md-hr" />'); continue }
    if (!raw.trim()) continue
    out.push('<p class="md-p">' + inline(raw) + '</p>')
  }
  flushList(); flushTable()
  if (inCode) out.push('</pre>')
  return out.join('\n')
}
