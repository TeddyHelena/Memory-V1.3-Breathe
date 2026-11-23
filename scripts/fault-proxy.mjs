#!/usr/bin/env node
/**
 * 【前端故障注入代理 · 2026-11-22】
 *
 * 目的：验证「失败可见、不假成功」——API 500 / 超时 / 坏 JSON 时，页面必须报错，
 * 不许静默当成成功。
 *
 * 为什么要代理：插件本身没有故障注入开关，而为调试加一个开关要改生产代码 + 重启。
 * 这个代理把 UI 与 API 都转出去，UI 的 fetch 是相对路径 ⇒ 同源，注入对页面透明。
 *
 * 用法：
 *   node scripts/fault-proxy.mjs [--port 8788] [--target http://127.0.0.1:<DSH端口>] [--token-file ~/.dsh/memory-api-token]
 * 打开：
 *   http://127.0.0.1:8788/api/memory/ui
 * 切故障（浏览器里直接开，或 curl）：
 *   http://127.0.0.1:8788/__fault?mode=500|timeout|badjson|none
 *
 * ⛔ 只在本地 loopback 监听；不写任何生产文件。
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const PORT = Number(arg('port', '8788'))
const TARGET = arg('target', process.env.DSH_WEB_TARGET ?? '')
const TOKEN_FILE = arg('token-file', path.join(os.homedir(), '.dsh', 'memory-api-token'))
if (!TARGET) { console.error('必须给 --target（例如 --target http://127.0.0.1:55507）'); process.exit(2) }
const TOKEN = fs.readFileSync(TOKEN_FILE, 'utf-8').trim()

let mode = 'none'
const stats = { served: 0, injected: 0, byMode: {} }

const json = (res, code, body) => {
  const text = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)

  // 控制面
  if (url.pathname === '/__fault') {
    mode = url.searchParams.get('mode') ?? 'none'
    if (!['none', '500', 'timeout', 'badjson'].includes(mode)) return json(res, 400, { ok: false, reason: `未知 mode: ${mode}` })
    console.log(`[fault-proxy] mode → ${mode}`)
    return json(res, 200, { ok: true, mode, stats })
  }
  if (url.pathname === '/__stats') return json(res, 200, { ok: true, mode, stats })

  // 只代理 /api/memory/*
  if (!url.pathname.startsWith('/api/memory/')) return json(res, 404, { ok: false, reason: '只代理 /api/memory/*' })

  const isUi = url.pathname === '/api/memory/ui'
  // 故障只打在数据接口上；UI 本身必须能加载，否则连"报错可见"都验不了
  if (!isUi && mode !== 'none') {
    stats.injected++
    stats.byMode[mode] = (stats.byMode[mode] ?? 0) + 1
    if (mode === '500') return json(res, 500, { ok: false, reason: '[fault-proxy] 注入的 500' })
    if (mode === 'badjson') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      return res.end('{"ok":true,"data":{ 这不是 JSON')
    }
    if (mode === 'timeout') {
      // 挂住不回：页面必须走到"超时/失败可见"，而不是显示成功
      setTimeout(() => { try { json(res, 504, { ok: false, reason: '[fault-proxy] 注入的超时' }) } catch { /* 客户端已放弃 */ } }, 10_000)
      return
    }
  }

  // 转发（注入真实 token；页面自己不带）
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    const headers = { ...req.headers, 'x-memory-token': TOKEN }
    delete headers.host
    delete headers['content-length']
    if (body.length) headers['content-length'] = String(body.length)
    const upstream = http.request({ hostname: new URL(TARGET).hostname, port: new URL(TARGET).port, path: req.url, method: req.method, headers }, (up) => {
      stats.served++
      res.writeHead(up.statusCode ?? 502, up.headers)
      up.pipe(res)
    })
    upstream.on('error', (e) => json(res, 502, { ok: false, reason: `上游失败：${e instanceof Error ? e.message : String(e)}` }))
    upstream.on('response', (up) => console.log(`[fault-proxy] ${req.method} ${req.url} → ${up.statusCode}`))
    upstream.end(body)
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[fault-proxy] http://127.0.0.1:${PORT}/api/memory/ui  →  ${TARGET}`)
  console.log(`[fault-proxy] 切故障： http://127.0.0.1:${PORT}/__fault?mode=500|timeout|badjson|none`)
})
