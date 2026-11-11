/**
 * dsh-whale-senses — Host 半边。
 *
 * 感官总控：眼（摄像头）/ 耳（语音输入）/ 口（朗读）/ 手（桌面操作）。
 * 这一版把「眼」和「口」都收在自己身上：
 *   1) camera 工具 —— 让我能直接抓一张现实世界的照片
 *   2) HTTP 路由 —— 给设置页面板用（设备列表 / 参数 / 预览 / 朗读）
 *   3) 配置读写 —— 眼存在 ~/.dsh/dsh-whale-senses.config.json
 *   4) 口：本地 IndexTTS 朗读（lib/voice.js，2026-10-29 从 dsh-voice-out 整体搬入）
 *
 * 「耳」2026-11-11 也从 dsh-voice-panel 整体搬入（lib/voice-input/host.js：接口 + 全局热键 helper），
 * 路由仍是 /dsh-voice、配置仍是 ~/.dsh/dsh-voice.config.json，所以前端接口地址一个字没改。
 */
import { exec, execFile, spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROUTE, readBody, sendJson, denyNonLoopback } from './http.js'
import { mountVoice } from './voice.js'
import { apply as applyVoiceInput } from './voice-input/host.js'
import { mountHands } from './hands.js'
import { mountApps } from './apps.js'

export const name = 'senses'
export const inject = ['tools', 'webServer', 'sessions']

/** 每次现读：插件热重载时 ESM 模块缓存不会重跑顶层代码，写死常量会一直报旧版本。 */
function readVersion() {
  try { return String(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || '') } catch { return '' }
}
const VERSION = readVersion()

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const CFG_PATH = join(HOME, 'dsh-whale-senses.config.json')
const LOG_PATH = join(HOME, 'dsh-whale-senses.log')

const CAM_PY = fileURLToPath(new URL('./cam.py', import.meta.url))
/** 抓帧用的 Python：需要一个装了 opencv-python 的解释器。用 WHALE_EYE_PY 指定，否则用 PATH 上的 python。 */
const PY = process.env.WHALE_EYE_PY || 'python'
const STREAM_PY = fileURLToPath(new URL('./stream.py', import.meta.url))
const DESKTOP_PS = fileURLToPath(new URL('./desktop.ps1', import.meta.url))

/** WinRT 那层能真正写的参数（其余如 saturation / sharpness 只能靠 OpenCV 抓帧时带）。 */
const WRITABLE = {
  brightness: true,
  contrast: true,
  hue: true,
  wb_temperature: true,
  exposure: true,
  focus: true,
}

/** WinRT 的 VideoDeviceController 不暴露这几项，只能退回 OpenCV set（值域也是估的）。 */
const OPENCV_ONLY = {
  saturation: true,
  sharpness: true,
  gain: true,
  gamma: true,
}

const DEFAULT = {
  device: 0,
  width: 1280,
  height: 720,
  mirror: false,
  quality: 92,
  warmup: 12,
  outDir: '',
  params: {
    brightness: null,
    contrast: null,
    saturation: null,
    hue: null,
    gain: null,
    exposure: null,
    sharpness: null,
    gamma: null,
    wb_temperature: null,
    focus: null,
  },
}

function say(msg) {
  try {
    if (existsSync(LOG_PATH) && statSync(LOG_PATH).size > 256 * 1024) writeFileSync(LOG_PATH, '')
    appendFileSync(LOG_PATH, new Date().toISOString() + ' ' + msg + '\n', 'utf8')
  } catch (error) {}
  console.log('[感官] ' + msg)
}

function readCfg() {
  try {
    const p = JSON.parse(readFileSync(CFG_PATH, 'utf8'))
    const num = (v, d) => (Number.isFinite(v) ? v : d)
    const params = {}
    for (const k of Object.keys(DEFAULT.params)) {
      const v = p.params && p.params[k]
      params[k] = v === null || v === undefined || v === '' ? null : num(Number(v), null)
    }
    return {
      device: Math.max(0, num(Number(p.device), DEFAULT.device)),
      width: num(Number(p.width), DEFAULT.width),
      height: num(Number(p.height), DEFAULT.height),
      mirror: p.mirror === true,
      quality: Math.min(100, Math.max(30, num(Number(p.quality), DEFAULT.quality))),
      warmup: Math.min(60, Math.max(1, num(Number(p.warmup), DEFAULT.warmup))),
      outDir: typeof p.outDir === 'string' && p.outDir ? p.outDir : DEFAULT.outDir,
      params,
    }
  } catch (error) {
    return JSON.parse(JSON.stringify(DEFAULT))
  }
}

