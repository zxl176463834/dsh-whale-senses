/**
 * dsh-whale-senses — 「口」：本地 IndexTTS 朗读。
 *
 * 2026-10-29 从 dsh-voice-out 0.2.0 整体搬进来。只改了挂载方式：
 *   · 路由从 /dsh-voice-out/* 变成 /dsh-whale-senses/voice/*
 *   · 日志并进 dsh-whale-senses.log，带 [朗读] 前缀
 * 配置文件名**故意沿用** dsh-voice-out.config.json —— 搬过来不能丢已经调好的
 * 音色 / 语速 / 情绪强度 / 药丸位置；也方便一行回滚。
 *
 * 干三件事：
 *   1) 管住本地 IndexTTS 服务进程（Python，模型常驻 + 空闲卸载）
 *   2) 盯会话：记录「说完一整轮」的助手文字；自动模式直接排队
 *   3) 给界面接口：/voice/status /voice/config /voice/speak /voice/next
 *      /voice/ack /voice/clear /voice/unload /voice/recent
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { denyNonLoopback, readBody, sendJson } from './http.js'

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
/** 沿用旧文件名：改名等于丢已有设置。 */
const CFG_PATH = join(HOME, 'dsh-voice-out.config.json')

const APP_DIR = process.env.VOICE_OUT_APP || ''
/** 2026-10-30 换 Qwen3-TTS：服务跑在它自己的 venv 里（带 transformers 4.57.3），
 *  而那个 venv 通过 .pth 借用了 IndexTTS venv 的 torch，两套引擎都能 import。 */
const QWEN_PY = process.env.VOICE_OUT_QWEN_PY || ''
const PY = QWEN_PY && existsSync(QWEN_PY) ? QWEN_PY : (APP_DIR ? join(APP_DIR, '.venv', 'Scripts', 'python.exe') : 'python')
const SERVER_PY = fileURLToPath(new URL('../server/tts_server.py', import.meta.url))
const TMP_DIR = process.env.VOICE_OUT_TMP || join(HOME, 'voice-tmp')

const DEFAULT = {
  enabled: true,
  mode: 'manual',
  engine: 'qwen',
  instruct: '',
  precise: false,
  voice: 'examples/voice_09.wav',
  // 基准音：有它就走克隆（音色固定），没有才走 VoiceDesign（每句都会变）
  refWav: '',
  refText: '',
  speed: 1.0,
  happy: 0,
  calm: 0,
  idleMinutes: 15,
  maxChars: 600,
  pillPos: null,
}

function readCfg() {
  try {
    const p = JSON.parse(readFileSync(CFG_PATH, 'utf8'))
    return {
      enabled: p.enabled !== false,
      mode: p.mode === 'auto' ? 'auto' : 'manual',
      engine: p.engine === 'indextts' ? 'indextts' : 'qwen',
      instruct: typeof p.instruct === 'string' ? p.instruct : '',
      precise: p.precise === true,
      voice: typeof p.voice === 'string' && p.voice ? p.voice : DEFAULT.voice,
      refWav: typeof p.refWav === 'string' ? p.refWav : '',
      refText: typeof p.refText === 'string' ? p.refText : '',
      speed: Number.isFinite(p.speed) ? Math.min(1.4, Math.max(0.7, p.speed)) : DEFAULT.speed,
      happy: Number.isFinite(p.happy) ? Math.min(1, Math.max(0, p.happy)) : 0,
      calm: Number.isFinite(p.calm) ? Math.min(1, Math.max(0, p.calm)) : 0,
      idleMinutes: Number.isFinite(p.idleMinutes) ? Math.min(120, Math.max(1, p.idleMinutes)) : DEFAULT.idleMinutes,
      maxChars: Number.isFinite(p.maxChars) ? Math.min(2000, Math.max(100, p.maxChars)) : DEFAULT.maxChars,
      pillPos: p.pillPos && Number.isFinite(p.pillPos.x) && Number.isFinite(p.pillPos.y)
        ? { x: Math.round(p.pillPos.x), y: Math.round(p.pillPos.y) }
        : null,
    }
  } catch (error) { return { ...DEFAULT } }
}

