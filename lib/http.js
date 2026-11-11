/** dsh-whale-senses — 极小的 HTTP 工具集（只接受本机回环请求）。 */
export const ROUTE = '/dsh-whale-senses'

export function denyNonLoopback(req, res) {
  const raw = req.socket && req.socket.remoteAddress
  const address = typeof raw === 'string' ? raw : ''
  const loopback = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1' || address.startsWith('127.')
  if (loopback) return false
  res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ ok: false, error: '只接受本机请求' }))
  return true
}

export function readBody(req, maxBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) { reject(new Error('请求体过大')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) { resolve({}); return }
      try { resolve(JSON.parse(text)) } catch { reject(new Error('请求体不是合法 JSON')) }
    })
    req.on('error', reject)
  })
}

export function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(body)),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}