function writeCfg(patch) {
  const next = { ...readCfg(), ...(patch || {}) }
  if (patch && patch.params) next.params = { ...readCfg().params, ...patch.params }
  if (next.mirror !== true) next.mirror = false
  try {
    mkdirSync(HOME, { recursive: true })
    writeFileSync(CFG_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8')
  } catch (error) { say('写配置失败: ' + error.message) }
  return next
}

/** 跑一次 cam.py，拿它写出的 JSON。
 *  管道收不到 venv python 的 stdout，所以用 shell 重定向落到文件再读。
 *  临时文件放在工作区的 camera 目录下（那里确认可写），不用系统 tmpdir。 */
const RUN_DIR = join(HOME, 'camera-shots', '.runner')

function runCam(args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    if (!existsSync(PY)) { resolve({ ok: false, error: '找不到 python: ' + PY }); return }
    try { mkdirSync(RUN_DIR, { recursive: true }) } catch (mkdirError) {}
    const stamp2 = Date.now() + '-' + Math.random().toString(16).slice(2)
    const outFile = join(RUN_DIR, 'out-' + stamp2 + '.json')
    const errFile = join(RUN_DIR, 'err-' + stamp2 + '.txt')
    const q = (s) => '"' + String(s).replace(/"/g, '') + '"'
    const line = [q(PY), q(CAM_PY), ...args.map(q)].join(' ') + ' > ' + q(outFile) + ' 2> ' + q(errFile)
    say('run: ' + line)
    exec(line, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error) => {
      let text = ''
      try { text = readFileSync(outFile, 'utf8').trim() } catch (readError) {}
      let errText = ''
      try { errText = readFileSync(errFile, 'utf8').trim() } catch (readError2) {}
      say('run done: err=' + (error ? error.message : 'none') + ' outBytes=' + text.length + ' errBytes=' + errText.length)
      try { unlinkSync(outFile) } catch (cleanError) {}
      try { unlinkSync(errFile) } catch (cleanError2) {}

      // 从第一个 { 截到最后一个 }：JSON 里还有嵌套对象，用 lastIndexOf('{')
      // 会切到内层去，解析必然失败。
      const start = text.indexOf('{')
      const end = text.lastIndexOf('}')
      if (start >= 0 && end > start) {
        try { resolve(JSON.parse(text.slice(start, end + 1))); return } catch (parseError) {}
      }
      const tail = errText.slice(-300)
      if (error) {
        resolve({ ok: false, error: '摄像头调用失败: ' + (error.killed ? '超时' : error.message) + (tail ? '（' + tail + '）' : '') })
        return
      }
      resolve({ ok: false, error: 'python 没有返回 JSON' + (tail ? '（' + tail + '）' : '') })
    })
  })
}

function stamp() {
  const d = new Date()
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
}

// ---------- 实时预览流 ----------
// 同一台摄像头被两个 OpenCV 实例同时打开时，第二个拿到的是全黑帧（实测 5577 字节纯黑），
// 所以整个插件只维持一条流进程，多个浏览器客户端共享它推出来的数据。
const streamClients = new Set()
let streamChild = null
let streamInfo = null

/** 只收掉 python 进程，不动已连上的客户端（换参数时用，新流接着喂同一批客户端）。 */
function killStreamProc(reason) {
  if (!streamChild) return false
  say('收流进程' + (reason ? '（' + reason + '）' : ''))
  const child = streamChild
  streamChild = null
  streamInfo = null
  try { child.kill() } catch (error) {}
  return true
}

/** 进程和客户端一起收掉（抓帧要让出设备，或者已经没人看了）。 */
function stopStream(reason) {
  const had = killStreamProc(reason)
  if (streamClients.size) {
    for (const res of Array.from(streamClients)) {
      try { res.end() } catch (error) {}
    }
    streamClients.clear()
  }
  return had
}

