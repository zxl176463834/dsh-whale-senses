/**
 * 耳 · 语音输入 Host 半边（2026-11-11 从 dsh-voice-panel 整体搬进 dsh-whale-senses）。
 *
 * 四组接口：
 *   /dsh-voice/status     读引擎状态（给设置页）
 *   /dsh-voice/selection  写识别器/语言偏好
 *   /dsh-voice/config     读写快捷键配置（~/.dsh/dsh-voice.config.json）
 *   /dsh-voice/transcribe 浏览器录好的 WAV → 本地引擎转写（快捷键录音用）
 *
 * 服务是可选的：没有启用 @deepseek-ai/dsh-experimental-voice-input-bundle 时
 * ctx.get('speechToText') 是 undefined，接口返回 available:false，面板据此提示。
 */
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ROUTE, readBody, sendJson, denyNonLoopback } from './http.js'
import { GlobalHotkeyHost } from './global-hotkey.js'

export const inject = ['webServer']

/** 与客户端面板视为「能用」的 phase 保持一致。 */
const USABLE_PHASES = new Set(['ready', 'standby', 'waking'])

/** 插件版本（读自身 package.json；读不到就空串，界面不显示）。 */
const VERSION = (() => {
  try {
    return String(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version || '')
  } catch {
    return ''
  }
})()

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const CONFIG_PATH = join(HOME, 'dsh-voice.config.json')
const LOG_PATH = join(HOME, 'dsh-voice.log')
const DEFAULT_CONFIG = { hotkey: 'Ctrl+Shift+Space', enabled: true, globalHotkey: '', globalEnabled: false, deviceId: '', silenceStopMs: 1000, autoSend: false, autoSendDelayMs: 1000, polish: false, wakeEnabled: false, wakeWord: '小鲸，小鲸' }

const POLISH_PROMPT = [
  '你是语音输入的整理助手。把下面这段语音转写整理成通顺的书面语：',
  '去掉语气词、口癖和重复，补全标点，修正明显的同音错字，保留原意和说话人的语气。',
  '不要添加原文没有的信息，不要解释，只输出整理后的文本。',
  '',
  '原文：',
].join('\n')

/** 用当前默认模型把口语整理成书面语。 */
async function polishText(ctx, text) {
  const llm = ctx.get('llm')
  let selection = null
  try {
    const defaults = ctx.get('agentDefaultModel')
    if (defaults && typeof defaults.currentSelection === 'function') selection = defaults.currentSelection()
  } catch {}
  if (!llm || !selection || !selection.provider || !selection.model) {
    throw new Error('没有可用的默认模型，无法整理')
  }
  const base = await llm.resolveCallConfig({ provider: selection.provider, model: selection.model, maxTokens: 2048 })
  const prepared = await llm.prepareCall(base)
  let out = ''
  try {
    for await (const chunk of prepared.stream({
      ...base,
      messages: [{ role: 'user', content: [{ type: 'text', text: POLISH_PROMPT + text }] }],
    })) {
      if (chunk.type === 'text-delta') out += chunk.text
      else if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
        throw new Error('模型调用失败：' + ((chunk.reason.failure && chunk.reason.failure.message) || '未知原因'))
      }
    }
  } catch (error) {
    const cause = error && error.cause && error.cause.message ? '（' + error.cause.message + '）' : ''
    throw new Error((error && error.message ? error.message : String(error)) + cause)
  }
  return out.trim()
}

/** 简单请求日志：排查「面板有没有真的发出请求」。超过 256KB 自清。 */
function logRequest(req, pathname, note) {
  try {
    const stamp = new Date().toISOString()
    if (existsSync(LOG_PATH) && statSync(LOG_PATH).size > 256 * 1024) writeFileSync(LOG_PATH, '')
    appendFileSync(LOG_PATH, `${stamp} ${req.method} ${pathname}${note ? ' ' + note : ''}\n`, 'utf8')
  } catch {}
}

const TRANSCRIBE_BODY_LIMIT = 12 * 1024 * 1024
const TRANSCRIBE_TIMEOUT_MS = 120_000

