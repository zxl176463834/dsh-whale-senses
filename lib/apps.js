/**
 * 手 · 打开程序（2026-11-11 从 dsh-app-launcher 搬进 dsh-whale-senses）。
 *
 * 为什么要在插件里做：DSH 的终端工具跑在 Low 完整性沙箱，那里 Start-Process 出来的
 * 图形程序起不来（微信直接退出、记事本没窗口）。插件跑在宿主进程（Medium），能起来。
 * 索引默认读 ~/.dsh/apps-index.json，可用环境变量 DSH_APPS_INDEX 覆盖。
 * 索引格式：{ "名字": "目标路径" } 的扁平表。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { readBody, sendJson } from './http.js'
import { readHandCfg } from './hands.js'

const HOME = process.env.USERPROFILE || process.env.HOME || homedir()

function indexCandidates() {
  return [
    process.env.DSH_APPS_INDEX,
    HOME ? path.join(HOME, '.dsh', 'apps-index.json') : '',
  ].filter(Boolean)
}

export function loadAppsIndex() {
  for (const p of indexCandidates()) {
    try {
      const raw = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')
      const obj = JSON.parse(raw)
      if (obj && typeof obj === 'object' && Object.keys(obj).length) return obj
    } catch { /* try next */ }
  }
  return null
}

function resolveName(index, q) {
  const ql = q.toLowerCase()
  const keys = Object.keys(index)
  const exact = keys.filter((k) => k.toLowerCase() === ql)
  if (exact.length === 1) return { key: exact[0], target: index[exact[0]] }
  const prefix = keys.filter((k) => k.toLowerCase().startsWith(ql))
  if (prefix.length === 1) return { key: prefix[0], target: index[prefix[0]] }
  const contains = keys.filter((k) => k.toLowerCase().includes(ql))
  if (contains.length === 1) return { key: contains[0], target: index[contains[0]] }
  const pool = exact.length ? exact : prefix.length ? prefix : contains
  return { ambiguous: pool.slice(0, 8) }
}

function launch(target) {
  const t = String(target)
  const opts = { detached: true, stdio: 'ignore', windowsHide: true }
  if (/\.lnk$/i.test(t)) { const c = spawn('explorer.exe', [t], opts); c.unref(); return c.pid }
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !/^[a-z]:[\\/]/i.test(t)) {
    const c = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', t], opts); c.unref(); return c.pid
  }
  if (/[\\/]/.test(t)) { const c = spawn(t, [], opts); c.unref(); return c.pid }
  const c = spawn('cmd.exe', ['/c', 'start', '""', t], opts); c.unref(); return c.pid
}

/** 打开一个程序：给工具和设置页共用。 */
export function openApp(rawName) {
  const q = String(rawName || '').trim()
  if (!q) return { ok: false, error: '缺少应用名' }
  const cfg = readHandCfg()
  if (cfg.launch === false) return { ok: false, error: '「打开程序」这项能力在设置里被关掉了' }
  const index = loadAppsIndex()
  if (!index) return { ok: false, error: '找不到程序索引 apps-index.json（用环境变量 DSH_APPS_INDEX 指定路径，或放到 ~/.dsh/apps-index.json）' }
  const hit = resolveName(index, q)
  if (hit.ambiguous && hit.ambiguous.length) return { ok: false, error: '「' + q + '」匹配到多个', candidates: hit.ambiguous }
  if (!hit.key) return { ok: false, error: '没找到「' + q + '」' }
  try {
    launch(hit.target)
    return { ok: true, name: hit.key, target: hit.target }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

export function mountApps(ctx, deps) {
  const route = deps && deps.route
  const say = (deps && deps.say) || (() => {})

  ctx.tools.register({
    name: 'open_app',
    description:
      '打开本机应用程序（微信、QQ、浏览器、记事本、B站、Steam、Photoshop 等）。按名字精确或前缀匹配；返回 candidates 时表示匹配到多个，改用更完整的名字。不要用 pwsh 启动图形程序，那条路在沙箱里起不来。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: { name: { type: 'string', description: '应用名，如 微信、QQ、记事本、浏览器、b站、steam' } },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          name: { type: 'string' },
          target: { type: 'string' },
          error: { type: 'string' },
          candidates: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, v) => {
        if (v.ok) return [{ type: 'text', text: '已打开 ' + v.name }]
        if (Array.isArray(v.candidates) && v.candidates.length) {
          return [{ type: 'text', text: '没打开：' + v.error + '。候选：' + v.candidates.join(' | ') }]
        }
        return [{ type: 'text', text: '没打开：' + v.error }]
      },
    },
    async execute(args) {
      return openApp(args && args.name)
    },
  })
  say('「手」里的打开程序已就绪（索引：' + indexCandidates().filter((p) => { try { return fs.existsSync(p) } catch { return false } }).join(', ') + '）')

  if (typeof route === 'function') {
    route('POST', '/apps/open', async (req, res) => {
      let body = {}
      try { body = await readBody(req) } catch {}
      const out = openApp(body && body.name)
      sendJson(res, 200, out)
    })
  }
}