function streamBusy() {
  return !!streamChild
}

function streamKey(opts) {
  return [opts.device, opts.width, opts.height, opts.fps, opts.quality, opts.mirror ? 1 : 0].join('/')
}

/** 保证有一条参数匹配的流在跑：参数一样就复用，不重启。 */
function ensureStream(opts) {
  const key = streamKey(opts)
  if (streamChild && streamInfo && streamInfo.key === key) return streamChild
  // 只收进程，客户端留着——新流起来接着喂它们
  killStreamProc('换参数')
  const args = [
    STREAM_PY,
    '--device', String(opts.device),
    '--width', String(opts.width),
    '--height', String(opts.height),
    '--fps', String(opts.fps),
    '--quality', String(opts.quality),
  ]
  if (opts.mirror) args.push('--mirror')
  say('开流 device=' + opts.device + ' ' + opts.width + 'x' + opts.height + ' @' + opts.fps + 'fps')
  const child = spawn(PY, args, { windowsHide: true })
  streamChild = child
  streamInfo = { ...opts, key, startedAt: Date.now() }
  // 手动广播而不是 pipe：一条流喂多个客户端，自己测试时也不会把界面那条踢掉
  child.stdout.on('data', (chunk) => {
    for (const res of Array.from(streamClients)) {
      try {
        if (!res.writableEnded) res.write(chunk)
        else streamClients.delete(res)
      } catch (error) { streamClients.delete(res) }
    }
  })
  child.stderr.on('data', (d) => {
    const text = String(d || '').trim()
    if (text) say('流 stderr: ' + text.slice(0, 240))
  })
  const dropAll = () => {
    for (const res of Array.from(streamClients)) { try { res.end() } catch (e) {} }
    streamClients.clear()
  }
  child.on('error', (error) => {
    say('流启动失败: ' + error.message)
    if (streamChild === child) { streamChild = null; streamInfo = null }
    dropAll()
  })
  child.on('exit', (code) => {
    if (streamChild === child) {
      // 不是我们主动换掉的：真出事了，连客户端一起收
      say('流进程退出 code=' + code)
      streamChild = null
      streamInfo = null
      dropAll()
    } else {
      say('旧流进程已退出（换参数），客户端等新流')
    }
  })
  return child
}

/** 抓帧前把流让开：流占着设备时另开实例只能读到黑帧。 */
async function yieldCamera(reason, waitMs = 450) {
  if (!streamBusy()) return false
  stopStream(reason)
  await new Promise((resolve) => setTimeout(resolve, waitMs))
  return true
}

/** 核心：抓一帧。UI 和工具都走这里，不写两份逻辑。 */
async function snapshot(opts = {}) {
  const cfg = readCfg()
  const explicitDevice = Number.isFinite(opts.device)
  const width = Number.isFinite(opts.width) && opts.width > 0 ? opts.width : cfg.width
  const height = Number.isFinite(opts.height) && opts.height > 0 ? opts.height : cfg.height
  const mirror = typeof opts.mirror === 'boolean' ? opts.mirror : cfg.mirror
  const outDir = typeof opts.outDir === 'string' && isAbsolute(opts.outDir) ? opts.outDir : cfg.outDir
  // 只认显式传入的参数：面板调参是直接写进设备（WinRT）的，设备状态自己会保持，
  // 这里再拿 OpenCV set 一遍反而可能因为两套量纲不同而把值改坏。
  const params = { ...(opts.params || {}) }

  try { mkdirSync(outDir, { recursive: true }) } catch (error) {}

  const buildArgs = (dev) => {
    const file = join(outDir, 'cam-' + stamp() + '-' + Math.random().toString(16).slice(2, 6) + '.jpg')
    const list = [
      'snap',
      '--device', String(dev),
      '--width', String(width),
      '--height', String(height),
      '--out', file,
      '--quality', String(cfg.quality),
      '--warmup', String(cfg.warmup),
    ]
    if (mirror) list.push('--mirror')
    for (const [key, value] of Object.entries(params)) {
      if (value === null || value === undefined) continue
      list.push('--' + key.replace(/_/g, '-'), String(value))
    }
    return list
  }

  const device = explicitDevice ? opts.device : cfg.device
  await yieldCamera('要抓帧')
  say('抓帧 device=' + device + ' ' + width + 'x' + height)
  let result = await runCam(buildArgs(device), 30000)

  // 配置里那台可能不在线（外接摄像头掉线是常态）。没显式指定设备时，
  // 退到第一台能出帧的，别让「拍一张」直接失败。
  if ((!result || !result.ok) && !explicitDevice) {
    const list = await listCameras()
    const alt = ((list && list.cameras) || []).find((c) => c.readable && c.index !== device)
    if (alt) {
      say('device ' + device + ' 打不开（' + ((result && result.error) || '') + '），回退到 ' + alt.index + ' ' + alt.name)
      const retry = await runCam(buildArgs(alt.index), 30000)
      if (retry && retry.ok) {
        retry.fallbackFrom = device
        result = retry
      }
    }
  }

  if (result && result.ok) say('抓到 ' + result.path + ' (' + result.width + 'x' + result.height + ')')
  else say('抓帧失败: ' + (result && result.error))
  return result
}

