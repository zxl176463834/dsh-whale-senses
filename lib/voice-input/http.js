/**
 * dsh-voice-panel — 极小的 HTTP 工具集（只服务本插件）。
 *
 * 所有路由只接受本机回环请求：音频/配置都不该被局域网里的其他机器碰到。
 */

export const ROUTE = '/dsh-voice'

const MAX_BODY_BYTES = 64 * 1024
/** 判断请求是否来自本机回环；非回环直接回 403。 */
export function denyNonLoopback(req, res) {
  const raw = req.socket && req.socket.remoteAddress
  const address = typeof raw === 'string' ? raw : ''
  const loopback =
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1' ||
    address.startsWith('127.')
  if (loopback) return false
  res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ ok: false, error: '只接受本机请求' }))
  return true
}

/** 读取 JSON 请求体；超限（默认 64KB，音频接口单独放宽）或解析失败抛错。 */
export function readBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/** 统一的 JSON 响应。 */
export function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(body)),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}