function writeCfg(patch) {
  const next = { ...readCfg(), ...patch }
  if (patch && 'pillPos' in patch) {
    const p = patch.pillPos
    next.pillPos = p && Number.isFinite(p.x) && Number.isFinite(p.y)
      ? { x: Math.round(p.x), y: Math.round(p.y) }
      : null
  }
  try {
    mkdirSync(HOME, { recursive: true })
    writeFileSync(CFG_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8')
  } catch (error) {}
  return next
}

/** 去掉念不出来的东西：颜文字、emoji、怪符号。 */
function clean(text) {
  let s = String(text == null ? '' : text)
  s = s.replace(/[（(][^（()）]{0,30}[)）]/g, (m) => (/[\u4e00-\u9fa5A-Za-z0-9]/.test(m.replace(/[（()）]/g, '')) ? m : ' '))
  s = s.replace(/[^\u4e00-\u9fa5\u3000-\u303F\uFF00-\uFFEFA-Za-z0-9\s.,!?;:'"()\[\]…—－-]+/g, ' ')
  s = s.replace(/[（(]?\s*[>＞<＜^vV][-_^.,;:·]{1,3}[>＜<^vV]\s*[)）]?/g, ' ')
  s = s.replace(/[（(]?\s*[TToO0xX][-_^.,;:·]{1,3}[TToO0xX]\s*[)）]?/g, ' ')
  s = s.replace(/\borz\b/gi, ' ')
  s = s.replace(/[:;=8][-o*']?[)(\[\]dDpP/\\|{}]/g, ' ')
  s = s.replace(/[（(]\s*[)）]/g, ' ')
  s = s.replace(/ ([，。！？、；：）】》])/g, '$1').replace(/([（【《]) /g, '$1').trim()
  return s
}

/**
 * 裁掉 wav 头尾的静音。
 *
 * 实测（2026-10-29）：模型每段都固定带 0.26–0.31 秒头部静音 + 0.2–0.3 秒尾部静音。
 * 整段合成时静音只占 13%，可一句一段之后就占到 70%（「好」只有 0.22 秒有效声音）。
 * 不裁掉这些问题，怎么切都会「一句一顿」。头尾各留 keepMs 毫秒，别剪得太硬。
 */
export function trimWavSilence(buf, threshold = 0.006, keepMs = 40) {
  try {
    if (!buf || buf.length < 64) return buf
    if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return buf
    const channels = buf.readUInt16LE(22)
    const rate = buf.readUInt32LE(24)
    const bits = buf.readUInt16LE(34)
    if (bits !== 16 || !channels || !rate) return buf
    const dataIdx = buf.indexOf('data', 12, 'ascii')
    if (dataIdx < 0) return buf
    const dataStart = dataIdx + 8
    const dataLen = buf.readUInt32LE(dataIdx + 4)
    const frameBytes = channels * 2
    const total = Math.min(
      Math.floor(dataLen / frameBytes),
      Math.floor((buf.length - dataStart) / frameBytes),
    )
    if (total <= 0) return buf
    const step = Math.max(1, Math.round(rate * 0.01))
    let first = -1
    let last = -1
    for (let i = 0; i < total; i += step) {
      let peak = 0
      const end = Math.min(i + step, total)
      for (let j = i; j < end; j += 1) {
        let acc = 0
        for (let c = 0; c < channels; c += 1) {
          const v = buf.readInt16LE(dataStart + j * frameBytes + c * 2) / 32768
          acc += v * v
        }
        const rms = Math.sqrt(acc / channels)
        if (rms > peak) peak = rms
      }
      if (peak > threshold) { if (first < 0) first = i; last = end }
    }
    if (first < 0) return buf
    const keep = Math.round(rate * keepMs / 1000)
    const from = Math.max(0, first - keep)
    const to = Math.min(total, last + keep)
    if (to - from >= total) return buf
    const newLen = (to - from) * frameBytes
    const out = Buffer.alloc(dataStart + newLen)
    buf.copy(out, 0, 0, dataStart)
    out.writeUInt32LE(out.length - 8, 4)
    out.writeUInt32LE(newLen, dataIdx + 4)
    buf.copy(out, dataStart, dataStart + from * frameBytes, dataStart + to * frameBytes)
    return out
  } catch (error) {
    return buf
  }
}

// ---------- 本地 TTS 服务进程 ----------
const server = { proc: null, port: 0, status: 'idle', error: '', startedAt: 0 }
/** 日志出口（mountVoice 时接到感官的 say 上），这样进程管理函数不用到处传 say。 */
let logSink = null
/** 插件被卸载后置 true：进程被杀掉就别再自动拉起来了。 */
let disposed = false

function log(msg) {
  // logSink 是感官的 say，它自己会加「[朗读]」前缀；没有 sink 时自己加
  if (typeof logSink === 'function') logSink(msg)
  else console.log('[朗读] ' + msg)
}

function startServer() {
  if (server.proc) return
  if (!existsSync(PY)) { server.status = 'failed'; server.error = '找不到 python：' + PY; return }
  if (!existsSync(SERVER_PY)) { server.status = 'failed'; server.error = '找不到服务脚本：' + SERVER_PY; return }
  server.status = 'starting'
  server.error = ''
  const child = spawn(PY, [SERVER_PY], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      VOICE_OUT_APP: APP_DIR,
      PYTHONPATH: '.',
      TMP: TMP_DIR,
      TEMP: TMP_DIR,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  server.proc = child
  server.startedAt = Date.now()
  let buf = ''
  let gotPort = false
  child.stdout.on('data', (chunk) => {
    if (gotPort) return
    buf += chunk.toString('utf8')
    const m = buf.match(/PORT=(\d+)/)
    if (m) { gotPort = true; server.port = Number(m[1]); server.status = 'ready'; log('服务就绪，端口 ' + server.port) }
  })
  child.stderr.on('data', (chunk) => {
    const t = chunk.toString('utf8').trim()
    if (t) log('python: ' + t.slice(0, 300))
  })
  child.on('exit', (code, signal) => {
    log('服务退出 code=' + code + ' signal=' + signal)
    server.proc = null
    server.port = 0
    server.status = 'idle'
  })
  child.on('error', (error) => {
    server.status = 'failed'
    server.error = String(error && error.message)
    log('服务启动失败：' + server.error)
  })
}

/**
 * 等端口。
 * ⚠️ 必须带自愈：插件重载时旧实例的 disposer 会把进程收掉，新实例如果只在 apply 时
 * 起过一次进程，后面就永远等不到端口（2026-10-29 实测：药丸报「启动超时（40 秒）」）。
 * 所以这里发现 proc 没了就再拉一次，最多两次，别无限重启。
 */
async function ensurePort(timeoutMs = 40000) {
  const t0 = Date.now()
  let attempts = 0
  while (Date.now() - t0 < timeoutMs) {
    if (server.port) return server.port
    if (disposed) throw new Error('朗读服务已被卸载（插件重载过），重启 DSH 后再试')
    if (server.status === 'failed') throw new Error(server.error || '服务启动失败')
    if (!server.proc && attempts < 2) {
      attempts += 1
      log('进程不在，重新拉起（第 ' + attempts + ' 次）')
      startServer()
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('本地 TTS 服务启动超时（' + Math.round(timeoutMs / 1000) + ' 秒）')
}

async function callServer(path, body) {
  const port = await ensurePort()
  const res = await fetch('http://127.0.0.1:' + port + path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (path !== '/speak') return { status: res.status, json: await res.json().catch(() => ({})) }
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}))
    throw new Error(detail.error || ('生成失败（HTTP ' + res.status + '）'))
  }
  return { status: res.status, audio: Buffer.from(await res.arrayBuffer()) }
}

// ---------- 队列 ----------
const state = { queue: [], nextId: 1, recent: [], claimed: new Map() }

function enqueue(text, say, sessionId) {
  const t = clean(text)
  if (!t) return false
  const cfg = readCfg()
  const cut = t.length > cfg.maxChars ? t.slice(0, cfg.maxChars) : t
  if (state.queue.length >= 6) state.queue.shift()
  state.queue.push({ id: state.nextId++, text: cut, at: Date.now(), session: sessionId || '' })
  say('排队 ' + state.queue.length + ' 条（会话 ' + (sessionId || '?').slice(0, 8) + '）：' + cut.slice(0, 40))
  return true
}

/** 只取属于这个会话的项；没传 session 时退回「任意会话」（老行为）。 */
function takeNext(sessionId) {
  const now = Date.now()
  for (const item of state.queue) {
    if (sessionId && item.session && item.session !== sessionId) continue
    const until = state.claimed.get(item.id) || 0
    if (until > now) continue
    state.claimed.set(item.id, now + 60000)
    return item
  }
  return null
}

// ---------- 会话监听 ----------
const seen = new Map()

function collect(d, turns) {
  const arr = turns.get(d.turn) || []
  const blocks = d.message && d.message.content
  if (Array.isArray(blocks)) {
    for (const b of blocks) if (b && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) arr.push(b.text.trim())
  }
  turns.set(d.turn, arr)
}

function absorb(events, say, sessionId) {
  const turns = new Map()
  for (const ev of events) {
    if (!ev || !ev.type) continue
    if (ev.type === 'assistant/message') {
      collect(ev.data || {}, turns)
    } else if (ev.type === 'turn/end') {
      const d = ev.data || {}
      const arr = turns.get(d.turn)
      turns.delete(d.turn)
      const kind = d.reason && d.reason.kind
      if (kind === 'completed' && arr && arr.length) {
        const text = arr.join('\n\n')
        state.recent.unshift({ text: clean(text), at: Date.now(), session: sessionId || '' })
        state.recent = state.recent.slice(0, 20)
        const cfg = readCfg()
        if (cfg.enabled && cfg.mode === 'auto') enqueue(text, say, sessionId)
      }
    }
  }
}

function scan(ctx, say) {
  let list = []
  try { list = ctx.sessions.list() } catch (error) { return }
  for (const s of list) {
    if (!s || !s.id) continue
    const id = String(s.id)
    let seq = 0
    try { seq = Number(s.seq) || 0 } catch (error) { seq = 0 }
    if (!seen.has(id)) { seen.set(id, seq); continue }
    const from = seen.get(id)
    if (!(seq > from)) continue
    seen.set(id, seq)
    try { absorb(s.snapshotEvents(from), say, id) } catch (error) {}
  }
}

/**
 * 就地扫会话，捞「最后一条说完的助手回复」。
 * onlyId 给了就只认那一个会话 —— 药丸会把它正在看的会话 id 传进来，
 * 这样别的会话（自动化任务、另一个窗口）刚说完话也不会被念出来。
 */
function liveLatest(ctx, onlyId) {
  let list = []
  try { list = ctx.sessions.list() } catch (error) { return '' }
  const sorted = list
    .filter((s) => s && s.id && (!onlyId || String(s.id) === onlyId))
    .map((s) => ({ s, seq: (() => { try { return Number(s.seq) || 0 } catch (error) { return 0 } })() }))
    .sort((a, b) => b.seq - a.seq)
    .slice(0, onlyId ? 1 : 6)
  for (const { s } of sorted) {
    let events = []
    try { events = s.snapshotEvents(0) } catch (error) { continue }
    if (!Array.isArray(events) || !events.length) continue
    const turns = new Map()
    const done = []
    for (const ev of events) {
      if (!ev || !ev.type) continue
      if (ev.type === 'assistant/message') {
        collect(ev.data || {}, turns)
      } else if (ev.type === 'turn/end') {
        const d = ev.data || {}
        const arr = turns.get(d.turn)
        turns.delete(d.turn)
        const kind = d.reason && d.reason.kind
        if (kind === 'completed' && arr && arr.length) done.push(arr.join('\n\n'))
      }
    }
    if (done.length) {
      const text = clean(done[done.length - 1])
      if (text) return text
    }
  }
  return ''
}

/**
 * 把「口」挂进感官插件。
 * @param {object} ctx     cordis 上下文
 * @param {object} deps    { route(method, path, handler), say(msg), version }
 */
export function mountVoice(ctx, deps) {
  const say = (msg) => deps.say('[朗读] ' + msg)
  const route = deps.route
  const version = deps.version || ''

  // 进程管理那几段函数在模块作用域，日志从这里接出去；重载时 dispose 置位、新实例再复位
  logSink = say
  disposed = false

  const effect = typeof ctx.effect === 'function' ? (fn) => ctx.effect(fn) : (fn) => fn()

  // ---------- 接口 ----------
  route('GET', '/voice/status', async (req, res) => {
    if (denyNonLoopback(req, res)) return
    let health = {}
    try {
      if (server.port) health = (await callServer('/health')).json
    } catch (error) {
      health = { ok: false, error: String(error && error.message) }
    }
    sendJson(res, 200, {
      ok: true,
      version,
      config: readCfg(),
      server: {
        status: server.status,
        port: server.port,
        modelLoaded: health.loaded === true,
        error: server.error || health.error || '',
      },
      queue: state.queue.length,
      recent: state.recent.slice(0, 3),
    })
  })

  route('POST', '/voice/config', async (req, res) => {
    if (denyNonLoopback(req, res)) return
    try {
      const patch = await readBody(req)
      const next = writeCfg(patch)
      if (server.port) callServer('/config', { idleMinutes: next.idleMinutes, engine: next.engine }).catch(() => {})
      sendJson(res, 200, { ok: true, config: next })
    } catch (error) { sendJson(res, 400, { ok: false, error: String(error && error.message) }) }
  })

  route('POST', '/voice/speak', async (req, res) => {
    if (denyNonLoopback(req, res)) return
    try {
      const body = await readBody(req, 1024 * 1024)
      const text = clean(body.text)
      if (!text) { sendJson(res, 400, { ok: false, error: '没有可念的文字' }); return }
      const cfg = readCfg()
      const out = await callServer('/speak', {
        text: text.slice(0, cfg.maxChars),
        engine: cfg.engine,
        instruct: cfg.instruct,
        precise: cfg.precise,
        voice: cfg.voice,
        refWav: cfg.refWav,
        refText: cfg.refText,
        speed: cfg.speed,
        happy: cfg.happy,
        calm: cfg.calm,
      })
      const audio = trimWavSilence(out.audio)
      res.writeHead(200, {
        'Content-Type': 'audio/wav',
        'Content-Length': String(audio.length),
        'Cache-Control': 'no-store',
      })
      res.end(audio)
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error && error.message) })
    }
  })

  route('GET', '/voice/next', async (req, res, url) => {
    if (denyNonLoopback(req, res)) return
    const q = url && url.searchParams ? url.searchParams : null
    const sessionId = q ? String(q.get('session') || '') : ''
    const cfg = readCfg()
    if (!cfg.enabled || cfg.mode !== 'auto') { sendJson(res, 200, { ok: true, item: null, mode: cfg.mode }); return }
    const item = takeNext(sessionId)
    sendJson(res, 200, { ok: true, item: item ? { id: item.id, text: item.text } : null, mode: cfg.mode })
  })

  route('POST', '/voice/ack', async (req, res) => {
    if (denyNonLoopback(req, res)) return
    try {
      const body = await readBody(req)
      const id = Number(body.id)
      state.queue = state.queue.filter((i) => i.id !== id)
      state.claimed.delete(id)
      sendJson(res, 200, { ok: true, queue: state.queue.length })
    } catch (error) { sendJson(res, 400, { ok: false, error: String(error && error.message) }) }
  })

  route('POST', '/voice/clear', async (req, res) => {
    if (denyNonLoopback(req, res)) return
    state.queue = []
    state.claimed.clear()
    sendJson(res, 200, { ok: true })
  })

  route('POST', '/voice/unload', async (req, res) => {
    if (denyNonLoopback(req, res)) return
    try {
      const out = server.port ? (await callServer('/unload', {})).json : { ok: true, unloaded: false }
      sendJson(res, 200, out)
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error && error.message) })
    }
  })

  route('GET', '/voice/recent', async (req, res, url) => {
    if (denyNonLoopback(req, res)) return
    const q = url && url.searchParams ? url.searchParams : null
    const sessionId = q ? String(q.get('session') || '') : ''
    try {
      // 指定会话时只认那一个：别的会话刚说完的话不该被念出来
      const live = liveLatest(ctx, sessionId)
      if (live && (!state.recent.length || state.recent[0].text !== live)) {
        state.recent.unshift({ text: live, at: Date.now(), session: sessionId })
        state.recent = state.recent.slice(0, 20)
      }
    } catch (error) {
      say('活会话扫描失败：' + (error && error.message))
    }
    const recent = sessionId
      ? state.recent.filter((r) => r.session === sessionId)
      : state.recent
    sendJson(res, 200, { ok: true, recent: recent.slice(0, 10), session: sessionId || null })
  })

  // ---------- 起来 ----------
  effect(() => {
    const timer = setInterval(() => { try { scan(ctx, say) } catch (error) {} }, 1500)
    return () => clearInterval(timer)
  })
  // 插件卸载时别留一个 python 在后台占着显存
  effect(() => () => {
    disposed = true
    say('卸载插件，收掉 TTS 进程')
    const child = server.proc
    server.proc = null
    server.port = 0
    server.status = 'idle'
    if (!child) return
    try {
      // ⚠️ Windows 上 venv 的 python.exe 只是个转启器，真正的 cpython 是它的子进程；
      // 只 kill 外层会留一个孤儿继续跑（实测 2026-10-29）。必须按进程树杀。
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      } else {
        child.kill()
      }
    } catch (error) {}
  })

  startServer()
  say('「口」挂载完成 v' + version)
}

/** 给别的插件/工具读一下当前朗读状态（可选）。 */
export function voiceStatus() {
  return { server: { status: server.status, port: server.port, error: server.error }, queue: state.queue.length, config: readCfg() }
}