/** 把一批参数写进设备本身。
 *  能走 WinRT 的走 WinRT（值域权威、写进去是持久的），剩下的走 OpenCV。 */
async function applyParams(opts) {
  const device = Number.isFinite(opts.device) ? opts.device : readCfg().device
  const params = opts.params || {}
  const winArgs = ['set', '--device', String(device)]
  const ocvArgs = ['setocv', '--device', String(device)]
  if (opts.name) winArgs.push('--name', String(opts.name))
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) continue
    if (WRITABLE[key]) winArgs.push('--' + key.replace(/_/g, '-'), String(value))
    else if (OPENCV_ONLY[key]) ocvArgs.push('--' + key.replace(/_/g, '-'), String(value))
  }
  if (opts.autoExposure === true || opts.autoExposure === false) winArgs.push('--auto-exposure', opts.autoExposure ? '1' : '0')
  if (opts.autoWb === true || opts.autoWb === false) winArgs.push('--auto-wb', opts.autoWb ? '1' : '0')

  const applied = {}
  const failed = {}
  const via = []
  if (winArgs.length > 3) {
    const r = await runCam(winArgs, 45000)
    if (r && r.applied) Object.assign(applied, r.applied)
    if (r && r.failed) Object.assign(failed, r.failed)
    if (!r || !r.ok) failed.winrt = (r && r.error) || 'WinRT 写入失败'
    via.push('winrt')
  }
  if (ocvArgs.length > 3) {
    const r = await runCam(ocvArgs, 45000)
    if (r && r.applied) Object.assign(applied, r.applied)
    if (r && r.failed) Object.assign(failed, r.failed)
    if (!r || !r.ok) failed.opencv = (r && r.error) || 'OpenCV 写入失败'
    via.push('opencv')
  }
  if (!via.length) return { ok: false, error: '可写的参数只有：' + Object.keys(WRITABLE).concat(Object.keys(OPENCV_ONLY)).join(' / ') }
  return { ok: true, applied, failed, by: via.join('+') }
}

async function listCameras() {
  const args = ['list']
  // 预览流占着摄像头时，不许再拿 OpenCV 去逐个打开设备探它们 ——
  // 两个实例同开一台，后来那个会把先来的饿死（实测流一帧都读不出来）。
  if (streamBusy()) args.push('--no-probe')
  return runCam(args, 25000)
}

/**
 * 桌面感知：跑一次 desktop.ps1，拿「键鼠空闲多久 + 前台窗口」。
 * ⚠ 只在情绪引擎（mo-emotion）到点要数据时调，**不常驻、不轮询**。
 *   这个插件只负责「提供数据」：判断、阈值、要不要叫人都在情绪引擎那边——
 *   分工：情绪引擎只当触发器，执行交给相关插件。
 */