function readConfig() {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    return {
      hotkey: typeof parsed.hotkey === 'string' && parsed.hotkey ? parsed.hotkey : DEFAULT_CONFIG.hotkey,
      enabled: parsed.enabled !== false,
      globalHotkey: typeof parsed.globalHotkey === 'string' ? parsed.globalHotkey : '',
      globalEnabled: parsed.globalEnabled === true,
      deviceId: typeof parsed.deviceId === 'string' ? parsed.deviceId : '',
      silenceStopMs: Number.isFinite(parsed.silenceStopMs)
        ? Math.min(10000, Math.max(0, Math.round(parsed.silenceStopMs)))
        : DEFAULT_CONFIG.silenceStopMs,
      autoSend: parsed.autoSend === true,
      autoSendDelayMs: Number.isFinite(parsed.autoSendDelayMs)
        ? Math.min(10000, Math.max(0, Math.round(parsed.autoSendDelayMs)))
        : DEFAULT_CONFIG.autoSendDelayMs,
      polish: parsed.polish === true,
      wakeEnabled: parsed.wakeEnabled === true,
      wakeWord: typeof parsed.wakeWord === 'string' && parsed.wakeWord.trim() ? parsed.wakeWord.trim() : DEFAULT_CONFIG.wakeWord,
    }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

function writeConfig(patch) {
  const next = { ...readConfig(), ...patch }
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8')
  return next
}

function snapshotOf(speech) {
  const snapshot = speech.snapshot()
  const providers = snapshot.providers.map((provider) => ({
    id: provider.id,
    name: provider.name,
    location: provider.location,
    languages: provider.languages,
    preparation: provider.preparation ?? { phase: 'ready' },
    usable: USABLE_PHASES.has((provider.preparation && provider.preparation.phase) || 'ready'),
  }))
  return {
    ok: true,
    available: true,
    selection: snapshot.selection,
    providers,
    usable: providers.some((provider) => provider.id === snapshot.selection.providerId && provider.usable),
  }
}

export function apply(ctx) {
  const webServer = ctx.webServer ?? ctx.get('webServer')
  if (!webServer) {
    console.warn('[dsh-voice-panel] 没有 webServer，管理接口未注册')
    return
  }

  const speechOf = () => {
    try {
      return ctx.get('speechToText')
    } catch {
      return undefined
    }
  }

  // ---- 全局快捷键 + 事件推送 ----
  const sseClients = new Set()
  const broadcast = (payload) => {
    const text = `data: ${JSON.stringify(payload)}\n\n`
    for (const client of sseClients) {
      try { client.write(text) } catch { sseClients.delete(client) }
    }
  }
  const heartbeat = setInterval(() => {
    for (const client of sseClients) {
      try { client.write(': ping\n\n') } catch { sseClients.delete(client) }
    }
  }, 15000)
  if (typeof heartbeat.unref === 'function') heartbeat.unref()

  const baseHost = webServer.host === '0.0.0.0' ? '127.0.0.1' : (webServer.host || '127.0.0.1')
  const globalHost = new GlobalHotkeyHost(`http://${baseHost}:${webServer.port}${ROUTE}/global-toggle`)
  globalHost.apply(readConfig())

  ctx.effect(() => () => {
    clearInterval(heartbeat)
    globalHost.stop()
    for (const client of sseClients) {
      try { client.end() } catch {}
    }
    sseClients.clear()
  })

  ctx.effect(() =>
    webServer.register({
      kind: 'prefix',
      path: ROUTE,
      async handler(req, res) {
        if (denyNonLoopback(req, res)) return
        const pathname = String(req.url || '').split('?')[0]
        logRequest(req, pathname)

        try {
          if (req.method === 'GET' && pathname === ROUTE + '/events') {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream; charset=utf-8',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
            })
            res.write(': connected\n\n')
            sseClients.add(res)
            req.on('close', () => sseClients.delete(res))
            return
          }

          if (req.method === 'POST' && pathname === ROUTE + '/global-toggle') {
            broadcast({ type: 'toggle', at: Date.now() })
            sendJson(res, 200, { ok: true })
            return
          }
          if (req.method === 'GET' && pathname === ROUTE + '/status') {
            const speech = speechOf()
            if (!speech) {
              sendJson(res, 200, {
                ok: true,
                available: false,
                version: VERSION,
                message: '语音输入服务未启用（需要 @deepseek-ai/dsh-experimental-voice-input-bundle）',
              })
              return
            }
            sendJson(res, 200, { ...snapshotOf(speech), version: VERSION })
            return
          }

          if (req.method === 'PUT' && pathname === ROUTE + '/selection') {
            const speech = speechOf()
            if (!speech) {
              sendJson(res, 409, { ok: false, error: '语音输入服务未启用' })
              return
            }
            const body = await readBody(req)
            const patch = {}
            if (typeof body.providerId === 'string' && body.providerId) patch.providerId = body.providerId
            if (typeof body.language === 'string' && body.language) patch.language = body.language
            if (Object.keys(patch).length === 0) {
              sendJson(res, 400, { ok: false, error: '没有要保存的字段' })
              return
            }
            await speech.configure(patch)
            sendJson(res, 200, snapshotOf(speech))
            return
          }

          if (req.method === 'POST' && pathname === ROUTE + '/prepare') {
            const speech = speechOf()
            if (!speech) {
              sendJson(res, 409, { ok: false, error: '语音输入服务未启用' })
              return
            }
            const body = await readBody(req)
            const id = typeof body.providerId === 'string' && body.providerId
              ? body.providerId
              : speech.snapshot().selection.providerId
            const options = typeof body.downloadSource === 'string' && body.downloadSource
              ? { downloadSource: body.downloadSource }
              : undefined
            speech.prepare(id, options)
            sendJson(res, 200, snapshotOf(speech))
            return
          }

          if (req.method === 'POST' && pathname === ROUTE + '/cancel') {
            const speech = speechOf()
            if (!speech) {
              sendJson(res, 409, { ok: false, error: '语音输入服务未启用' })
              return
            }
            const body = await readBody(req)
            const id = typeof body.providerId === 'string' && body.providerId
              ? body.providerId
              : speech.snapshot().selection.providerId
            await speech.cancelPreparation(id)
            sendJson(res, 200, snapshotOf(speech))
            return
          }

          if (req.method === 'GET' && pathname === ROUTE + '/config') {
            sendJson(res, 200, {
              ok: true,
              config: readConfig(),
              defaults: { ...DEFAULT_CONFIG },
              globalActive: globalHost.current,
            })
            return
          }

          if (req.method === 'PUT' && pathname === ROUTE + '/config') {
            const body = await readBody(req)
            logRequest(req, pathname, 'body=' + JSON.stringify(body))
            const patch = {}
            if (typeof body.hotkey === 'string' && body.hotkey.trim()) patch.hotkey = body.hotkey.trim()
            if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
            if (typeof body.globalHotkey === 'string') patch.globalHotkey = body.globalHotkey.trim()
            if (typeof body.globalEnabled === 'boolean') patch.globalEnabled = body.globalEnabled
            if (typeof body.deviceId === 'string') patch.deviceId = body.deviceId
            if (Number.isFinite(body.silenceStopMs)) {
              patch.silenceStopMs = Math.min(10000, Math.max(0, Math.round(body.silenceStopMs)))
            }
            if (typeof body.autoSend === 'boolean') patch.autoSend = body.autoSend
            if (Number.isFinite(body.autoSendDelayMs)) {
              patch.autoSendDelayMs = Math.min(10000, Math.max(0, Math.round(body.autoSendDelayMs)))
            }
            if (typeof body.polish === 'boolean') patch.polish = body.polish
            if (typeof body.wakeEnabled === 'boolean') patch.wakeEnabled = body.wakeEnabled
            if (typeof body.wakeWord === 'string' && body.wakeWord.trim()) patch.wakeWord = body.wakeWord.trim()
            if (Object.keys(patch).length === 0) {
              sendJson(res, 400, { ok: false, error: '没有要保存的字段' })
              return
            }
            const next = writeConfig(patch)
            const active = globalHost.apply(next)
            sendJson(res, 200, {
              ok: true,
              config: next,
              defaults: { ...DEFAULT_CONFIG },
              globalActive: active,
              globalError: next.globalEnabled && next.globalHotkey && !active ? '全局快捷键注册失败（格式或占用冲突）' : '',
            })
            return
          }

          if (req.method === 'POST' && pathname === ROUTE + '/transcribe') {
            const speech = speechOf()
            if (!speech) {
              sendJson(res, 409, { ok: false, error: '语音输入服务未启用' })
              return
            }
            const body = await readBody(req, TRANSCRIBE_BODY_LIMIT)
            const audio = typeof body.audioBase64 === 'string' ? Buffer.from(body.audioBase64, 'base64') : null
            if (!audio || audio.length === 0) {
              sendJson(res, 400, { ok: false, error: '没有音频数据' })
              return
            }
            const request = { audio }
            if (typeof body.language === 'string' && body.language) request.language = body.language
            let spec
            try {
              spec = speech.resolve(request)
            } catch (error) {
              sendJson(res, 409, { ok: false, error: error instanceof Error ? error.message : String(error) })
              return
            }
            const signal = AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS)
            try {
              const result = await speech.transcribe(spec, signal)
              sendJson(res, 200, {
                ok: true,
                text: result.text,
                providerId: spec.provider.info.id,
                language: spec.language,
                audioSeconds: result.audioSeconds,
                inferenceSeconds: result.inferenceSeconds,
              })
            } catch (error) {
              const invalid = error && error.name === 'SpeechInputError'
              sendJson(res, invalid ? 400 : 500, {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              })
            }
            return
          }

          if (req.method === 'POST' && pathname === ROUTE + '/polish') {
            const body = await readBody(req, 256 * 1024)
            const text = typeof body.text === 'string' ? body.text.trim() : ''
            if (!text) {
              sendJson(res, 400, { ok: false, error: '没有文本' })
              return
            }
            try {
              const polished = await polishText(ctx, text)
              sendJson(res, 200, { ok: true, text: polished || text })
            } catch (error) {
              // 整理失败不阻塞插入：前端拿到 ok:false 就退回原文
              logRequest(req, pathname, 'error=' + (error instanceof Error ? error.message : String(error)))
              sendJson(res, 200, {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              })
            }
            return
          }

          sendJson(res, 404, { ok: false, error: 'not found' })
        } catch (error) {
          sendJson(res, 500, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      },
    }),
  )
}