function probeDesktop() {
  return new Promise((resolve) => {
    if (!existsSync(DESKTOP_PS)) {
      resolve({ ok: false, error: '找不到 desktop.ps1' })
      return
    }
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', DESKTOP_PS],
      { timeout: 15000, windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) { resolve({ ok: false, error: error.message }); return }
        const lines = String(stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
        const line = lines.length ? lines[lines.length - 1] : ''
        try {
          const obj = JSON.parse(line)
          if (!obj || typeof obj !== 'object') { resolve({ ok: false, error: '空结果' }); return }
          resolve(obj)
        } catch {
          resolve({ ok: false, error: '结果解析失败: ' + line.slice(0, 160) })
        }
      },
    )
  })
}

export function apply(ctx) {
  say('apply start, version=' + VERSION)
  const cfg = readCfg()

  // ---------- 1. Agent 工具：眼 ----------
  if (ctx && ctx.tools && typeof ctx.tools.register === 'function') {
    try {
      ctx.tools.register({
        name: 'camera',
        description:
          '「眼」：用本机摄像头看一眼现实世界，返回照片的落盘路径（配合 read_image 就能看到）。'
          + ' action=list 列出现有摄像头，action=snap 拍一张，action=info 读当前参数，action=caps 探测哪些参数这个摄像头真的支持。'
          + ' 只在用户要求看现实、或者需要确认摄像头状态时调用；默认不主动拍。拍之前可以先 list 看有哪些设备。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: { type: 'string', enum: ['list', 'snap', 'info', 'caps', 'range', 'set'], description: '要做什么，默认 snap：list 列设备 / snap 拍一张 / info 读当前值 / caps 探测支持 / range 读权威值域与当前值 / set 改参数' },
            device: { type: 'number', description: '摄像头序号（0 开始），不给就用设置里的默认' },
            width: { type: 'number', description: '宽，如 1920' },
            height: { type: 'number', description: '高，如 1080' },
            mirror: { type: 'boolean', description: '左右翻转' },
            params: {
              type: 'object',
              additionalProperties: false,
              description: '手动覆盖的摄像头参数，不填就用设置里的默认',
              properties: {
                brightness: { type: 'number' },
                contrast: { type: 'number' },
                saturation: { type: 'number' },
                hue: { type: 'number' },
                gain: { type: 'number' },
                exposure: { type: 'number' },
                sharpness: { type: 'number' },
                gamma: { type: 'number' },
                wb_temperature: { type: 'number' },
                focus: { type: 'number' },
              },
            },
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: true,
            properties: {
              ok: { type: 'boolean' },
              path: { type: 'string' },
              width: { type: 'number' },
              height: { type: 'number' },
              cameras: { type: 'array' },
            },
          },
          render: (_args, value) => {
            const v = value || {}
            if (v.ok === false) return [{ type: 'text', text: '出错了：' + (v.error || '未知原因') }]
            if (Array.isArray(v.cameras)) {
              const list = v.cameras.map((c) => '  [' + c.index + '] ' + c.name + '  ' + c.width + 'x' + c.height).join('\n')
              return [{ type: 'text', text: '摄像头 ' + v.cameras.length + ' 个：\n' + list }]
            }
            if (v.props) {
              const p = Object.entries(v.props).map(([k, x]) => '  ' + k + ' = ' + x).join('\n')
              return [{ type: 'text', text: '当前参数（' + v.width + 'x' + v.height + '）：\n' + p }]
            }
            if (v.support) {
              const p = Object.entries(v.support).map(([k, x]) => '  ' + k + ' = ' + (x && x.writable ? '可调（' + x.value + '）' : '不支持')).join('\n')
              return [{ type: 'text', text: '参数支持情况：\n' + p }]
            }
            if (v.controls) {
              const rows = Object.entries(v.controls).map(([k, x]) => {
                if (!x || x.supported === false) return '  ' + k + ' = 不支持'
                const span = Number.isFinite(x.min) && Number.isFinite(x.max) ? '  [' + x.min + ' ~ ' + x.max + (x.guessRange ? '，估的' : '') + ']' : ''
                return '  ' + k + ' = ' + (x.value === null || x.value === undefined ? '?' : x.value) + span
              }).join('\n')
              return [{ type: 'text', text: '设备：' + (v.name || ('#' + v.index)) + '（' + (v.source || '?') + '）\n' + rows }]
            }
            if (v.applied && !v.path) {
              const ok = Object.entries(v.applied).map(([k, x]) => '  ' + k + ' → ' + x).join('\n')
              const bad = v.failed && Object.keys(v.failed).length
                ? '\n没写成：\n' + Object.entries(v.failed).map(([k, x]) => '  ' + k + ': ' + x).join('\n')
                : ''
              return [{ type: 'text', text: '写入结果：\n' + ok + bad }]
            }
            if (v.path) {
              return [{ type: 'text', text: '拍到一张：' + v.path + '（' + v.width + 'x' + v.height + '，' + Math.round((v.bytes || 0) / 1024) + ' KB）' }]
            }
            return [{ type: 'text', text: JSON.stringify(v).slice(0, 500) }]
          },
        },
        isConcurrencySafe: () => false,
        async execute(args) {
          const a = args || {}
          const action = a.action || 'snap'
          if (action === 'list') return await listCameras()
          if (action === 'info') {
            const dev = Number.isFinite(a.device) ? a.device : readCfg().device
            return await runCam(['info', '--device', String(dev)], 25000)
          }
          if (action === 'caps') {
            const dev = Number.isFinite(a.device) ? a.device : readCfg().device
            const args = ['caps', '--device', String(dev)]
            if (streamBusy()) args.push('--no-probe')
            return await runCam(args, 40000)
          }
          if (action === 'range') {
            const dev = Number.isFinite(a.device) ? a.device : readCfg().device
            const args = ['range', '--device', String(dev)]
            if (streamBusy()) args.push('--no-probe')
            return await runCam(args, 45000)
          }
          if (action === 'set') {
            return await applyParams({ device: a.device, params: a.params })
          }
          return await snapshot({
            device: a.device,
            width: a.width,
            height: a.height,
            mirror: a.mirror,
            params: a.params,
          })
        },
      })
      say('camera 工具已注册')
    } catch (error) {
      say('注册 camera 工具失败: ' + error.message)
    }
  } else {
    say('没有 tools 服务，工具没挂上')
  }

  // ---------- 2. HTTP 路由：给设置页 ----------
  const web = ctx.get ? (ctx.get('webServer') || null) : null
  if (!web || typeof web.register !== 'function') {
    say('没有 webServer，界面接口没挂上')
    return
  }

  const routes = {}
  const route = (method, path, handler) => { routes[method + ' ' + path] = handler }

  /** 桌面感知：给情绪引擎要数据用的只读接口（键鼠空闲 + 前台窗口）。 */
  route('GET', '/desktop', async (req, res) => {
    const r = await probeDesktop()
    sendJson(res, r.ok ? 200 : 500, r)
  })

  /** 看一眼摄像头里有没有人（情绪引擎 60 分那级用）：本地 Haar 检测，不联网不花 token。
   *  ⚠ 只看一眼就删：图落在系统临时目录，cam.py 检测完立刻删掉，不在盘上留照片。
   *  ⚠ 只认正脸，低头/侧脸/背光会漏——返回里带 undecided / brightness，让调用方别硬判。 */
  route('GET', '/person', async (req, res) => {
    try {
      const c = readCfg()
      const out = join(RUN_DIR, 'look-' + Date.now() + '.jpg')
      const r = await runCam([
        'person',
        '--device', String(c.device),
        '--width', String(c.width),
        '--height', String(c.height),
        '--out', out,
        ...(c.mirror ? ['--mirror'] : []),
      ], 25000)
      // 万一 python 没删干净，这边再兜一次
      try { unlinkSync(out) } catch { /* 本来就没落地 */ }
      sendJson(res, r.ok ? 200 : 500, r)
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message })
    }
  })

  route('GET', '/status', async (req, res) => {
    const c = readCfg()
    sendJson(res, 200, { ok: true, version: readVersion(), config: c, stream: streamBusy() ? streamInfo : null })
  })

  route('GET', '/devices', async (req, res) => {
    const r = await listCameras()
    sendJson(res, r.ok ? 200 : 500, r)
  })

  route('POST', '/config', async (req, res) => {
    try {
      const body = await readBody(req)
      const next = writeCfg(body || {})
      sendJson(res, 200, { ok: true, config: next })
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message })
    }
  })

  route('POST', '/snap', async (req, res) => {
    try {
      const body = await readBody(req)
      const r = await snapshot(body || {})
      sendJson(res, r.ok ? 200 : 500, r)
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message })
    }
  })

  /** 实时预览：一条长连接连续推 JPEG。
   *  格式沿用 MJPEG 的边界写法（--frame + Content-Length），但 Content-Type 用中性类型，
   *  由前端 fetch 读流、自己切帧画 canvas。 */
  route('GET', '/stream', async (req, res, url) => {
    const q = url && url.searchParams ? url.searchParams : null
    const c = readCfg()
    const num = (v, d) => (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d)
    const opts = {
      device: num(q && q.get('device'), c.device),
      width: num(q && q.get('width'), c.width),
      height: num(q && q.get('height'), c.height),
      fps: Math.max(1, Math.min(30, num(q && q.get('fps'), 15))),
      quality: Math.max(40, Math.min(90, num(q && q.get('quality'), 75))),
      mirror: q && q.get('mirror') === '1' ? true : (q && q.get('mirror') === '0' ? false : c.mirror),
    }
    if (!existsSync(STREAM_PY)) { sendJson(res, 500, { ok: false, error: '找不到 stream.py' }); return }
    if (!existsSync(PY)) { sendJson(res, 500, { ok: false, error: '找不到 python: ' + PY }); return }
    res.writeHead(200, {
      // ⚠️ 千万别写成 multipart/x-mixed-replace：Chromium 认得这个类型，会派它的
      // 「多部分文档」加载器去解析，fetch 拿到的 body 变成按帧节奏吐（实测 1 fps），
      // 画面就一直停在首帧（黑的）。用中性类型，前端自己切帧。
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
      'X-Accel-Buffering': 'no',
    })
    if (typeof res.flushHeaders === 'function') { try { res.flushHeaders() } catch (e) {} }
    streamClients.add(res)
    try {
      ensureStream(opts)
    } catch (error) {
      say('开流异常: ' + error.message)
      streamClients.delete(res)
      try { res.end() } catch (e) {}
    }
    const cleanup = () => {
      streamClients.delete(res)
      // 没有客户端了就把 python 收掉，别在后台一直占着摄像头
      if (streamClients.size === 0) stopStream('客户端都走了')
    }
    // 只挂 res 的 close：Node 16+ 的 req.on('close') 在请求体读完时就会触发，
    // 挂它会在一开始就把自己摘掉（实测流刚开就被停）。
    res.on('close', cleanup)
  })

  route('GET', '/frame', async (req, res, url) => {
    // 预览用：拍一张直接回图，不落盘给人看路径
    const q = url && url.searchParams ? url.searchParams : null
    const opts = {}
    if (q) {
      if (q.get('device') !== null) opts.device = Number(q.get('device'))
      if (q.get('width') !== null) opts.width = Number(q.get('width'))
      if (q.get('height') !== null) opts.height = Number(q.get('height'))
      if (q.get('mirror') === '1') opts.mirror = true
    }
    const r = await snapshot(opts)
    if (!r.ok || !r.path) { sendJson(res, 500, r); return }
    try {
      const buf = readFileSync(r.path)
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': String(buf.length), 'Cache-Control': 'no-store' })
      res.end(buf)
    } catch (error) {
      sendJson(res, 500, { ok: false, error: '读图失败: ' + error.message })
    }
  })

  route('GET', '/info', async (req, res, url) => {
    const q = url && url.searchParams ? url.searchParams : null
    const dev = q && q.get('device') !== null ? Number(q.get('device')) : readCfg().device
    const r = await runCam(['info', '--device', String(dev)], 25000)
    sendJson(res, r.ok ? 200 : 500, r)
  })

  route('GET', '/caps', async (req, res, url) => {
    const q = url && url.searchParams ? url.searchParams : null
    const dev = q && q.get('device') !== null ? Number(q.get('device')) : readCfg().device
    const r = await runCam(['caps', '--device', String(dev)], 40000)
    sendJson(res, r.ok ? 200 : 500, r)
  })

  /** 读设备权威范围（WinRT）+ 当前值。面板打开时先要这个，滑块才有正确的值域。 */
  route('GET', '/range', async (req, res, url) => {
    const q = url && url.searchParams ? url.searchParams : null
    const dev = q && q.get('device') !== null ? Number(q.get('device')) : readCfg().device
    const args = ['range', '--device', String(dev)]
    const nm = q && q.get('name')
    if (nm) args.push('--name', String(nm))
    if (streamBusy()) args.push('--no-probe')
    const r = await runCam(args, 45000)
    sendJson(res, r.ok ? 200 : 500, r)
  })

  /** 把参数写进设备本身（WinRT / OpenCV），不写在配置里当摆设。 */
  route('POST', '/set', async (req, res) => {
    try {
      const body = (await readBody(req)) || {}
      const r = await applyParams({
        device: body.device,
        name: body.name,
        params: body.params,
        autoExposure: body.autoExposure,
        autoWb: body.autoWb,
      })
      // 写成功的项顺手记进配置，界面下次打开能显示「上次设置」
      if (r && r.ok && r.applied) {
        const patch = {}
        for (const [key, value] of Object.entries(r.applied)) {
          if (Number.isFinite(Number(value))) patch[key] = Number(value)
        }
        if (Object.keys(patch).length) writeCfg({ params: patch })
      }
      sendJson(res, r.ok ? 200 : 400, r)
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message })
    }
  })

  // ---------- 2.7 手：桌面自动化（2026-11-11 从 dsh-mo-hands 搬入，能力可以按项关闭） ----------
  try {
    mountHands(ctx, { route, say })
    mountApps(ctx, { route, say })
  } catch (error) {
    say('挂「手」失败: ' + error.message)
  }

  // ---------- 2.6 耳：语音输入（2026-11-11 从 dsh-voice-panel 整体搬入，路由仍是 /dsh-voice） ----------
  try {
    applyVoiceInput(ctx)
  } catch (error) {
    say('挂「耳」（语音输入）失败: ' + error.message)
  }

  // ---------- 2.5 口：本地 IndexTTS 朗读（2026-10-29 从 dsh-voice-out 搬进来） ----------
  try {
    mountVoice(ctx, { route, say, version: readVersion() })
  } catch (error) {
    say('挂「口」（朗读）失败: ' + error.message)
  }

  // ⚠️ 必须给 kind：WebRoute 的 identity 是 (kind, path)，缺 kind 时每次 remove/install
  // 都会撞上同一个 (undefined, /dsh-whale-senses)，报 duplicate route 且只有重启能清。
  // 用 ctx.effect 把 disposer 交给框架，卸载时自动摘掉。
  const effect = typeof ctx.effect === 'function' ? (fn) => ctx.effect(fn) : (fn) => fn()
  // 插件卸载时别留一个 python 在后台占着摄像头
  effect(() => () => stopStream('插件卸载'))
  try {
    effect(() => web.register({
      kind: 'prefix',
      path: ROUTE,
      handler: async (req, res) => {
        if (denyNonLoopback(req, res)) return
        let url
        try {
          url = new URL(req.url || '/', 'http://127.0.0.1')
        } catch (error) {
          sendJson(res, 400, { ok: false, error: '请求地址不合法' })
          return
        }
        const pathname = url.pathname
        if (!pathname.startsWith(ROUTE)) { sendJson(res, 404, { ok: false, error: 'not found' }); return }
        const key = String(req.method || 'GET').toUpperCase() + ' ' + pathname.slice(ROUTE.length)
        const hit = routes[key]
        if (!hit) { sendJson(res, 404, { ok: false, error: '没有这个接口: ' + key }); return }
        try {
          await hit(req, res, url)
        } catch (error) {
          say('接口出错 ' + key + ': ' + error.message)
          try { sendJson(res, 500, { ok: false, error: error.message }) } catch (e2) {}
        }
      },
    }))
    say('接口挂载完成，共 ' + Object.keys(routes).length + ' 条')
  } catch (error) {
    say('挂接口失败: ' + error.message)
  }
}
