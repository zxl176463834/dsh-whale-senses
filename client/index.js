/**
 * dsh-whale-senses — Client 半边。
 *
 * 设置页「鲸的感官」：眼 / 耳 / 口 三个页签。
 *   眼：选摄像头、分辨率、镜像、画面参数（值域从设备读，不再硬编码）、预览、拍一张
 *   耳：语音输入（2026-11-11 从 dsh-voice-panel 搬入：识别、快捷键、唤醒词都在这一个插件里）
 *   口：本地 IndexTTS 朗读（2026-10-29 从 dsh-voice-out 搬进来，路由 /voice/*）
 *   对话页还有一颗朗读小药丸（原 dsh-voice-out 的 Pill），可拖动、会记住位置。
 *
 * 眼、耳、口现在都在一个插件里，设置页能看到「鲸的感官」和「语音输入（耳）」两节。
 */
window.__ModuleLoader__.load({
  id: 'dsh-whale-senses',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    const BASE = '/dsh-whale-senses'
    const VOICE_IN = '/dsh-voice'
    /** 朗读 2026-10-29 搬进本插件：路由挂在 /dsh-whale-senses/voice/* */
    const VOICE_OUT = BASE + '/voice'

    // 主题 token 带兜底：token 名变了只是掉回字面色，不会白屏
    const T = {
      text: 'var(--dsw-alias-text-primary, #e8f2ff)',
      dim: 'var(--dsw-alias-text-secondary, #9fb4c8)',
      bg: 'var(--dsw-alias-bg-elevated, rgba(20,34,50,.72))',
      bg2: 'var(--dsw-alias-bg-base, rgba(12,22,34,.55))',
      line: 'var(--dsw-alias-border-subtle, rgba(120,170,220,.22))',
      accent: 'var(--dsw-alias-accent-primary, #48a9ff)',
      ok: 'var(--dsw-alias-text-success, #3fcf8e)',
      warn: 'var(--dsw-alias-text-warning, #f0b429)',
    }

    async function req(url, options) {
      const res = await fetch(url, options || {})
      const type = String(res.headers.get('content-type') || '')
      if (!type.includes('json')) {
        if (!res.ok) throw new Error('HTTP ' + res.status)
        return res
      }
      const json = await res.json().catch(() => ({}))
      if (!res.ok || json.ok === false) throw new Error(json.error || ('HTTP ' + res.status))
      return json
    }

    function api(path, body, method) {
      if (body === undefined) return req(BASE + path)
      return req(BASE + path, {
        method: method || 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    }

    function apiVoice(base, path, body, method) {
      if (body === undefined) return req(base + path)
      return req(base + path, {
        method: method || 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    }

    const card = {
      border: '1px solid ' + T.line,
      borderRadius: 10,
      padding: 12,
      marginBottom: 12,
      background: T.bg2,
    }
    const label = { color: T.dim, fontSize: 12, marginBottom: 6, display: 'block' }
    const row = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }
    const btn = (active) => ({
      border: '1px solid ' + (active ? T.accent : T.line),
      background: active ? 'rgba(72,169,255,.22)' : 'transparent',
      color: T.text,
      borderRadius: 8,
      padding: '5px 12px',
      fontSize: 13,
      cursor: 'pointer',
    })
    const inputS = {
      background: T.bg,
      border: '1px solid ' + T.line,
      color: T.text,
      borderRadius: 8,
      padding: '5px 8px',
      fontSize: 13,
      outline: 'none',
    }
    const smallBtn = { ...btn(false), padding: '2px 8px', fontSize: 11 }

    const RESOLUTIONS = ['640x480', '1280x720', '1920x1080', '2560x1440']

    // 顺序即界面顺序；wb_temperature 只在设备真支持时才出现
    const KNOBS = [
      ['brightness', '亮度'],
      ['contrast', '对比度'],
      ['saturation', '饱和度'],
      ['hue', '色相'],
      ['wb_temperature', '色温'],
      ['sharpness', '锐度'],
      ['exposure', '曝光'],
      ['gain', '增益'],
      ['gamma', '伽马'],
      ['focus', '对焦'],
    ]

    function Switch({ on, onChange, text, hint }) {
      return h('label', {
        style: { ...row, color: T.text, fontSize: 13, cursor: 'pointer', gap: 6 },
        title: hint || '',
      },
        h('input', { type: 'checkbox', checked: !!on, onChange: (e) => onChange(e.target.checked) }),
        text,
      )
    }

    function Line({ k, v, tone }) {
      return h('div', { style: { ...row, gap: 10, fontSize: 12, marginBottom: 4 } },
        h('span', { style: { color: T.dim, minWidth: 96 } }, k),
        h('span', { style: { color: tone || T.text, wordBreak: 'break-all' } }, v === null || v === undefined ? '—' : String(v)),
      )
    }

    // ---------------- 实时画面 ----------------
    // 不靠 <img> 吃 MJPEG：Chromium 对 multipart/x-mixed-replace 的 img 支持不可靠
    // （它专门有一笔移除该支持的改动），拿到的就是一片黑。
    // 这里自己 fetch 流、按 Content-Length 切 JPEG、用 createImageBitmap 画到 canvas。
    const ENC = new TextEncoder()
    const FRAME_MARK = ENC.encode('--frame')
    const HEAD_END = ENC.encode('\r\n\r\n')

    function findBytes(buf, pattern, from) {
      const stop = buf.length - pattern.length
      outer:
      for (let i = from; i <= stop; i += 1) {
        for (let j = 0; j < pattern.length; j += 1) {
          if (buf[i + j] !== pattern[j]) continue outer
        }
        return i
      }
      return -1
    }

    function LiveCanvas({ src, onError }) {
      const canvasRef = React.useRef(null)
      const [fps, setFps] = React.useState(0)
      const [state, setState] = React.useState('连接中…')

      React.useEffect(() => {
        let cancelled = false
        const ac = new AbortController()
        const decoder = new TextDecoder()
        let frames = 0
        let t0 = Date.now()

        ;(async () => {
          try {
            const res = await fetch(src, { signal: ac.signal, cache: 'no-store' })
            if (!res.ok) throw new Error('HTTP ' + res.status)
            if (!res.body || typeof res.body.getReader !== 'function') throw new Error('这个环境不支持读流')
            setState('收画面…')
            const reader = res.body.getReader()
            let buf = new Uint8Array(0)
            while (!cancelled) {
              const step = await reader.read()
              if (step.done) break
              if (step.value && step.value.length) {
                const merged = new Uint8Array(buf.length + step.value.length)
                merged.set(buf)
                merged.set(step.value, buf.length)
                buf = merged
              }

              // 一轮里可能已经攒了好几帧：只留最后一张画，其余丢掉，免得越拖越慢
              let consume = 0
              let latest = null
              for (;;) {
                const headStart = findBytes(buf, FRAME_MARK, consume)
                if (headStart < 0) break
                const headEnd = findBytes(buf, HEAD_END, headStart)
                if (headEnd < 0) break
                const head = decoder.decode(buf.subarray(headStart, headEnd))
                const hit = /content-length:\s*(\d+)/i.exec(head)
                if (!hit) { consume = headEnd + 4; continue }
                const length = Number(hit[1])
                const dataStart = headEnd + 4
                if (buf.length < dataStart + length) break
                latest = buf.subarray(dataStart, dataStart + length)
                consume = dataStart + length
              }
              if (consume > 0) buf = buf.slice(consume)

              if (latest && latest.length) {
                const bitmap = await createImageBitmap(new Blob([latest], { type: 'image/jpeg' }))
                if (cancelled) { bitmap.close(); return }
                const canvas = canvasRef.current
                if (canvas) {
                  if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
                    canvas.width = bitmap.width
                    canvas.height = bitmap.height
                  }
                  const ctx = canvas.getContext('2d')
                  if (ctx) ctx.drawImage(bitmap, 0, 0)
                }
                bitmap.close()
                frames += 1
                const elapsed = Date.now() - t0
                if (elapsed >= 1000) {
                  setFps(Math.round((frames * 1000) / elapsed))
                  frames = 0
                  t0 = Date.now()
                }
              }
            }
            if (!cancelled) setState('流结束了')
          } catch (error) {
            if (cancelled || error.name === 'AbortError') return
            setState('连不上')
            if (onError) onError(error.message)
          }
        })()

        return () => { cancelled = true; ac.abort() }
      }, [src])

      return h('div', { style: { width: '100%' } },
        h('canvas', {
          ref: canvasRef,
          style: { maxWidth: '100%', height: 'auto', display: 'block', margin: '0 auto', borderRadius: 8 },
        }),
        h('div', { style: { color: T.dim, fontSize: 11, marginTop: 4 } },
          state + (fps ? '  ·  ' + fps + ' fps' : '')),
      )
    }

    // ---------------- 眼 ----------------
    function Eyes() {
      const [cfg, setCfg] = React.useState(null)
      const [cams, setCams] = React.useState([])
      const [range, setRange] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState('')
      const [preview, setPreview] = React.useState(0)
      const [live, setLive] = React.useState(true)
      const [nonce, setNonce] = React.useState(Date.now())
      const [draft, setDraft] = React.useState({})
      const [saving, setSaving] = React.useState(false)
      const [desk, setDesk] = React.useState(null)
      const [deskMsg, setDeskMsg] = React.useState('')
      const [deskBusy, setDeskBusy] = React.useState(false)
      const timer = React.useRef(null)

      const controls = range && range.controls ? range.controls : {}
      const deviceName = range && range.name ? range.name : ''

      async function loadRange(device, name) {
        try {
          const q = '/range?device=' + device + (name ? '&name=' + encodeURIComponent(name) : '')
          const r = await api(q)
          setRange(r)
          setDraft({})
          if (r && r.winrtError) setMsg('参数范围只拿到一部分：' + r.winrtError)
          return r
        } catch (e) {
          setMsg('读参数范围失败：' + e.message)
          return null
        }
      }

      React.useEffect(() => {
        let alive = true
        ;(async () => {
          let device = 0
          let name = ''
          try {
            const s = await api('/status')
            if (!alive) return
            setCfg(s.config)
            device = s.config.device
          } catch (e) { if (alive) setMsg('读配置失败：' + e.message) }
          // 先让预览流把摄像头拿起来，再问设备列表和参数范围。
          // 反过来的话，OpenCV 会抢在流前面占住设备，流就一帧都读不到。
          await new Promise((r) => setTimeout(r, 1200))
          if (!alive) return
          try {
            const d = await api('/devices')
            if (!alive) return
            setCams(d.cameras || [])
            const hit = (d.cameras || []).find((c) => c.index === device)
            if (hit) name = hit.name
          } catch (e) { if (alive) setMsg('列摄像头失败：' + e.message) }
          if (alive) await loadRange(device, name)
          if (alive) void pullDesk()
        })()
        return () => {
          alive = false
          if (timer.current) clearTimeout(timer.current)
        }
      }, [])

      async function save(patch) {
        const next = { ...cfg, ...patch }
        setCfg(next)
        try {
          const r = await api('/config', patch)
          setCfg(r.config)
        } catch (e) { setMsg('保存失败：' + e.message) }
      }

      /** 拖滑块：界面先动（不卡手），500ms 后把最后一次值写进设备。 */
      function nudge(key, value) {
        setDraft((d) => ({ ...d, [key]: value }))
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(async () => {
          setSaving(true)
          try {
            const r = await api('/set', {
              device: cfg.device,
              name: deviceName,
              params: { [key]: value },
            })
            const failed = r && r.failed ? r.failed[key] : null
            if (failed) setMsg('「' + key + '」没写进去：' + failed)
            else setMsg('')
            const applied = r && r.applied ? r.applied[key] : null
            if (applied !== null && applied !== undefined) {
              setRange((old) => {
                if (!old || !old.controls || !old.controls[key]) return old
                const nextControls = { ...old.controls, [key]: { ...old.controls[key], value: applied } }
                return { ...old, controls: nextControls }
              })
              setDraft((d) => {
                const next = { ...d }
                delete next[key]
                return next
              })
            }
            setPreview(Date.now())
          } catch (e) { setMsg('写参数失败：' + e.message) } finally { setSaving(false) }
        }, 500)
      }

      async function shoot() {
        setBusy(true); setMsg('')
        const wasLive = live
        // 流占着设备时另开一个实例只能抓到黑帧，先让开再拍
        if (wasLive) setLive(false)
        if (wasLive) await new Promise((r) => setTimeout(r, 750))
        try {
          const r = await api('/snap', {})
          const ap = r.applied || {}
          setMsg('拍到 ' + r.path + '（' + r.width + 'x' + r.height + '，' + Math.round((r.bytes || 0) / 1024) + ' KB）'
            + (Object.keys(ap).length ? '  生效参数：' + JSON.stringify(ap) : ''))
          setPreview(Date.now())
        } catch (e) { setMsg('没拍到：' + e.message) } finally {
          setBusy(false)
          if (wasLive) { setNonce(Date.now()); setLive(true) }
        }
      }

      // 桌面感知：情绪引擎到点时来问「键鼠还在动吗、前台是什么」。这是只读的，不判断。
      async function pullDesk() {
        setDeskBusy(true); setDeskMsg('')
        try {
          const r = await api('/desktop')
          setDesk(r)
        } catch (e) { setDeskMsg('读不到：' + e.message) } finally { setDeskBusy(false) }
      }

      function 空闲说(min) {
        const m = Number(min) || 0
        if (m < 1) return Math.round(m * 60) + ' 秒'
        if (m < 60) return Math.round(m) + ' 分钟'
        return (m / 60).toFixed(1) + ' 小时'
      }

      if (!cfg) return h('div', { style: { color: T.dim, fontSize: 13 } }, '正在读设置…')

      const cur = cfg.width + 'x' + cfg.height

      return h('div', null,
        h('div', { style: card },
          h('div', { style: { ...row, justifyContent: 'space-between', marginBottom: 6 } },
            h('span', { style: { ...label, marginBottom: 0 } }, '摄像头'),
            deviceName ? h('span', { style: { color: T.dim, fontSize: 11 } }, deviceName) : null,
          ),
          h('div', { style: row },
            h('select', {
              style: { ...inputS, minWidth: 260 },
              value: String(cfg.device),
              onChange: async (e) => {
                const device = Number(e.target.value)
                await save({ device })
                const hit = cams.find((c) => c.index === device)
                await loadRange(device, hit ? hit.name : '')
                setPreview(Date.now())
              },
            }, (cams.length ? cams : [{ index: cfg.device, name: '摄像头 ' + cfg.device, width: '?', height: '?' }]).map((c) =>
              h('option', { key: c.index, value: String(c.index) },
                '[' + c.index + '] ' + c.name + (c.width && c.width !== '?' ? '  ' + c.width + 'x' + c.height : ''))
            )),
            h('button', {
              style: btn(false),
              onClick: async () => {
                setBusy(true)
                try {
                  const d = await api('/devices')
                  setCams(d.cameras || [])
                  const hit = (d.cameras || []).find((c) => c.index === cfg.device)
                  await loadRange(cfg.device, hit ? hit.name : '')
                } catch (e) { setMsg(e.message) } finally { setBusy(false) }
              },
            }, busy ? '…' : '重新扫描'),
            h(Switch, {
              on: !!cfg.mirror,
              text: '左右镜像',
              onChange: (on) => { save({ mirror: on }); setPreview(Date.now()) },
            }),
          ),
        ),

        h('div', { style: card },
          h('span', { style: label }, '分辨率'),
          h('div', { style: row }, RESOLUTIONS.map((r) => {
            const [w, hh] = r.split('x').map(Number)
            return h('button', {
              key: r,
              style: btn(cur === r),
              onClick: () => { save({ width: w, height: hh }); setPreview(Date.now()) },
            }, r)
          })),
        ),

        h('div', { style: card },
          h('div', { style: { ...row, justifyContent: 'space-between', marginBottom: 8 } },
            h('span', { style: { ...label, marginBottom: 0 } }, '画面参数'),
            h('span', { style: { color: T.dim, fontSize: 11 } },
              range ? (range.source === 'winrt' ? '值域来自设备' : '值域是估的') : '…'),
          ),

          // 自动模式开关（只对支持 auto 的设备显示）
          (controls.exposure && controls.exposure.autoSupported) || (controls.wb_temperature && controls.wb_temperature.autoSupported)
            ? h('div', { style: { ...row, marginBottom: 8 } },
              controls.exposure && controls.exposure.autoSupported
                ? h(Switch, {
                  on: controls.exposure.auto === true,
                  text: '自动曝光',
                  onChange: async (on) => {
                    try {
                      await api('/set', { device: cfg.device, name: deviceName, autoExposure: on })
                      await loadRange(cfg.device, deviceName)
                      setPreview(Date.now())
                    } catch (e) { setMsg('自动曝光切换失败：' + e.message) }
                  },
                })
                : null,
              controls.wb_temperature && controls.wb_temperature.autoSupported
                ? h(Switch, {
                  on: controls.wb_temperature.auto === true,
                  text: '自动白平衡',
                  onChange: async (on) => {
                    try {
                      await api('/set', { device: cfg.device, name: deviceName, autoWb: on })
                      await loadRange(cfg.device, deviceName)
                      setPreview(Date.now())
                    } catch (e) { setMsg('自动白平衡切换失败：' + e.message) }
                  },
                })
                : null,
            )
            : null,

          KNOBS.map(([key, cn]) => {
            const c = controls[key]
            if (c && c.supported === false) {
              return h('div', { key, style: { ...row, marginBottom: 6, opacity: 0.4 } },
                h('span', { style: { color: T.dim, fontSize: 12, width: 56 } }, cn),
                h('span', { style: { color: T.dim, fontSize: 11 } }, '这个摄像头不支持'),
              )
            }
            const min = c && Number.isFinite(c.min) ? c.min : 0
            const max = c && Number.isFinite(c.max) ? c.max : 100
            const step = c && Number.isFinite(c.step) && c.step > 0 ? c.step : 1
            const deviceValue = c && Number.isFinite(c.value) ? c.value : null
            const shown = draft[key] !== undefined ? draft[key] : (deviceValue === null ? Math.round((min + max) / 2) : deviceValue)
            return h('div', { key, style: { ...row, marginBottom: 6 } },
              h('span', { style: { color: T.dim, fontSize: 12, width: 56 } }, cn),
              h('input', {
                type: 'range', min, max, step,
                value: shown,
                onChange: (e) => nudge(key, Number(e.target.value)),
                style: { flex: '1 1 160px', accentColor: T.accent },
              }),
              h('span', { style: { color: T.text, fontSize: 12, width: 46, textAlign: 'right' } },
                deviceValue === null && draft[key] === undefined ? '默认' : shown),
              h('span', { style: { color: T.dim, fontSize: 10, width: 74 } },
                Number.isFinite(min) && Number.isFinite(max) ? min + '~' + max : ''),
            )
          }),
          msg ? h('div', { style: { color: T.dim, fontSize: 11, marginTop: 6, wordBreak: 'break-all' } }, msg) : null,
          saving ? h('div', { style: { color: T.dim, fontSize: 11, marginTop: 4 } }, '正在写进设备…') : null,
        ),

        h('div', { style: card },
          h('div', { style: { ...row, justifyContent: 'space-between', marginBottom: 8 } },
            h('div', { style: row },
              h('button', { style: btn(false), onClick: shoot, disabled: busy }, busy ? '拍着…' : '拍一张存盘'),
              h('button', { style: smallBtn, onClick: () => { setNonce(Date.now()) }, disabled: busy }, '重连画面'),
            ),
            h(Switch, {
              on: live,
              text: '实时画面',
              hint: '一直开着会占着摄像头（约 15 帧/秒）；调试参数时开着最直观',
              onChange: (on) => { setLive(on); if (on) setNonce(Date.now()) },
            }),
          ),
          msg ? h('div', { style: { color: T.dim, fontSize: 12, marginTop: 8, wordBreak: 'break-all' } }, msg) : null,
          h('div', {
            style: {
              marginTop: 10,
              textAlign: 'center',
              background: '#0a1420',
              border: '1px solid ' + T.line,
              borderRadius: 8,
              minHeight: 150,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'hidden',
            },
          },
            live
              ? h(LiveCanvas, {
                key: 'live-' + nonce,
                src: BASE + '/stream?device=' + cfg.device + '&width=' + cfg.width + '&height=' + cfg.height
                  + (cfg.mirror ? '&mirror=1' : '') + '&fps=15&quality=72&t=' + nonce,
                onError: (m) => setMsg('实时画面连不上：' + m + '（摄像头可能被别的程序占着）'),
              })
              : preview
                ? h('img', {
                  src: BASE + '/frame?device=' + cfg.device + '&width=' + cfg.width + '&height=' + cfg.height
                    + (cfg.mirror ? '&mirror=1' : '') + '&t=' + preview,
                  alt: '摄像头预览',
                  style: { maxWidth: '100%', display: 'block', borderRadius: 8 },
                })
                : h('div', { style: { color: T.dim, fontSize: 12, padding: 24 } }, '实时画面关着——打开开关，或者点「拍一张存盘」'),
          ),
        ),

        // 桌面感知（P2）：只读展示。情绪引擎到点会来问它，这里不判断
        h('div', { style: card },
          h('div', { style: { ...row, justifyContent: 'space-between', marginBottom: 6 } },
            h('span', { style: { ...label, marginBottom: 0 } }, '桌面感知'),
            h('button', { style: smallBtn, onClick: pullDesk, disabled: deskBusy }, deskBusy ? '读取中…' : '读一下'),
          ),
          h('div', { style: { color: T.dim, fontSize: 12, lineHeight: 1.7 } },
            '情绪引擎到点时会来问这里：键鼠还在动吗、前台是什么。这边只给数据，判断在情绪那边。'),
          desk
            ? h('div', { style: { marginTop: 8, fontSize: 12.5, lineHeight: 1.9 } },
                h('div', null, '键鼠空闲 ', h('b', { style: { color: T.text } }, 空闲说(desk.idleMin)),
                  h('span', { style: { color: T.dim } }, '（' + Math.round((desk.idleMs || 0) / 1000) + ' 秒没动）')),
                h('div', null, '前台 ', h('b', { style: { color: T.text } }, (desk.foreground && desk.foreground.proc) || '—'),
                  desk.foreground && desk.foreground.title
                    ? h('span', { style: { color: T.dim } }, '「' + desk.foreground.title + '」')
                    : null),
              )
            : h('div', { style: { color: T.dim, fontSize: 12, marginTop: 8 } }, deskMsg || '点「读一下」看看现在有没有人在。'),
        ),
      )
    }

    // ---------------- 耳 ----------------
    // 耳：语音输入的设置全在下面这个面板里（2026-11-11 从 dsh-voice-panel 并进来）。
    // 原来「设置 → 语音输入」是单独一节，现在只剩「鲸的感官 → 耳」这一个入口。
    function Ears() {
      const VoicePanel = VoiceInput && VoiceInput.Panel
      if (!VoicePanel) return h('div', { style: { color: T.dim, fontSize: 13 } }, '语音输入模块没加载起来')
      return h(VoicePanel)
    }

    // ---------------- 手 ----------------
    function Hands() {
      const [cfg, setCfg] = React.useState(null)
      const [wins, setWins] = React.useState(null)
      const [msg, setMsg] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [appName, setAppName] = React.useState('')
      const [appMsg, setAppMsg] = React.useState('')
      const [shotRoot, setShotRoot] = React.useState('')

      function openOne() {
        const name = appName.trim()
        if (!name) return
        setBusy(true)
        setAppMsg('')
        api('/apps/open', { name })
          .then((r) => setAppMsg('打开了 ' + (r.name || name)))
          .catch((e) => setAppMsg('没打开：' + e.message))
          .finally(() => setBusy(false))
      }

      React.useEffect(() => {
        api('/hands/config')
          .then((r) => { setCfg(r.config); setShotRoot((r.config && r.config.shotRoot) || '') })
          .catch((e) => setMsg('读手设置失败：' + e.message))
      }, [])

      function save(patch) {
        setBusy(true)
        api('/hands/config', patch)
          .then((r) => { setCfg(r.config); setShotRoot((r.config && r.config.shotRoot) || ''); setMsg('已保存，立即生效') })
          .catch((e) => setMsg('保存失败：' + e.message))
          .finally(() => setBusy(false))
      }

      function scan() {
        setBusy(true)
        setMsg('')
        api('/hands/windows')
          .then((r) => setWins(Array.isArray(r.list) ? r.list : []))
          .catch((e) => setMsg('列窗口失败：' + e.message))
          .finally(() => setBusy(false))
      }

      if (!cfg) return h('div', { style: { color: T.dim, fontSize: 13 } }, msg || '正在读手设置…')

      const items = [
        ['snap', '截屏', '抓一张屏幕（能看见画面就靠它）'],
        ['window', '列窗口', '列出当前有标题的窗口和位置'],
        ['uia', '读控件', '读窗口里的按钮名和坐标'],
        ['mouse', '鼠标', '移动、单击、双击'],
        ['keyboard', '键盘', '打字（中文走剪贴板）和按键'],
        ['focus', '切窗口', '按标题把窗口提到最前'],
        ['launch', '打开程序', '按名字启动本机应用（微信、b站、steam…）'],
      ]

      return h('div', null,
        h('div', { style: card },
          h('div', { style: { ...row, justifyContent: 'space-between', marginBottom: 8 } },
            h('div', { style: { color: T.text, fontSize: 13 } }, '手（桌面操作）'),
            h('span', { style: { color: cfg.enabled ? T.ok : T.warn, fontSize: 11 } },
              cfg.enabled ? '总开关：开' : '总开关：关'),
          ),
          h(Switch, { on: cfg.enabled !== false, text: '允许我用手', onChange: (on) => save({ enabled: on }) }),
          h('div', { style: { color: T.dim, fontSize: 11, marginTop: 6, lineHeight: 1.7 } },
            '关掉哪一项，我就做不了哪一项——不是把按钮藏起来，是调用直接拒绝。'),
        ),
        h('div', { style: card },
          h('span', { style: label }, '各项能力'),
          items.map(([key, name, desc]) => h('div', {
            key,
            style: { ...row, justifyContent: 'space-between', padding: '5px 0' },
          },
            h('div', { style: { minWidth: 0 } },
              h('div', { style: { fontSize: 12.5 } }, name),
              h('div', { style: { color: T.dim, fontSize: 11 } }, desc),
            ),
            h(Switch, { on: cfg[key] !== false, onChange: (on) => save({ [key]: on }) }),
          )),
        ),
        h('div', { style: card },
          h('span', { style: label }, '产物目录'),
          h('div', { style: row },
            h('input', {
              style: { ...inputS, width: 300 },
              value: shotRoot,
              placeholder: '留空 = 自动（~/.dsh/hands-shots）',
              onChange: (e) => setShotRoot(e.target.value),
            }),
            h('button', { style: smallBtn, disabled: busy, onClick: () => save({ shotRoot }) }, '保存'),
          ),
          h('div', { style: { color: T.dim, fontSize: 11, marginTop: 6, lineHeight: 1.6 } },
            '截图和临时文件放这儿。留空 = 落到 ~/.dsh/hands-shots。'),
        ),
        h('div', { style: card },
          h('span', { style: label }, '打开程序'),
          h('div', { style: row },
            h('input', {
              style: { ...inputS, width: 220 },
              value: appName,
              placeholder: '微信 / b站 / steam…',
              onChange: (e) => setAppName(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') openOne() },
            }),
            h('button', { style: smallBtn, disabled: busy, onClick: openOne }, busy ? '…' : '打开'),
          ),
          appMsg ? h('div', { style: { color: T.dim, fontSize: 11, marginTop: 6 } }, appMsg) : null,
          h('div', { style: { color: T.dim, fontSize: 11, marginTop: 6, lineHeight: 1.6 } },
            '提示：有些程序要十几秒才出窗口，打不开时先看名字对不对。'),
        ),
        h('div', { style: card },
          h('div', { style: { ...row, justifyContent: 'space-between' } },
            h('span', { style: { ...label, marginBottom: 0 } }, '现在桌面上有哪些窗口'),
            h('button', { style: smallBtn, disabled: busy, onClick: scan }, busy ? '…' : '看一下'),
          ),
          wins === null
            ? h('div', { style: { color: T.dim, fontSize: 11, marginTop: 6 } }, '点「看一下」列出来')
            : (wins.length
              ? h('div', { style: { marginTop: 8 } }, wins.slice(0, 20).map((w, i) => h('div', {
                key: i,
                style: { fontSize: 11.5, padding: '3px 0', borderBottom: '1px solid ' + T.line, color: T.text },
              }, w.name + ' · ' + w.title + h('span', { style: { color: T.dim } }, '  ' + w.w + '×' + w.h))))
              : h('div', { style: { color: T.dim, fontSize: 11, marginTop: 6 } }, '没读到窗口')),
          msg ? h('div', { style: { color: T.dim, fontSize: 11, marginTop: 6 } }, msg) : null,
        ),
      )
    }


    // ---------------- 朗读播放引擎（原 dsh-voice-out 的 client 半边） ----------------
    let currentAudio = null
    let playing = false
    // 用户手动点了「停止」：在这一条真正停下来之外，还要挡住 1.6 秒一次的自动取件，
    // 否则停了 1.6 秒后 tick 又从队列里抓一条接着念，听感就是「停不下来」。
    let pausedByUser = false
    // 每播一段算一轮；stopAudio 把 runSeq 加一，正在跑的流水线下一轮就自己退出
    let runSeq = 0
    // 药丸里的「念上一条」处理函数；语音唤醒那边通过桥调用，等价于点按钮
    let pillReadLast = null
    // 药丸当前所在的会话 id（slot 的 standardProps 会传进来）。空字符串表示还不知道。
    let pillSession = ''

    /** 带上会话 id：后端只认这个会话的回复，不会念到别的窗口去。 */
    function withSession(path, sid) {
      return sid ? path + (path.indexOf('?') >= 0 ? '&' : '?') + 'session=' + encodeURIComponent(sid) : path
    }

    /**
     * 切句：以句号 / 问号 / 叹号 / 分号为准，一句一次 —— 不把几句话拼成一大段。
     * 单句超过 maxChars 才按逗号继续切（40 是 IndexTTS2 在低显存下的分段粒度）。
     * 只剩「好。」这种极短句时并到下一句，免得每个语气词都占一次生成。
     */
    function splitSentences(text, maxChars = 40) {
      const s = String(text || '').trim()
      if (!s) return []
      // 第一刀：句末标点（按句号或一小段切分，别贪心拼到 40 字）
      const rough = s.split(/(?<=[。！？!?…；;\n])/).map((p) => p.trim()).filter(Boolean)
      const merged = []
      for (const seg of rough) {
        const prev = merged[merged.length - 1]
        if (prev !== undefined && prev.length < 6) merged[merged.length - 1] = prev + seg
        else merged.push(seg)
      }
      // 第二刀：单句太长才按逗号切
      const out = []
      for (const seg of merged) {
        if (seg.length <= maxChars) { out.push(seg); continue }
        const parts = seg.split(/(?<=[，,、：:])/).filter(Boolean)
        let cur = ''
        for (const p of parts) {
          if (cur.length + p.length <= maxChars) cur += p
          else { if (cur) out.push(cur); cur = p }
        }
        if (cur) out.push(cur)
      }
      // 兜底：一个标点都没有的超长串，硬切
      const final = []
      for (const seg of out) {
        if (seg.length <= maxChars) { final.push(seg); continue }
        for (let i = 0; i < seg.length; i += maxChars) final.push(seg.slice(i, i + maxChars))
      }
      // 首句太长再切一刀，缩短「从点击到出声」这段时间
      if (final.length && final[0].length > 24) {
        const head = final[0]
        const cut = head.search(/[，,、：:]/)
        if (cut > 6 && cut < head.length - 1 && cut + 1 <= 24) {
          final.splice(0, 1, head.slice(0, cut + 1), head.slice(cut + 1))
        }
      }
      return final.map((x) => x.trim()).filter(Boolean)
    }

    /** 只生成，不播：返回一个 blob URL。 */
    async function fetchClip(text) {
      const res = await fetch(VOICE_OUT + '/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}))
        throw new Error(detail.error || ('生成失败 HTTP ' + res.status))
      }
      const blob = await res.blob()
      return URL.createObjectURL(blob)
    }

    /** 播一个 blob URL，播完 resolve。 */
    function playClip(url) {
      return new Promise((resolve, reject) => {
        const audio = new Audio(url)
        currentAudio = audio
        audio.onended = () => {
          URL.revokeObjectURL(url)
          if (currentAudio === audio) currentAudio = null
          resolve()
        }
        audio.onerror = () => {
          URL.revokeObjectURL(url)
          if (currentAudio === audio) currentAudio = null
          reject(new Error('播放失败'))
        }
        audio.play().catch(reject)
      })
    }

    /**
     * 一句一次：边播边生成下一句。
     * 以前是「整段生成完才出声」，长一点的回复要干等十几秒；
     * 现在第一句一出来就播，后面的生成被播放时间盖住。
     * 段与段之间留 120ms 自然停顿 —— 后端已经把头尾静音裁掉了，
     * 不补这一下会粘得太紧，补多了又变成「一句一顿」。
     */
    async function speak(text, onState) {
      const sentences = splitSentences(text)
      if (!sentences.length || playing) return
      const myRun = (runSeq += 1)
      playing = true
      if (onState) onState(true)
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      let lastEnd = 0
      try {
        let pending = fetchClip(sentences[0])
        for (let i = 0; i < sentences.length; i += 1) {
          if (myRun !== runSeq) return
          const url = await pending
          if (myRun !== runSeq) { URL.revokeObjectURL(url); return }
          // 这一句开始播的同时，把下一句生成好
          if (i + 1 < sentences.length) {
            pending = fetchClip(sentences[i + 1])
            pending.catch(() => {})
          }
          // 生成很快时补一个自然停顿；生成本来就慢就不用再等了
          if (lastEnd) {
            const since = Date.now() - lastEnd
            if (since < 120) await sleep(120 - since)
          }
          await playClip(url)
          lastEnd = Date.now()
        }
      } catch (error) {
        if (myRun === runSeq) throw error
      } finally {
        // 被打断（myRun !== runSeq）时别动播放态：新一轮已经接管了
        if (myRun === runSeq) {
          currentAudio = null
          playing = false
          if (onState) onState(false)
        }
      }
    }

    function stopAudio(byUser) {
      runSeq += 1
      if (byUser) {
        pausedByUser = true
        // 队列里还堆着没念的，一起清掉；不清的话 tick 下一轮又抓走一条
        fetch(VOICE_OUT + '/clear', { method: 'POST' }).catch(() => {})
      }
      const audio = currentAudio
      currentAudio = null
      if (audio) {
        try { audio.pause() } catch (error) {}
        // pause() 不触发 ended，手动结算 speak() 里那个 Promise，否则 busy 状态会卡住
        try { if (typeof audio.onended === 'function') audio.onended() } catch (error) {}
      }
      playing = false
    }

    /**
     * 给别的客户端插件（dsh-voice-panel 的语音唤醒）留一个桥：
     * 说「停止/继续」能控制朗读，唤醒时也能先把朗读打断。
     * ⚠️ 桥名必须是 __dshVoiceOut：dsh-voice-panel 是按这个名字找的，改名等于把「耳」弄哑。
     */
    window.__dshVoiceOut = {
      isSpeaking: () => playing,
      stop: () => stopAudio(),
      /** 等价于点药丸上的「念上一条」：优先点真实按钮，按钮不在时退回内部处理函数。 */
      prev: async () => {
        const button = document.querySelector('[data-voice-out-action="prev"]')
        if (button) {
          button.click()
          return true
        }
        if (pillReadLast) {
          await pillReadLast()
          return true
        }
        return false
      },
      speakLast: async () => {
        const out = await apiVoice(VOICE_OUT, withSession('/recent', pillSession))
        if (!out.recent || !out.recent.length) return false
        stopAudio()
        await speak(out.recent[0].text)
        return true
      },
      next: async () => {
        const out = await apiVoice(VOICE_OUT, withSession('/next', pillSession))
        if (!out.item) return false
        stopAudio()
        speak(out.item.text)
          .then(() => apiVoice(VOICE_OUT, '/ack', { id: out.item.id }))
          .catch(() => {})
        return true
      },
    }

    // ---- 小药丸位置：可拖动、会记住 ----
    // 键名沿用旧插件的：搬过来那一刻的老位置还能读到，不会跳回右下角
    const POS_KEY = 'dsh-voice-out.pill-pos'
    const PILL_RIGHT = 24
    const PILL_BOTTOM = 96
    const DRAG_THRESHOLD = 4

    /** fixed 的真正基准：祖先里第一个建了包含块的元素（composerSeat 带 will-change:transform，
     *  fixed 会退化成相对它定位，用视口坐标会算错、还会把滚动区域撑长把输入框顶飞） */
    function pillContainingBlock(el) {
      let n = el ? el.parentElement : null
      while (n) {
        const cs = window.getComputedStyle(n)
        if (cs.transform !== 'none' || cs.willChange === 'transform' || cs.filter !== 'none' || cs.perspective !== 'none') return n
        n = n.parentElement
      }
      return null
    }

    function clampPos(x, y, w, h, el) {
      const cb = pillContainingBlock(el)
      const box = cb ? cb.getBoundingClientRect() : { left: 0, top: 0, width: window.innerWidth || 1280, height: window.innerHeight || 800 }
      const maxX = Math.max(4, box.width - w - 4)
      const maxY = Math.max(4, box.height - h - 4)
      return {
        x: Math.round(Math.min(Math.max(4, x), maxX)),
        y: Math.round(Math.min(Math.max(4, y), maxY)),
      }
    }

    function readLocalPos() {
      try {
        const raw = window.localStorage.getItem(POS_KEY)
        if (!raw) return null
        const p = JSON.parse(raw)
        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null
        return { x: p.x, y: p.y }
      } catch (error) { return null }
    }

    function writeLocalPos(pos) {
      try {
        if (pos) window.localStorage.setItem(POS_KEY, JSON.stringify(pos))
        else window.localStorage.removeItem(POS_KEY)
      } catch (error) {}
    }

    /** 对话页那颗小药丸：自动模式显示状态，按需模式点一下念最近一条，按住能拖。 */
    function VoicePill(props) {
      // 这个 slot 是 session 作用域，壳子会把当前会话 id 作为 standard prop 传进来
      // sessionId 由 composer 那一层的桥送进来（药丸本体已经挪到整页浮层）
      const sessionId = props && props.sessionId ? String(props.sessionId) : pillSession
      if (sessionId && sessionId !== pillSession) pillSession = sessionId
      const [mode, setMode] = React.useState('manual')
      const [enabled, setEnabled] = React.useState(true)
      const [busy, setBusy] = React.useState(false)
      const [hint, setHint] = React.useState('')
      const lastId = React.useRef(null)
      const [pos, setPos] = React.useState(readLocalPos)
      const [dragging, setDragging] = React.useState(false)
      const boxRef = React.useRef(null)
      const dragRef = React.useRef({ active: false, moved: false, startX: 0, startY: 0, left: 0, top: 0, w: 0, h: 0 })
      const syncedRef = React.useRef(false)

      // 老版本存的是视口坐标，而 fixed 实际相对 composerSeat 定位（它有 will-change:transform）——
      // 启动时先把旧坐标夹回包含块里，否则会把滚动区撑长、把输入框顶到半空
      React.useEffect(() => {
        const el = boxRef.current
        if (!el) return
        setPos((prev) => {
          if (!prev) return prev
          const next = clampPos(prev.x, prev.y, el.offsetWidth, el.offsetHeight, el)
          if (next.x === prev.x && next.y === prev.y) return prev
          writeLocalPos(next)
          return next
        })
      }, [])

      const savePos = React.useCallback(async (next) => {
        writeLocalPos(next)
        try { await apiVoice(VOICE_OUT, '/config', { pillPos: next }) } catch (error) {}
      }, [])

      const onPointerDown = React.useCallback((e) => {
        if (e.button) return
        const el = boxRef.current
        if (!el) return
        const rect = el.getBoundingClientRect()
        const cb = pillContainingBlock(el)
        const cbRect = cb ? cb.getBoundingClientRect() : { left: 0, top: 0 }
        dragRef.current = {
          active: true, moved: false, startX: e.clientX, startY: e.clientY,
          left: rect.left - cbRect.left, top: rect.top - cbRect.top, w: rect.width, h: rect.height,
        }
        try { el.setPointerCapture(e.pointerId) } catch (error) {}
      }, [])

      const onPointerMove = React.useCallback((e) => {
        const d = dragRef.current
        if (!d.active) return
        const dx = e.clientX - d.startX
        const dy = e.clientY - d.startY
        if (!d.moved) {
          if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return
          d.moved = true
          setDragging(true)
        }
        setPos(clampPos(d.left + dx, d.top + dy, d.w, d.h, boxRef.current))
      }, [])

      const onPointerUp = React.useCallback((e) => {
        const d = dragRef.current
        if (!d.active) return
        d.active = false
        setDragging(false)
        const el = boxRef.current
        if (el) { try { el.releasePointerCapture(e.pointerId) } catch (error) {} }
        if (!d.moved) return
        const next = clampPos(d.left + (e.clientX - d.startX), d.top + (e.clientY - d.startY), d.w, d.h, el)
        setPos(next)
        savePos(next)
      }, [savePos])

      // 拖动结束时吞掉这一次 click，避免「拖一下顺手念一遍」
      const onClickCapture = React.useCallback((e) => {
        if (!dragRef.current.moved) return
        dragRef.current.moved = false
        e.stopPropagation()
        e.preventDefault()
      }, [])

      React.useEffect(() => {
        const reset = () => { writeLocalPos(null); setPos(null) }
        window.addEventListener('dsh-voice-out:pill-reset', reset)
        return () => window.removeEventListener('dsh-voice-out:pill-reset', reset)
      }, [])

      const hasPos = pos !== null
      React.useEffect(() => {
        if (!hasPos) return
        const onResize = () => {
          const el = boxRef.current
          if (!el) return
          const rect = el.getBoundingClientRect()
          setPos((prev) => (prev ? clampPos(prev.x, prev.y, rect.width, rect.height, el) : prev))
        }
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [hasPos])

      React.useEffect(() => {
        let alive = true
        const tick = async () => {
          try {
            if (pausedByUser) return
            const out = await apiVoice(VOICE_OUT, withSession('/next', sessionId))
            if (!alive) return
            setMode(out.mode)
            if (out.item && out.item.id !== lastId.current) {
              lastId.current = out.item.id
              setBusy(true)
              try { await speak(out.item.text, setBusy) } catch (error) { setHint(error.message) }
              setBusy(false)
              apiVoice(VOICE_OUT, '/ack', { id: out.item.id }).catch(() => {})
            }
          } catch (error) { setHint(String(error.message).slice(0, 40)) }
        }
        tick()
        const timer = setInterval(tick, 1600)
        return () => { alive = false; clearInterval(timer) }
      }, [])

      React.useEffect(() => {
        let alive = true
        const load = async () => {
          try {
            const out = await apiVoice(VOICE_OUT, '/status')
            if (!alive) return
            setMode(out.config.mode)
            setEnabled(out.config.enabled !== false)
            if (!syncedRef.current) {
              syncedRef.current = true
              const sp = out.config && out.config.pillPos
              if (sp && Number.isFinite(sp.x) && Number.isFinite(sp.y)) {
                setPos({ x: sp.x, y: sp.y })
                writeLocalPos({ x: sp.x, y: sp.y })
              }
            }
          } catch (error) {}
        }
        load()
        const timer = setInterval(load, 4000)
        return () => { alive = false; clearInterval(timer) }
      }, [])

      const auto = mode === 'auto'

      const readLast = React.useCallback(async () => {
        if (busy) return
        // 再点一次就是「我改主意了，继续」：解除暂停并打断当前这条
        pausedByUser = false
        stopAudio()
        setHint('点了，正在准备…')
        try {
          const out = await apiVoice(VOICE_OUT, withSession('/recent', sessionId))
          if (!out.recent || !out.recent.length) { setHint('还没有可念的回复'); return }
          setBusy(true)
          setHint('生成中…')
          await speak(out.recent[0].text, setBusy)
          setHint('')
        } catch (error) { setHint('失败：' + String(error.message).slice(0, 40)) }
        setBusy(false)
      }, [busy])

      // 把「念上一条」的处理函数挂到模块级，语音唤醒的「念上一条」口令直接调它
      React.useEffect(() => {
        pillReadLast = readLast
        return () => { if (pillReadLast === readLast) pillReadLast = null }
      }, [readLast])

      // 药丸主体：正在念的时候点一下 = 停止（直觉如此），没在念才是「念上一条」。
      // 之前这里只会 readLast，而 readLast 开头有 if (busy) return —— 正在念的时候点它等于什么都没发生。
      const trigger = (e) => {
        if (e && e.stopPropagation) e.stopPropagation()
        // busy 是 React 状态，playing 是模块级真实播放态——两个都看，避免状态不同步时点了没反应
        if (busy || playing) { stopAudio(true); setBusy(false); setHint('已停止'); return }
        if (!auto) readLast()
      }

      if (!enabled) return null

      return h('div', {
        ref: boxRef,
        onClick: trigger,
        onClickCapture,
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onPointerCancel: () => { dragRef.current.active = false; setDragging(false) },
        onMouseDown: (e) => e.stopPropagation(),
        title: (auto ? '自动朗读模式' : '点这里念上一条回复') + '，按住可以拖到别处',
        style: {
          position: 'fixed',
          ...(pos ? { left: pos.x, top: pos.y } : { right: PILL_RIGHT, bottom: PILL_BOTTOM }),
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '6px 12px', borderRadius: 999, background: 'rgba(24,42,60,.88)', color: '#e6f2ff',
          fontSize: 12, boxShadow: '0 4px 16px rgba(0,0,0,.35)', userSelect: 'none',
          zIndex: 9999, pointerEvents: 'auto',
          cursor: dragging ? 'grabbing' : 'grab',
          touchAction: 'none',
          minWidth: 92, minHeight: 28,
        },
      },
        h('span', { style: { opacity: 0.78, pointerEvents: 'none' } }, auto ? '自动朗读' : '按需朗读'),
        auto ? null : h('button', {
          'data-voice-out-action': 'prev',
          style: { border: '1px solid rgba(120,190,255,.55)', borderRadius: 999, padding: '4px 12px', cursor: 'pointer', background: 'rgba(120,190,255,.3)', color: '#e6f2ff', fontSize: 12, pointerEvents: 'auto' },
          onClick: (e) => { e.stopPropagation(); readLast() },
        }, busy ? '念中…' : '念上一条'),
        busy ? h('button', {
          style: { border: '1px solid rgba(255,140,140,.55)', borderRadius: 999, padding: '4px 12px', cursor: 'pointer', background: 'rgba(255,120,120,.32)', color: '#ffe6e6', fontSize: 12, pointerEvents: 'auto' },
          onClick: (e) => { e.stopPropagation(); stopAudio(true); setBusy(false); setHint('已停止') },
        }, '停止') : null,
        hint ? h('span', { style: { opacity: 0.9, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', pointerEvents: 'none' } }, hint) : null,
      )
    }

    // ---------------- 口 ----------------
    const VOICES = []
    for (let i = 1; i <= 12; i += 1) VOICES.push('examples/voice_' + String(i).padStart(2, '0') + '.wav')

    function Mouth() {
      const [cfg, setCfg] = React.useState(null)
      const [status, setStatus] = React.useState(null)
      const [msg, setMsg] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const audio = React.useRef(null)

      async function pull() {
        try {
          const s = await apiVoice(VOICE_OUT, '/status')
          setStatus(s)
          setCfg(s.config)
        } catch (e) { setMsg('读朗读配置失败：' + e.message) }
      }

      React.useEffect(() => {
        pull()
        return () => { if (audio.current) { try { audio.current.pause() } catch (e) {} } }
      }, [])

      async function save(patch) {
        setCfg({ ...cfg, ...patch })
        try {
          const r = await apiVoice(VOICE_OUT, '/config', patch)
          if (r && r.config) setCfg(r.config)
        } catch (e) { setMsg('保存失败：' + e.message) }
      }

      async function tryListen() {
        setBusy(true); setMsg('正在合成试听…')
        try {
          const res = await fetch(VOICE_OUT + '/speak', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: '这是一段试听。' }),
          })
          if (!res.ok) {
            const j = await res.json().catch(() => ({}))
            throw new Error(j.error || ('HTTP ' + res.status))
          }
          const blob = await res.blob()
          if (audio.current) { try { audio.current.pause() } catch (e) {} }
          const url = URL.createObjectURL(blob)
          const el = new Audio(url)
          audio.current = el
          el.onended = () => { URL.revokeObjectURL(url); setMsg('试听结束') }
          await el.play()
          setMsg('正在播放（' + Math.round(blob.size / 1024) + ' KB）')
        } catch (e) { setMsg('试听失败：' + e.message) } finally { setBusy(false) }
      }

      async function readLast() {
        setBusy(true); setMsg('生成中…')
        try {
          const out = await apiVoice(VOICE_OUT, '/recent')
          if (!out.recent || !out.recent.length) { setMsg('还没有可念的回复'); return }
          await speak(out.recent[0].text)
          setMsg('念完了')
        } catch (e) { setMsg('失败：' + e.message) } finally { setBusy(false) }
      }

      async function unloadModel() {
        try {
          const out = await apiVoice(VOICE_OUT, '/unload', {})
          setMsg(out.unloaded ? '模型已卸载（显存放掉了）' : '模型本来就没加载')
          pull()
        } catch (e) { setMsg('卸载失败：' + e.message) }
      }

      async function resetPill() {
        try {
          writeLocalPos(null)
          await apiVoice(VOICE_OUT, '/config', { pillPos: null })
          window.dispatchEvent(new CustomEvent('dsh-voice-out:pill-reset'))
          setMsg('朗读按钮已经回到右下角了')
        } catch (e) { setMsg('复位失败：' + e.message) }
      }

      if (!cfg) return h('div', { style: { color: T.dim, fontSize: 13 } }, '正在读朗读配置…')

      const server = (status && status.server) || {}

      return h('div', null,
        h('div', { style: card },
          h('div', { style: { ...row, justifyContent: 'space-between', marginBottom: 8 } },
            h('div', { style: { color: T.text, fontSize: 13 } }, '朗读（口）'),
            h('span', { style: { color: server.modelLoaded || server.status === 'ready' ? T.ok : T.dim, fontSize: 11 } },
              server.modelLoaded
                ? '模型已加载'
                : (server.status === 'ready'
                  ? '服务就绪 · 模型按需加载'
                  : (server.status === 'running' ? '启动中…' : '未启动'))),
          ),
          h(Line, { k: '状态', v: server.status }),
          h(Line, { k: '本地端口', v: server.port }),
          h(Line, { k: '队列', v: (status && status.queue) || 0 }),
          h(Line, { k: '版本', v: status && status.version }),
          h('div', { style: { ...row, marginTop: 8 } },
            h(Switch, { on: cfg.enabled !== false, text: '启用朗读', onChange: (on) => save({ enabled: on }) }),
            h(Switch, { on: cfg.mode === 'auto', text: '自动朗读', onChange: (on) => save({ mode: on ? 'auto' : 'manual' }) }),
            h('button', { style: btn(false), onClick: tryListen, disabled: busy }, busy ? '合成中…' : '试听'),
          ),
          msg ? h('div', { style: { color: T.dim, fontSize: 11, marginTop: 6 } }, msg) : null,
          server.error ? h('div', { style: { color: T.warn, fontSize: 11, marginTop: 6 } }, String(server.error)) : null,
        ),

        h('div', { style: card },
          h('span', { style: label }, '操作'),
          h('div', { style: row },
            h('button', { style: btn(false), disabled: busy, onClick: readLast }, '念最近一条'),
            h('button', {
              style: btn(false),
              onClick: () => {
                stopAudio(true)
                if (audio.current) { try { audio.current.pause() } catch (e) {} }
                setMsg('已停止')
              },
            }, '停止'),
            h('button', { style: btn(false), onClick: unloadModel }, '立即卸载模型'),
            h('button', { style: btn(false), onClick: resetPill }, '朗读按钮回右下角'),
          ),
          h('div', { style: { color: T.dim, fontSize: 11, marginTop: 8, lineHeight: 1.6 } },
            '对话页那颗小药丸可以按住拖到任意位置，松手自动记住；「念最近一条」念的是最近一条说完的回复。'),
        ),

        h('div', { style: card },
          h('span', { style: label }, '音色'),
          h('select', {
            style: { ...inputS, minWidth: 200 },
            value: cfg.voice || '',
            onChange: (e) => save({ voice: e.target.value }),
          },
            VOICES.map((v, i) => h('option', { key: v, value: v },
              (v.indexOf('voice_') >= 0 ? '音色 ' + String(i + 1).padStart(2, '0') : v))),
            cfg.voice && VOICES.indexOf(cfg.voice) < 0 ? h('option', { value: cfg.voice }, cfg.voice + '（自定义）') : null,
          ),
        ),

        h('div', { style: card },
          h('span', { style: label }, '语速 ' + (cfg.speed || 1).toFixed(2) + '×'),
          h('input', {
            type: 'range', min: 0.6, max: 1.6, step: 0.05,
            value: cfg.speed || 1,
            onChange: (e) => setCfg({ ...cfg, speed: Number(e.target.value) }),
            onMouseUp: (e) => save({ speed: Number(e.target.value) }),
            onTouchEnd: (e) => save({ speed: Number(e.target.value) }),
            style: { width: '100%', accentColor: T.accent },
          }),
          h('span', { style: { ...label, marginTop: 10 } }, '情绪强度'),
          h('div', { style: row },
            h('span', { style: { color: T.dim, fontSize: 12, width: 40 } }, '开心'),
            h('input', {
              type: 'range', min: 0, max: 1, step: 0.05, value: cfg.happy || 0,
              onChange: (e) => setCfg({ ...cfg, happy: Number(e.target.value) }),
              onMouseUp: (e) => save({ happy: Number(e.target.value) }),
              style: { flex: '1 1 120px', accentColor: T.accent },
            }),
            h('span', { style: { color: T.text, fontSize: 12, width: 34 } }, (cfg.happy || 0).toFixed(2)),
          ),
          h('div', { style: row },
            h('span', { style: { color: T.dim, fontSize: 12, width: 40 } }, '平静'),
            h('input', {
              type: 'range', min: 0, max: 1, step: 0.05, value: cfg.calm || 0,
              onChange: (e) => setCfg({ ...cfg, calm: Number(e.target.value) }),
              onMouseUp: (e) => save({ calm: Number(e.target.value) }),
              style: { flex: '1 1 120px', accentColor: T.accent },
            }),
            h('span', { style: { color: T.text, fontSize: 12, width: 34 } }, (cfg.calm || 0).toFixed(2)),
          ),
        ),
      )
    }

    // ---------------- 外壳 ----------------
    const TABS = [
      ['eye', '眼', Eyes],
      ['ear', '耳', Ears],
      ['hand', '手', Hands],
      ['mouth', '口', Mouth],
    ]

    function Panel() {
      const [tab, setTab] = React.useState('eye')
      const [ver, setVer] = React.useState('')
      React.useEffect(() => {
        let alive = true
        api('/status').then((s) => { if (alive) setVer(s.version || '') }).catch(() => {})
        return () => { alive = false }
      }, [])

      const Active = (TABS.find((t) => t[0] === tab) || TABS[0])[2]

      return h('div', { style: { color: T.text, fontSize: 13 } },
        h('div', { style: { ...row, justifyContent: 'space-between', marginBottom: 10 } },
          h('div', { style: { fontSize: 15, fontWeight: 600 } }, '鲸的感官'),
          h('div', { style: { color: T.dim, fontSize: 11 } }, ver ? 'v' + ver : ''),
        ),
        h('div', { style: { ...row, marginBottom: 12, borderBottom: '1px solid ' + T.line, paddingBottom: 8 } },
          TABS.map(([id, cn]) => h('button', {
            key: id,
            style: btn(tab === id),
            onClick: () => setTab(id),
          }, cn)),
        ),
        h(Active),
      )
    }

    // ==================== 耳：语音输入（2026-11-11 从 dsh-voice-panel 整块合并进来） ====================
    // 接口地址没变（还是 /dsh-voice），服务端在 lib/voice-input/host.js。
    // 这一块自己注册：设置页「语音输入（耳）」 + 输入框上方的快捷键录音组件。
    const VoiceInput = (() => {
    var module = { exports: {} }
    var exports = {}
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })


    const STATUS_URL = '/dsh-voice/status'
    const SELECTION_URL = '/dsh-voice/selection'
    const PREPARE_URL = '/dsh-voice/prepare'
    const CANCEL_URL = '/dsh-voice/cancel'
    const CONFIG_URL = '/dsh-voice/config'
    const TRANSCRIBE_URL = '/dsh-voice/transcribe'
    const POLISH_URL = '/dsh-voice/polish'

    const DEFAULT_HOTKEY = 'Ctrl+Shift+Space'
    const MAX_RECORD_SECONDS = 60

    const LANGUAGES = [
      ['auto', '自动（中英混合）'],
      ['zh', '中文'],
      ['en', '英语'],
      ['yue', '粤语'],
      ['ja', '日语'],
      ['ko', '韩语'],
    ]

    const PHASE_TEXT = {
      checking: '检查模型…',
      standby: '待唤醒',
      waking: '唤醒中…',
      loading: '加载模型…',
      ready: '就绪',
      downloading: '下载模型中…',
      preparing: '准备中…',
      cancelling: '正在取消…',
      cancelled: '准备已取消',
      failed: '准备失败',
      unprepared: '未准备',
    }

    const USABLE = new Set(['ready', 'standby', 'waking'])

    // ---- 快捷键：解析 / 匹配 / 生成显示文本 ----
    const KEY_ALIASES = {
      space: ' ',
      spacebar: ' ',
      enter: 'enter',
      return: 'enter',
      esc: 'escape',
      escape: 'escape',
      tab: 'tab',
      backspace: 'backspace',
      delete: 'delete',
      arrowup: 'arrowup',
      arrowdown: 'arrowdown',
      arrowleft: 'arrowleft',
      arrowright: 'arrowright',
    }

    function normalizeKey(value) {
      const low = String(value || '').toLowerCase()
      return KEY_ALIASES[low] || low
    }

    function keyOfEvent(event) {
      if (event.code === 'Space') return ' '
      return normalizeKey(event.key)
    }

    /** 单一修饰键快捷键：event.code → 显示名（左右分开）。 */
    const MODIFIER_CODES = {
      altleft: '左Alt',
      altright: '右Alt',
      controlleft: '左Ctrl',
      controlright: '右Ctrl',
      shiftleft: '左Shift',
      shiftright: '右Shift',
      metaleft: '左Win',
      metaright: '右Win',
    }

    /** 允许用户手打的中文/英文别名 → event.code。 */
    const MODIFIER_ALIASES = (() => {
      const map = {}
      for (const [code, label] of Object.entries(MODIFIER_CODES)) {
        map[code] = code
        map[label.toLowerCase()] = code
      }
      // 常见写法：lalt / ralt / lctrl / rctrl / lwin / rwin
      map.lalt = 'altleft'
      map.ralt = 'altright'
      map.lctrl = 'controlleft'
      map.rctrl = 'controlright'
      map.lshift = 'shiftleft'
      map.rshift = 'shiftright'
      map.lwin = 'metaleft'
      map.rwin = 'metaright'
      return map
    })()

    function modifierCodeOf(text) {
      return MODIFIER_ALIASES[String(text || '').trim().toLowerCase()] || ''
    }

    function parseHotkey(text) {
      const modifierCode = modifierCodeOf(text)
      if (modifierCode) return { modifierOnly: true, code: modifierCode }
      const spec = { ctrl: false, alt: false, shift: false, meta: false, key: '' }
      const parts = String(text || '').split('+').map((part) => part.trim()).filter(Boolean)
      for (const part of parts) {
        const low = part.toLowerCase()
        if (low === 'ctrl' || low === 'control') spec.ctrl = true
        else if (low === 'alt' || low === 'option') spec.alt = true
        else if (low === 'shift') spec.shift = true
        else if (low === 'meta' || low === 'cmd' || low === 'win' || low === 'super') spec.meta = true
        else spec.key = normalizeKey(part)
      }
      return spec.key ? spec : null
    }

    function matchHotkey(event, spec) {
      if (!spec) return false
      if (event.isComposing || event.repeat) return false
      if (spec.modifierOnly) {
        if (String(event.code || '').toLowerCase() !== spec.code) return false
        // 不允许再叠别的修饰键，避免 Ctrl+Alt 之类被误触发
        if (spec.code.startsWith('alt') && (event.ctrlKey || event.shiftKey || event.metaKey)) return false
        if (spec.code.startsWith('control') && (event.altKey || event.shiftKey || event.metaKey)) return false
        if (spec.code.startsWith('shift') && (event.ctrlKey || event.altKey || event.metaKey)) return false
        if (spec.code.startsWith('meta') && (event.ctrlKey || event.altKey || event.shiftKey)) return false
        return true
      }
      if (event.ctrlKey !== spec.ctrl) return false
      if (event.altKey !== spec.alt) return false
      if (event.shiftKey !== spec.shift) return false
      if (event.metaKey !== spec.meta) return false
      return keyOfEvent(event) === spec.key
    }

    const MODIFIER_ONLY = new Set(['control', 'shift', 'alt', 'meta'])
    const KEY_LABELS = { ' ': 'Space', enter: 'Enter', escape: 'Esc', tab: 'Tab', backspace: 'Backspace', delete: 'Delete' }

    function describeEvent(event) {
      if (MODIFIER_ONLY.has(String(event.key).toLowerCase())) return null
      const parts = []
      if (event.ctrlKey) parts.push('Ctrl')
      if (event.altKey) parts.push('Alt')
      if (event.shiftKey) parts.push('Shift')
      if (event.metaKey) parts.push('Meta')
      const key = keyOfEvent(event)
      if (!key) return null
      const label = KEY_LABELS[key] || (key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1))
      parts.push(label)
      return parts.join('+')
    }

    // ---- 唤醒词匹配 ----
    function normalizePhrase(text) {
      return String(text || '')
        .replace(/[\s，。！？、,.?!;；:："'“”‘’（）()【】\[\]《》]/g, '')
        .toLowerCase()
    }

    /**
     * 唤醒匹配专用的「归一同音字」：识别经常把「墨」写成「莫/默/末/沫/陌」，
     * 这里统一成「墨」再比，避免一字之差叫不醒。只用于匹配，不改用户正文。
     */
    function normalizeForWake(text) {
      return normalizePhrase(text).replace(/[莫默末沫陌]/g, '墨')
    }

    /** 唤醒词候选：完整词 + 若它本身是重复（小鲸小鲸）也接受单份（小鲸），防止分段把词切碎。 */
    function wakeCandidates(word) {
      const full = normalizeForWake(word)
      const list = new Set()
      if (full.length >= 2) list.add(full)
      const half = full.length / 2
      if (full.length >= 4 && Number.isInteger(half) && full.slice(0, half) === full.slice(half)) list.add(full.slice(0, half))
      return [...list]
    }

    function matchesWakeWord(text, word) {
      const normalized = normalizeForWake(text)
      if (!normalized) return false
      return wakeCandidates(word).some((candidate) => candidate && normalized.includes(candidate))
    }

    const SEND_COMMANDS = new Set(['发送', '发送吧', '发送消息', '发出去', '发送出去', '发一下', '发吧', '发出'])
    const STOP_SPEAK_COMMANDS = new Set(['停止', '停', '停止朗读', '别念了', '别读了', '暂停', '停一下', '安静'])
    const NEXT_SPEAK_COMMANDS = new Set(['继续', '接着念', '继续念', '念下一条', '下一条', '接着说'])
    const PREV_SPEAK_COMMANDS = new Set([
      '上一条', '念上一条', '前一条', '上一条回复', '刚才那条',
      // 识别常把「念」听成「面/年/连」，同音变体一并收进来
      '面上一条', '面上条', '年上一条', '连上一条', '念上条', '上条',
    ])

    /** 口令容忍多一两个字（识别会有「那上一条」「念一下上一条」这种前后缀）。 */
    function matchSpeakCommand(normalized, set, keyword) {
      if (set.has(normalized)) return true
      return normalized.includes(keyword) && normalized.length <= keyword.length + 4
    }

    const isStopSpeak = (normalized) =>
      STOP_SPEAK_COMMANDS.has(normalized) ||
      (normalized.includes('停') && normalized.length <= 3) ||
      (normalized.includes('别念') && normalized.length <= 4)

    const isNextSpeak = (normalized) =>
      matchSpeakCommand(normalized, NEXT_SPEAK_COMMANDS, '下一条') ||
      matchSpeakCommand(normalized, NEXT_SPEAK_COMMANDS, '继续')

    const isPrevSpeak = (normalized) =>
      matchSpeakCommand(normalized, PREV_SPEAK_COMMANDS, '上一条') ||
      matchSpeakCommand(normalized, PREV_SPEAK_COMMANDS, '刚才那条')

    function isSendCommand(text) {
      const normalized = normalizePhrase(text)
      if (SEND_COMMANDS.has(normalized)) return true
      // 短句里以「发送」结尾也算（避免把「把这个发送给他」这种长句误判）
      return normalized.length <= 4 && normalized.endsWith('发送')
    }

    // ---- 配置共享（面板改完，快捷键组件立刻生效） ----
    const configStore = (() => {
      let value = { hotkey: DEFAULT_HOTKEY, enabled: true, autoSend: false, polish: false, wakeEnabled: false, wakeWord: '小鲸，小鲸' }
      const listeners = new Set()
      return {
        get: () => value,
        set: (next) => {
          value = next
          listeners.forEach((listener) => listener())
        },
        subscribe: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
    })()

    async function refreshConfig() {
      const response = await fetch(CONFIG_URL, { cache: 'no-store' })
      const data = await response.json()
      if (data && data.ok && data.config) configStore.set(data.config)
      return data
    }

    // ---- 录音：Web Audio → Float32 → WAV(PCM16 16k 单声道) ----
    function encodeWav(samples, sampleRate) {
      const frames = samples.length
      const buffer = new ArrayBuffer(44 + frames * 2)
      const view = new DataView(buffer)
      const write = (offset, text) => {
        for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
      }
      write(0, 'RIFF')
      view.setUint32(4, 36 + frames * 2, true)
      write(8, 'WAVE')
      write(12, 'fmt ')
      view.setUint32(16, 16, true)
      view.setUint16(20, 1, true)
      view.setUint16(22, 1, true)
      view.setUint32(24, sampleRate, true)
      view.setUint32(28, sampleRate * 2, true)
      view.setUint16(32, 2, true)
      view.setUint16(34, 16, true)
      write(36, 'data')
      view.setUint32(40, frames * 2, true)
      for (let i = 0; i < frames; i++) {
        let sample = samples[i]
        if (!isFinite(sample)) sample = 0
        sample = Math.max(-1, Math.min(1, sample))
        view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
      }
      return new Uint8Array(buffer)
    }

    function resample(samples, from, to) {
      if (from === to) return samples
      const ratio = from / to
      const length = Math.max(1, Math.floor(samples.length / ratio))
      const out = new Float32Array(length)
      for (let i = 0; i < length; i++) {
        const position = i * ratio
        const index = Math.floor(position)
        const frac = position - index
        const a = samples[index] || 0
        const b = samples[index + 1] === undefined ? a : samples[index + 1]
        out[i] = a + (b - a) * frac
      }
      return out
    }

    function toBase64(bytes) {
      let binary = ''
      const chunk = 0x8000
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
      }
      return btoa(binary)
    }

    /** 全局快捷键录音时，窗口在后台看不见浮条——给个短提示音。 */
    function beep(frequency) {
      try {
        const context = new AudioContext()
        const oscillator = context.createOscillator()
        const gain = context.createGain()
        oscillator.frequency.value = frequency
        gain.gain.value = 0.04
        oscillator.connect(gain)
        gain.connect(context.destination)
        oscillator.start()
        oscillator.stop(context.currentTime + 0.08)
        setTimeout(() => { try { context.close() } catch {} }, 400)
      } catch {}
    }

    function createRecorder(onLevel, deviceId) {
      let stream = null
      let context = null
      let processor = null
      let source = null
      let chunks = []
      let sampleRate = 16000
      let active = false

      async function start() {
        if (active) return
        const audio = { channelCount: 1, echoCancellation: true, noiseSuppression: true }
        if (deviceId) audio.deviceId = { exact: deviceId }
        stream = await navigator.mediaDevices.getUserMedia({ audio })
        let audioContext
        try {
          audioContext = new AudioContext({ sampleRate: 16000 })
        } catch {
          audioContext = new AudioContext()
        }
        context = audioContext
        sampleRate = context.sampleRate
        source = context.createMediaStreamSource(stream)
        processor = context.createScriptProcessor(4096, 1, 1)
        const mute = context.createGain()
        mute.gain.value = 0
        processor.onaudioprocess = (event) => {
          const input = event.inputBuffer.getChannelData(0)
          chunks.push(new Float32Array(input))
          if (onLevel) {
            let sum = 0
            for (let i = 0; i < input.length; i++) sum += input[i] * input[i]
            onLevel(Math.sqrt(sum / input.length))
          }
        }
        source.connect(processor)
        processor.connect(mute)
        mute.connect(context.destination)
        active = true
      }

      async function release() {
        if (!active) return null
        active = false
        try { processor.disconnect() } catch {}
        try { source.disconnect() } catch {}
        try { await context.close() } catch {}
        if (stream) stream.getTracks().forEach((track) => track.stop())
        const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
        const merged = new Float32Array(total)
        let offset = 0
        for (const chunk of chunks) {
          merged.set(chunk, offset)
          offset += chunk.length
        }
        chunks = []
        return { samples: merged, sampleRate }
      }

      async function stop() {
        const audio = await release()
        if (!audio) return null
        const samples = resample(audio.samples, audio.sampleRate, 16000)
        return encodeWav(samples, 16000)
      }

      async function cancel() {
        await release()
      }

      return { start, stop, cancel }
    }

    // ---- 样式 ----
    const S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 14, padding: '4px 0', fontSize: 13, color: 'var(--dsw-alias-label-primary)' },
      title: { fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)', textTransform: 'uppercase', letterSpacing: '.04em', margin: '2px 0 -4px' },
      row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      card: {
        display: 'flex', gap: 12, alignItems: 'center', padding: '12px 14px', borderRadius: 10,
        border: '1px solid var(--dsw-alias-border-secondary, rgba(0,0,0,.1))',
        background: 'var(--dsw-alias-fill-tsp-secondary, rgba(0,0,0,.03))',
      },
      dot: (on) => ({
        width: 9, height: 9, borderRadius: 999, flex: 'none',
        background: on ? 'var(--dsw-alias-fill-success, #22c55e)' : 'var(--dsw-alias-label-tertiary, #9ca3af)',
        boxShadow: on ? '0 0 0 3px rgba(34,197,94,.18)' : 'none',
      }),
      label: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
      hint: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', lineHeight: 1.6 },
      input: {
        padding: '6px 8px', fontSize: 13, borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-secondary, rgba(0,0,0,.15))',
        background: 'transparent', color: 'inherit',
      },
      kbd: {
        padding: '3px 8px', fontSize: 12, borderRadius: 6, fontFamily: 'ui-monospace, monospace',
        border: '1px solid var(--dsw-alias-border-secondary, rgba(0,0,0,.18))',
        background: 'var(--dsw-alias-fill-tsp-secondary, rgba(0,0,0,.05))',
        minWidth: 40, textAlign: 'center',
      },
      btn: {
        padding: '6px 12px', fontSize: 12, borderRadius: 6, cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-secondary, rgba(0,0,0,.15))',
        background: 'transparent', color: 'inherit',
      },
      btnPrimary: {
        padding: '6px 14px', fontSize: 12, borderRadius: 6, cursor: 'pointer', border: 'none',
        background: 'var(--dsw-alias-fill-primary, #3b82f6)', color: '#fff', fontWeight: 600,
      },
      notice: { fontSize: 12, minHeight: 18, color: 'var(--dsw-alias-label-secondary)' },
      key: { fontFamily: 'ui-monospace, monospace', fontSize: 11, padding: '1px 5px', borderRadius: 4, background: 'var(--dsw-alias-fill-tsp-secondary, rgba(0,0,0,.06))' },
      progress: { height: 6, borderRadius: 999, background: 'var(--dsw-alias-fill-tsp-secondary, rgba(0,0,0,.08))', overflow: 'hidden', flex: 1 },
      progressBar: (ratio) => ({ height: '100%', width: Math.round(ratio * 100) + '%', background: 'var(--dsw-alias-fill-primary, #3b82f6)' }),
      pill: {
        position: 'fixed', left: '50%', bottom: 96, transform: 'translateX(-50%)', zIndex: 9999,
        display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderRadius: 999,
        background: 'rgba(15, 23, 42, .92)', color: '#f8fafc', boxShadow: '0 8px 24px rgba(0,0,0,.25)',
        fontSize: 13, pointerEvents: 'none', userSelect: 'none',
      },
      micDot: {
        width: 10, height: 10, borderRadius: 999, background: '#ef4444', flex: 'none',
        boxShadow: '0 0 0 4px rgba(239,68,68,.25)',
      },
      level: { width: 64, height: 6, borderRadius: 999, background: 'rgba(255,255,255,.2)', overflow: 'hidden' },
    }

    function progressOf(preparation) {
      if (!preparation || preparation.phase !== 'downloading') return null
      const done = Number(preparation.bytesDone)
      const total = Number(preparation.bytesTotal)
      if (isFinite(done) && isFinite(total) && total > 0) return done / total
      return null
    }

    function statusLine(data) {
      if (!data) return { on: false, text: '读取中…' }
      if (data.available === false) return { on: false, text: '语音输入服务未启用' }
      const provider = (data.providers || []).find((item) => item.id === data.selection.providerId) || (data.providers || [])[0]
      if (!provider) return { on: false, text: '没有可用的识别器' }
      const phase = (provider.preparation && provider.preparation.phase) || 'ready'
      const text = PHASE_TEXT[phase] || phase
      return {
        on: USABLE.has(phase),
        phase,
        provider,
        text: text + (phase === 'standby' ? '（第一次录音时唤醒，约 1–2 秒）' : ''),
      }
    }

    // ---- 设置页面板 ----
    function Panel() {
      const [data, setData] = React.useState(null)
      const [config, setConfig] = React.useState(configStore.get())
      const [draft, setDraft] = React.useState(configStore.get().hotkey || DEFAULT_HOTKEY)
      const [globalDraft, setGlobalDraft] = React.useState(configStore.get().globalHotkey || '')
      const [silenceDraft, setSilenceDraft] = React.useState(String(configStore.get().silenceStopMs ?? 1000))
      const [autoSendDelayDraft, setAutoSendDelayDraft] = React.useState(String(configStore.get().autoSendDelayMs ?? 1000))
      const [wakeWordDraft, setWakeWordDraft] = React.useState(configStore.get().wakeWord || '小鲸，小鲸')
      const [captureTarget, setCaptureTarget] = React.useState('')
      const [devices, setDevices] = React.useState([])
      const [notice, setNotice] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      const load = React.useCallback(() => {
        fetch(STATUS_URL, { cache: 'no-store' })
          .then((response) => response.json())
          .then((value) => setData(value))
          .catch(() => setNotice('读取状态失败（宿主没在跑？）'))
      }, [])

      const refreshDevices = React.useCallback(async (askPermission) => {
        try {
          if (askPermission) {
            const probe = await navigator.mediaDevices.getUserMedia({ audio: true })
            probe.getTracks().forEach((track) => track.stop())
          }
          const list = await navigator.mediaDevices.enumerateDevices()
          setDevices(list.filter((item) => item.kind === 'audioinput'))
        } catch (error) {
          setNotice('列麦克风失败：' + (error && error.message ? error.message : String(error)))
        }
      }, [])

      React.useEffect(() => {
        load()
        refreshConfig().catch(() => {})
        refreshDevices(false)
        const onDeviceChange = () => refreshDevices(false)
        if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
          navigator.mediaDevices.addEventListener('devicechange', onDeviceChange)
        }
        const timer = setInterval(load, 2500)
        const unsubscribe = configStore.subscribe(() => {
          const next = configStore.get()
          setConfig(next)
          setDraft(next.hotkey || DEFAULT_HOTKEY)
          setGlobalDraft(next.globalHotkey || '')
          setSilenceDraft(String(next.silenceStopMs ?? 1000))
          setAutoSendDelayDraft(String(next.autoSendDelayMs ?? 1000))
          setWakeWordDraft(next.wakeWord || '小鲸，小鲸')
        })
        setConfig(configStore.get())
        setDraft(configStore.get().hotkey || DEFAULT_HOTKEY)
        setGlobalDraft(configStore.get().globalHotkey || '')
        setSilenceDraft(String(configStore.get().silenceStopMs ?? 1000))
        setAutoSendDelayDraft(String(configStore.get().autoSendDelayMs ?? 1000))
        setWakeWordDraft(configStore.get().wakeWord || '小鲸，小鲸')
        return () => {
          clearInterval(timer)
          unsubscribe()
          if (navigator.mediaDevices && navigator.mediaDevices.removeEventListener) {
            navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange)
          }
        }
      }, [load, refreshDevices])

      const saveConfig = (patch, okText) => {
        setBusy(true)
        fetch(CONFIG_URL, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        })
          .then((response) => response.json())
          .then((value) => {
            if (!value || value.ok === false) {
              setNotice('保存失败：' + ((value && value.error) || '未知错误'))
              return
            }
            configStore.set(value.config)
            setNotice(value.globalError || okText || '已保存')
          })
          .catch(() => setNotice('保存失败'))
          .finally(() => setBusy(false))
      }

      // 录制快捷键：按组合键直接存；只按一个修饰键（左Alt/右Alt…）时等松手再存。
      // captureTarget = 'local' 页面键（允许单修饰键）/ 'global' 全局键（必须带修饰键或 F 键）。
      React.useEffect(() => {
        if (!captureTarget) return
        const target = captureTarget
        window.__dshVoiceCapturing = true
        let held = []
        let combo = false

        const finish = (text) => {
          setCaptureTarget('')
          if (target === 'global') {
            setGlobalDraft(text)
            saveConfig({ globalHotkey: text, globalEnabled: true }, '全局快捷键已保存：' + text)
          } else {
            setDraft(text)
            saveConfig({ hotkey: text }, '快捷键已保存：' + text)
          }
        }

        const onKeyDown = (event) => {
          event.preventDefault()
          event.stopPropagation()
          if (event.key === 'Escape') {
            setCaptureTarget('')
            setNotice('已取消录制')
            return
          }
          if (event.isComposing) {
            setNotice('输入法正在组字，先切到英文输入再录快捷键')
            return
          }

          const code = String(event.code || '').toLowerCase()
          if (MODIFIER_CODES[code]) {
            if (!held.includes(code)) held.push(code)
            if (held.length > 1) combo = true
            setNotice(
              '按住了 ' + MODIFIER_CODES[code] +
              (target === 'global'
                ? '：全局快捷键必须再按一个键，比如加 V'
                : '：松手就用它当快捷键；继续按别的键则是组合键'),
            )
            return
          }

          const described = describeEvent(event)
          if (!described) return
          const plainKey = !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey
          const functionKey = /^f([1-9]|1[0-2])$/i.test(String(event.key))
          if (plainKey && !functionKey) {
            setNotice('收到「' + described + '」：快捷键至少要带一个 Ctrl / Alt / Shift / Meta，或者用 F1–F12')
            return
          }
          finish(described)
        }

        const onKeyUp = (event) => {
          const code = String(event.code || '').toLowerCase()
          if (!MODIFIER_CODES[code]) return
          const single = held.length === 1 && held[0] === code && !combo
          held = held.filter((item) => item !== code)
          if (held.length === 0) combo = false
          if (!single) return
          event.preventDefault()
          event.stopPropagation()
          if (target === 'global') {
            setNotice('全局快捷键不能只用单个修饰键，请再加上一个键（比如 ' + MODIFIER_CODES[code] + '+V）')
            return
          }
          finish(MODIFIER_CODES[code])
        }

        window.addEventListener('keydown', onKeyDown, true)
        window.addEventListener('keyup', onKeyUp, true)
        return () => {
          window.__dshVoiceCapturing = false
          window.removeEventListener('keydown', onKeyDown, true)
          window.removeEventListener('keyup', onKeyUp, true)
        }
      }, [captureTarget])

      const changeLanguage = (language) => {
        const providerId = data && data.selection ? data.selection.providerId : undefined
        setBusy(true)
        fetch(SELECTION_URL, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(Object.assign({ language }, providerId ? { providerId } : {})),
        })
          .then((response) => response.json())
          .then((value) => {
            if (!value || value.ok === false) {
              setNotice('失败：' + ((value && (value.error || value.message)) || '未知错误'))
              return
            }
            setData(value)
            setNotice('已保存，立即生效')
          })
          .catch(() => setNotice('请求失败'))
          .finally(() => setBusy(false))
      }

      const prepare = () => {
        setBusy(true)
        fetch(PREPARE_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
          .then((response) => response.json())
          .then((value) => {
            if (!value || value.ok === false) { setNotice('失败：' + ((value && (value.error || value.message)) || '未知错误')); return }
            setData(value)
            setNotice('已开始准备')
          })
          .catch(() => setNotice('请求失败'))
          .finally(() => setBusy(false))
      }

      const cancel = () => {
        setBusy(true)
        fetch(CANCEL_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
          .then((response) => response.json())
          .then((value) => {
            if (!value || value.ok === false) { setNotice('失败：' + ((value && (value.error || value.message)) || '未知错误')); return }
            setData(value)
            setNotice('已取消')
          })
          .catch(() => setNotice('请求失败'))
          .finally(() => setBusy(false))
      }

      const saveHotkey = () => {
        const text = String(draft || '').trim()
        if (!parseHotkey(text)) {
          setNotice('这个组合键看不懂：试试 Ctrl+Alt+V、Alt+Q 或 F9 这种写法')
          return
        }
        saveConfig({ hotkey: text }, '快捷键已保存：' + text)
      }

      const saveGlobalHotkey = () => {
        const text = String(globalDraft || '').trim()
        if (!text) {
          saveConfig({ globalHotkey: '', globalEnabled: false }, '已清空并关闭全局快捷键')
          return
        }
        const spec = parseHotkey(text)
        const modifierCount = spec && !spec.modifierOnly
          ? [spec.ctrl, spec.alt, spec.shift, spec.meta].filter(Boolean).length
          : 0
        const functionKey = spec && !spec.modifierOnly && /^f([1-9]|1[0-2])$/.test(spec.key || '')
        if (!spec || spec.modifierOnly || (modifierCount === 0 && !functionKey)) {
          setNotice('全局快捷键要写成带修饰键的组合（如 Alt+Q、Ctrl+Shift+Space）或 F1–F12')
          return
        }
        saveConfig({ globalHotkey: text, globalEnabled: true }, '全局快捷键已保存：' + text)
      }

      const saveSilence = () => {
        const value = Number(silenceDraft)
        if (!Number.isFinite(value) || value < 0 || value > 10000) {
          setNotice('自动结束时间要在 0–10000 毫秒之间（0 = 关闭）')
          return
        }
        const rounded = Math.round(value)
        saveConfig({ silenceStopMs: rounded }, rounded === 0 ? '已关闭自动结束' : '说完自动停：' + rounded + ' 毫秒')
      }

      const saveAutoSendDelay = () => {
        const value = Number(autoSendDelayDraft)
        if (!Number.isFinite(value) || value < 0 || value > 10000) {
          setNotice('发送间隔要在 0–10000 毫秒之间')
          return
        }
        const rounded = Math.round(value)
        saveConfig({ autoSendDelayMs: rounded }, '发送间隔已保存：' + rounded + ' 毫秒')
      }

      const saveWakeWord = () => {
        const text = String(wakeWordDraft || '').trim()
        if (!text) {
          setNotice('唤醒词不能为空')
          return
        }
        saveConfig({ wakeWord: text }, '唤醒词已保存：' + text)
      }

      const line = statusLine(data)
      const provider = line.provider
      const preparation = provider && provider.preparation ? provider.preparation : {}
      const ratio = progressOf(preparation)
      const needsPrepare = line.phase === 'unprepared' || line.phase === 'failed'

      return h('div', { style: S.wrap },
        h('div', { style: S.card },
          h('span', { style: S.dot(line.on) }),
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', { style: { fontSize: 13, fontWeight: 600 } }, '语音输入',
              data && data.version ? h('span', { style: { fontSize: 11, fontWeight: 400, opacity: 0.6, marginLeft: 6 } }, 'v' + String(data.version)) : null),
            h('div', { style: S.hint }, line.text),
          ),
          h('button', { style: S.btn, disabled: busy, onClick: load }, '刷新'),
        ),

        ratio !== null
          ? h('div', { style: S.row }, h('div', { style: S.progress }, h('div', { style: S.progressBar(ratio) })))
          : null,

        data && data.available === false
          ? h('div', { style: S.hint },
            '这套面板管的是 DSH 自带的实验性语音输入（本地 SenseVoice）。它没启用的原因通常是 profile 的 ',
            h('span', { style: S.key }, 'dsh.profile.bundles'),
            ' 里没有 ',
            h('span', { style: S.key }, '@deepseek-ai/dsh-experimental-voice-input-bundle'),
            '；加上后重启一次 DeepSeek Harness。',
          )
          : null,

        // ---- 快捷键 ----
        h('div', { style: S.title }, '快捷键'),
        h('div', { style: S.row },
          h('span', { style: S.label }, '页面内'),
          h('input', {
            style: Object.assign({}, S.input, { width: 190, fontFamily: 'ui-monospace, monospace' }),
            value: draft,
            placeholder: '例如 右Alt / Ctrl+Alt+V',
            disabled: busy,
            onChange: (event) => setDraft(event.target.value),
            onBlur: () => {
              if (String(draft || '').trim() !== String(config.hotkey || '')) saveHotkey()
            },
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                saveHotkey()
              }
            },
          }),
          h('button', {
            style: captureTarget === 'local' ? S.btnPrimary : S.btn,
            disabled: busy,
            onClick: () => { setNotice(''); setCaptureTarget('local') },
          }, captureTarget === 'local' ? '按下想要的按键…' : '录制'),
          h('button', {
            style: S.btn,
            disabled: busy,
            onClick: () => { setDraft(DEFAULT_HOTKEY); saveConfig({ hotkey: DEFAULT_HOTKEY }, '已恢复默认快捷键') },
          }, '恢复默认'),
          h('label', { style: Object.assign({}, S.row, { gap: 4, cursor: 'pointer' }) },
            h('input', {
              type: 'checkbox',
              checked: config.enabled !== false,
              onChange: (event) => saveConfig({ enabled: event.target.checked }, event.target.checked ? '已启用页面快捷键' : '已停用页面快捷键'),
            }),
            h('span', { style: S.label }, '启用'),
          ),
        ),
        h('div', { style: S.hint },
          '点「录制」直接按：组合键存组合，只按一个 左Alt / 右Alt / 左Ctrl 这类单键则松手即存；也可以在框里手打（回车或点别处生效）。',
          h('br'),
          '按住这个键开始录音，松开后自动识别并插入到当前光标处；录音中按 Esc 取消。页面级：DSH 窗口在后台时收不到。',
        ),

        h('div', { style: S.row, marginTop: 6 },
          h('span', { style: S.label }, '全局'),
          h('input', {
            style: Object.assign({}, S.input, { width: 190, fontFamily: 'ui-monospace, monospace' }),
            value: globalDraft,
            placeholder: '例如 Alt+Q',
            disabled: busy,
            onChange: (event) => setGlobalDraft(event.target.value),
            onBlur: () => {
              if (String(globalDraft || '').trim() !== String(config.globalHotkey || '')) saveGlobalHotkey()
            },
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                saveGlobalHotkey()
              }
            },
          }),
          h('button', {
            style: captureTarget === 'global' ? S.btnPrimary : S.btn,
            disabled: busy,
            onClick: () => { setNotice(''); setCaptureTarget('global') },
          }, captureTarget === 'global' ? '按下想要的按键…' : '录制'),
          h('button', {
            style: config.globalEnabled ? S.btn : S.btnPrimary,
            disabled: busy,
            onClick: () => saveConfig(
              { globalEnabled: config.globalEnabled !== true },
              config.globalEnabled ? '已关闭全局快捷键' : '已开启全局快捷键',
            ),
          }, config.globalEnabled ? '关闭全局' : '启用全局'),
        ),
        h('div', { style: S.hint },
          '全局键在 DSH 窗口不在前台时也能用：按一下开始录音，再按一下结束并上屏（系统热键只给按下事件，没有松开）。必须是带修饰键的组合或 F1–F12。',
        ),

        h('div', { style: S.row },
          h('span', { style: S.label }, '说完自动停'),
          h('input', {
            style: Object.assign({}, S.input, { width: 110 }),
            type: 'number',
            min: 0,
            max: 10000,
            step: 100,
            value: silenceDraft,
            disabled: busy,
            onChange: (event) => setSilenceDraft(event.target.value),
            onBlur: saveSilence,
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                saveSilence()
              }
            },
          }),
          h('span', { style: S.hint }, '毫秒，默认 1000；0 = 不自动停。只对全局快捷键（按住说话不受影响）。'),
        ),

        // ---- 麦克风 ----
        h('div', { style: S.title, marginTop: 6 }, '麦克风'),
        h('div', { style: S.row },
          h('select', {
            style: Object.assign({}, S.input, { maxWidth: 260 }),
            disabled: busy,
            value: config.deviceId || '',
            onChange: (event) => saveConfig({ deviceId: event.target.value }, event.target.value ? '麦克风已切换' : '已回到系统默认麦克风'),
          },
            h('option', { value: '' }, '系统默认'),
            devices.map((device, index) => h('option', { key: device.deviceId || String(index), value: device.deviceId },
              device.label || ('麦克风 ' + (index + 1)))),
          ),
          h('button', { style: S.btn, disabled: busy, onClick: () => refreshDevices(true) }, '刷新 / 授权'),
          h('span', { style: S.hint }, devices.length ? devices.length + ' 个输入设备' : '还没拿到设备列表，点「刷新 / 授权」'),
        ),

        // ---- 发送 ----
        h('div', { style: S.title, marginTop: 6 }, '发送'),
        h('div', { style: S.row },
          h('label', { style: Object.assign({}, S.row, { gap: 4, cursor: 'pointer' }) },
            h('input', {
              type: 'checkbox',
              checked: config.autoSend === true,
              onChange: (event) => saveConfig({ autoSend: event.target.checked }, event.target.checked ? '已开启自动发送' : '已关闭自动发送'),
            }),
            h('span', { style: S.label }, '自动发送'),
          ),
          h('label', { style: Object.assign({}, S.row, { gap: 4, cursor: 'pointer' }) },
            h('input', {
              type: 'checkbox',
              checked: config.polish === true,
              onChange: (event) => saveConfig({ polish: event.target.checked }, event.target.checked ? '已开启口语整理' : '已关闭口语整理'),
            }),
            h('span', { style: S.label }, '口语整理'),
          ),
        ),
        h('div', { style: S.hint },
          '自动发送：识别完把草稿发出去；下面可以设发送前等多久（默认 1000 毫秒）。',
          h('br'),
          '口语整理：用当前默认模型把口语改写成书面语（去语气词、补标点），会多花 1–3 秒；失败时自动退回原文。',
        ),

        h('div', { style: S.row },
          h('span', { style: S.label }, '发送间隔'),
          h('input', {
            style: Object.assign({}, S.input, { width: 110 }),
            type: 'number',
            min: 0,
            max: 10000,
            step: 100,
            value: autoSendDelayDraft,
            disabled: busy || config.autoSend !== true,
            onChange: (event) => setAutoSendDelayDraft(event.target.value),
            onBlur: saveAutoSendDelay,
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                saveAutoSendDelay()
              }
            },
          }),
          h('span', { style: S.hint }, '毫秒；0 = 插完立刻发。只是延后发送，等待期间不会自动取消。'),
        ),

        // ---- 语音唤醒 ----
        h('div', { style: S.title, marginTop: 6 }, '语音唤醒'),
        h('div', { style: S.row },
          h('label', { style: Object.assign({}, S.row, { gap: 4, cursor: 'pointer' }) },
            h('input', {
              type: 'checkbox',
              checked: config.wakeEnabled === true,
              onChange: (event) => saveConfig(
                { wakeEnabled: event.target.checked },
                event.target.checked ? '已开启语音唤醒（会一直占用麦克风）' : '已关闭语音唤醒',
              ),
            }),
            h('span', { style: S.label }, '启用语音唤醒'),
          ),
          h('span', { style: S.label }, '唤醒词'),
          h('input', {
            style: Object.assign({}, S.input, { width: 160 }),
            value: wakeWordDraft,
            disabled: busy,
            onChange: (event) => setWakeWordDraft(event.target.value),
            onBlur: saveWakeWord,
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                saveWakeWord()
              }
            },
          }),
        ),
        h('div', { style: S.hint },
          '开启后麦克风常开，本机做端点检测：听到唤醒词就进入听写，之后每句话自动接在草稿后面；自动发送开着时，静置「发送间隔」那么久就发出去，没开则说「发送」才发。15 秒没动静自动退出。',
          h('br'),
          '和朗读联动：朗读播放中说「停 / 停止 / 别念了」会停，说「继续 / 念下一条」接着念，说唤醒词会打断朗读并开始听；朗读时不会把朗读声当成听写。',
          h('br'),
          '识别全在本机，但常开麦克风会一直占用设备，也会出现在系统的麦克风提示里。',
        ),

        data && data.available
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
            h('div', { style: S.title }, '识别'),
            h('div', { style: S.row },
              h('span', { style: S.label }, '识别器'),
              h('span', { style: { fontSize: 12 } }, provider ? provider.name || provider.id : '—'),
              provider && provider.location === 'host-local'
                ? h('span', { style: S.hint }, '（本机 CPU，不上传）')
                : null,
            ),
            h('div', { style: S.row },
              h('span', { style: S.label }, '语言'),
              h('select', {
                style: S.input,
                disabled: busy || !data.available,
                value: (data.selection && data.selection.language) || 'auto',
                onChange: (event) => changeLanguage(event.target.value),
              }, LANGUAGES
                .filter(([value]) => !provider || !provider.languages || provider.languages.includes(value))
                .map(([value, text]) => h('option', { key: value, value }, text))),
              h('span', { style: S.hint }, '识别语言提示；「自动」适合中英混说。'),
            ),

            needsPrepare
              ? h('div', { style: S.row },
                h('button', { style: S.btnPrimary, disabled: busy, onClick: prepare }, '准备模型'),
                h('span', { style: S.hint }, '会从 Hugging Face 下载约 239MB；国内网络可能失败，届时可以手工把模型放进 dataRoot。'),
              )
              : null,
            line.phase === 'downloading' || line.phase === 'preparing'
              ? h('div', { style: S.row },
                h('button', { style: S.btn, disabled: busy, onClick: cancel }, '取消准备'),
              )
              : null,

            h('div', { style: S.title, marginTop: 6 }, '怎么用'),
            h('div', { style: S.hint },
              '输入框右侧、发送键左边有一个麦克风：点一下开始录音，说完再点停止，文字会插进当前草稿（不会自动发送）。',
              h('br'),
              '页面内快捷键按住说话、松开上屏；全局快捷键按一下开始、再按一下结束（会有提示音），窗口在后台也能用。',
              h('br'),
              '识别在本机完成，声音不上传；第一次录音会唤醒引擎，之后很快。',
            ),

            h('div', { style: S.title, marginTop: 6 }, '调试信息'),
            h('div', { style: S.hint },
              'provider: ' + ((data.selection && data.selection.providerId) || '—'),
              ' · phase: ' + (line.phase || '—'),
              ' · languages: ' + ((provider && provider.languages) || []).join('/'),
            ),
          )
          : null,

        h('div', { style: S.notice }, notice),
      )
    }

    // ---- 快捷键录音组件（挂在输入框 overlay 上，拿到 inputActions） ----
    function VoiceHotkey(props) {
      const actionsRef = React.useRef(props.inputActions)
      actionsRef.current = props.inputActions
      const useLiveInput = typeof props.useInput === 'function' ? props.useInput : null
      const inputState = useLiveInput ? useLiveInput((state) => state) : null
      const draftRef = React.useRef('')
      if (inputState && typeof inputState.draft === 'string') draftRef.current = inputState.draft
      const [state, setState] = React.useState({ phase: 'idle', level: 0, message: '' })
      const recorderRef = React.useRef(null)
      const spanRef = React.useRef(null)
      const timerRef = React.useRef(0)
      const configRef = React.useRef(configStore.get())
      const modifierRef = React.useRef('')
      const globalModeRef = React.useRef(false)
      const lastVoiceRef = React.useRef(0)
      const voiceHeardRef = React.useRef(false)
      const autoStopRef = React.useRef(0)
      const wakeRef = React.useRef(null)
      const wakeSessionRef = React.useRef({ active: false, lastAt: 0 })
      const wakeSendTimerRef = React.useRef(0)
      const [wakeOn, setWakeOn] = React.useState(configStore.get().wakeEnabled === true)

      React.useEffect(() => {
        refreshConfig().catch(() => {})
        return configStore.subscribe(() => {
          configRef.current = configStore.get()
          setWakeOn(configStore.get().wakeEnabled === true)
        })
      }, [])

      const finish = React.useCallback(async (cancelled) => {
        const recorder = recorderRef.current
        if (!recorder) return
        recorderRef.current = null
        modifierRef.current = ''
        const wasGlobal = globalModeRef.current
        globalModeRef.current = false
        if (wasGlobal && !cancelled) beep(520)
        clearInterval(autoStopRef.current)
        autoStopRef.current = 0
        clearTimeout(timerRef.current)
        timerRef.current = 0
        const actions = actionsRef.current
        const span = spanRef.current
        spanRef.current = null

        if (cancelled) {
          await recorder.cancel()
          setState({ phase: 'idle', level: 0, message: '' })
          return
        }

        setState({ phase: 'transcribing', level: 0, message: '识别中…' })
        try {
          const wav = await recorder.stop()
          if (!wav) {
            setState({ phase: 'idle', level: 0, message: '' })
            return
          }
          const response = await fetch(TRANSCRIBE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ audioBase64: toBase64(wav) }),
          })
          const result = await response.json()
          if (!result || result.ok === false || !result.text) {
            setState({ phase: 'error', level: 0, message: '识别失败：' + ((result && result.error) || '没有结果') })
            setTimeout(() => setState({ phase: 'idle', level: 0, message: '' }), 4000)
            return
          }
          let text = String(result.text).trim()
          const options = configRef.current || {}
          if (options.polish) {
            setState({ phase: 'transcribing', level: 0, message: '整理中…' })
            try {
              const polishedResponse = await fetch(POLISH_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text }),
              })
              const polished = await polishedResponse.json()
              if (polished && polished.ok && polished.text) text = String(polished.text).trim()
            } catch {
              // 整理失败就用原文，不打扰用户
            }
          }
          if (actions) {
            const inserted = typeof actions.insertText === 'function' && span
              ? actions.insertText(text, span)
              : false
            if (!inserted) {
              if (typeof actions.setDraft === 'function') {
                const current = draftRef.current || ''
                actions.setDraft(current ? (current.endsWith('\n') ? current : current + '\n') + text : text)
              }
            }
            if (options.autoSend && typeof actions.submit === 'function') {
              const rawDelay = Number(options.autoSendDelayMs)
              const delay = Number.isFinite(rawDelay) ? Math.max(0, Math.min(10000, rawDelay)) : 1000
              setTimeout(() => {
                try { actions.submit() } catch {}
              }, delay)
            }
          }
          setState({ phase: 'idle', level: 0, message: '' })
        } catch (error) {
          setState({ phase: 'error', level: 0, message: '录音失败：' + (error && error.message ? error.message : String(error)) })
          setTimeout(() => setState({ phase: 'idle', level: 0, message: '' }), 4000)
        }
      }, [])

      const begin = React.useCallback(async (globalMode) => {
        const config = configRef.current
        if (!config) return
        if (!globalMode && config.enabled === false) return
        if (recorderRef.current) return
        const actions = actionsRef.current
        if (!actions) return
        globalModeRef.current = globalMode === true
        const recorder = createRecorder((level) => {
          if (level > 0.012) {
            lastVoiceRef.current = Date.now()
            voiceHeardRef.current = true
          }
          setState((previous) => (previous.phase === 'recording' ? Object.assign({}, previous, { level }) : previous))
        }, config.deviceId || '')
        try {
          spanRef.current = typeof actions.captureInsertion === 'function' ? actions.captureInsertion() : null
          await recorder.start()
          recorderRef.current = recorder
          lastVoiceRef.current = Date.now()
          voiceHeardRef.current = false
          if (globalModeRef.current) {
            beep(880)
            // 全局模式没有「松开」事件：检测到说完 + 静音 N 毫秒后自动结束
            clearInterval(autoStopRef.current)
            autoStopRef.current = setInterval(() => {
              if (!recorderRef.current || !globalModeRef.current || !voiceHeardRef.current) return
              const limit = Number(configRef.current.silenceStopMs)
              if (!Number.isFinite(limit) || limit <= 0) return
              if (Date.now() - lastVoiceRef.current >= limit) finish(false)
            }, 150)
          }
          setState({ phase: 'recording', level: 0, message: globalModeRef.current ? '再按一下结束（静音会自动停）' : '松开结束 · Esc 取消' })
          timerRef.current = setTimeout(() => { finish(false) }, MAX_RECORD_SECONDS * 1000)
        } catch (error) {
          recorderRef.current = null
          globalModeRef.current = false
          spanRef.current = null
          modifierRef.current = ''
          setState({ phase: 'error', level: 0, message: '打不开麦克风：' + (error && error.message ? error.message : String(error)) })
          setTimeout(() => setState({ phase: 'idle', level: 0, message: '' }), 5000)
        }
      }, [finish])

      React.useEffect(() => {
        const specOf = () => parseHotkey(configRef.current.hotkey || DEFAULT_HOTKEY)

        const onKeyDown = (event) => {
          const config = configRef.current
          if (!config || config.enabled === false) return
          if (window.__dshVoiceCapturing) return
          // 单键录音时按了别的键：先放弃这次录音，让组合键照常工作
          if (recorderRef.current && modifierRef.current && String(event.code || '').toLowerCase() !== modifierRef.current) {
            finish(true)
            return
          }
          if (event.key === 'Escape' && recorderRef.current) {
            event.preventDefault()
            event.stopPropagation()
            finish(true)
            return
          }
          const spec = specOf()
          if (!spec) return
          if (spec.modifierOnly) {
            if (String(event.code || '').toLowerCase() !== spec.code) return
            event.preventDefault()
            event.stopPropagation()
            if (recorderRef.current) return
            modifierRef.current = spec.code
            begin()
            return
          }
          if (!matchHotkey(event, spec)) return
          event.preventDefault()
          event.stopPropagation()
          if (recorderRef.current) return
          begin()
        }

        const onKeyUp = (event) => {
          if (!recorderRef.current) return
          const spec = specOf()
          if (!spec) return
          if (spec.modifierOnly) {
            if (String(event.code || '').toLowerCase() === spec.code) {
              event.preventDefault()
              finish(false)
            }
            return
          }
          // 松开的键属于这组快捷键（修饰键也认），才结束
          if (event.key === 'Control' && spec.ctrl) { event.preventDefault(); finish(false); return }
          if (event.key === 'Alt' && spec.alt) { event.preventDefault(); finish(false); return }
          if (event.key === 'Shift' && spec.shift) { event.preventDefault(); finish(false); return }
          if (event.key === 'Meta' && spec.meta) { event.preventDefault(); finish(false); return }
          if (keyOfEvent(event) === spec.key) { event.preventDefault(); finish(false) }
        }

        const onBlur = () => {
          if (recorderRef.current && !globalModeRef.current) finish(true)
        }

        window.addEventListener('keydown', onKeyDown, true)
        window.addEventListener('keyup', onKeyUp, true)
        window.addEventListener('blur', onBlur)
        return () => {
          window.removeEventListener('keydown', onKeyDown, true)
          window.removeEventListener('keyup', onKeyUp, true)
          window.removeEventListener('blur', onBlur)
          if (recorderRef.current) finish(true)
          clearTimeout(timerRef.current)
          clearInterval(autoStopRef.current)
        }
      }, [begin, finish])

      // 全局快捷键：宿主收到系统热键后通过 SSE 推 toggle，窗口不在前台也能用
      React.useEffect(() => {
        let source = null
        const toggle = () => {
          if (recorderRef.current) {
            finish(false)
            return
          }
          begin(true)
        }
        try {
          source = new EventSource('/dsh-voice/events')
          source.onmessage = (event) => {
            try {
              const payload = JSON.parse(event.data)
              if (payload && payload.type === 'toggle') toggle()
            } catch {}
          }
        } catch {}
        return () => {
          try { if (source) source.close() } catch {}
        }
      }, [begin, finish])

      // ---- 语音唤醒：常开麦克风 → 听到唤醒词进入听写 → 说「发送」提交 ----
      // 自动发送开着时，唤醒会话里说完不用喊「发送」：静置 autoSendDelayMs 后自动提交
      const scheduleWakeSend = React.useCallback(() => {
        clearTimeout(wakeSendTimerRef.current)
        const config = configRef.current || {}
        if (!config.autoSend) return
        const rawDelay = Number(config.autoSendDelayMs)
        const delay = Number.isFinite(rawDelay) ? Math.max(0, Math.min(10000, rawDelay)) : 1000
        wakeSendTimerRef.current = setTimeout(() => {
          wakeSendTimerRef.current = 0
          if (!wakeSessionRef.current.active) return
          wakeSessionRef.current.active = false
          const actions = actionsRef.current
          if (actions && typeof actions.submit === 'function') {
            try { actions.submit() } catch {}
          }
          setState({ phase: 'idle', level: 0, message: '' })
        }, delay)
      }, [])

      const handleWakeText = React.useCallback((text) => {
        const normalized = normalizePhrase(text)
        if (!normalized) return
        const voiceOut = window.__dshVoiceOut
        const speaking = !!(voiceOut && typeof voiceOut.isSpeaking === 'function' && voiceOut.isSpeaking())
        const wakeWordCfg = (configRef.current && configRef.current.wakeWord) || '小鲸，小鲸'
        const session = wakeSessionRef.current

        // 听写会话里只认「一字不差」的控制词，避免把「我们继续吧」这种话吞掉
        const strict = session.active
        const stopCmd = strict ? STOP_SPEAK_COMMANDS.has(normalized) : isStopSpeak(normalized)
        const nextCmd = strict ? NEXT_SPEAK_COMMANDS.has(normalized) : isNextSpeak(normalized)
        const prevCmd = strict ? PREV_SPEAK_COMMANDS.has(normalized) : isPrevSpeak(normalized)

        // 朗读控制口令优先于听写，无论在不在会话里
        if (voiceOut) {
          if (stopCmd && (speaking || session.active)) {
            try { voiceOut.stop() } catch {}
            beep(520)
            if (session.active) {
              session.active = false
              setState({ phase: 'idle', level: 0, message: '' })
            }
            return
          }
          if (nextCmd) {
            try { voiceOut.next() } catch {}
            return
          }
          if (prevCmd) {
            // 等价于点小药丸上的「念上一条」：在播就先停，再点按钮
            if (speaking) {
              try { voiceOut.stop() } catch {}
              setTimeout(() => { try { voiceOut.prev() } catch {} }, 150)
            } else {
              try { voiceOut.prev() } catch {}
            }
            return
          }
        }

        if (speaking) {
          // 朗读中剩下的只处理唤醒词：打断朗读，接着走下面的入会流程
          if (!matchesWakeWord(text, wakeWordCfg)) return
          try { voiceOut.stop() } catch {}
        }

        if (!session.active) {
          if (!matchesWakeWord(text, wakeWordCfg)) return
          session.active = true
          session.lastAt = Date.now()
          clearTimeout(wakeSendTimerRef.current)
          beep(880)
          setState({ phase: 'wake', level: 0, message: configRef.current && configRef.current.autoSend ? '在听（说完自动发）' : '在听，说完说「发送」' })
          return
        }
        session.lastAt = Date.now()
        if (isSendCommand(normalized)) {
          session.active = false
          clearTimeout(wakeSendTimerRef.current)
          beep(520)
          const actions = actionsRef.current
          if (actions && typeof actions.submit === 'function') {
            setTimeout(() => { try { actions.submit() } catch {} }, 200)
          }
          setState({ phase: 'idle', level: 0, message: '' })
          return
        }
        // 听写时把同音误识纠正成唤醒词里的人名，其余原样
        const cleaned = String(text).replace(/小[京惊经]/g, '小鲸')
        // 只说唤醒词本身（重复喊）不往草稿里塞
        let rest = normalizeForWake(cleaned)
        for (const candidate of wakeCandidates(wakeWordCfg)) {
          if (candidate) rest = rest.split(candidate).join('')
        }
        if (!rest) return
        const actions = actionsRef.current
        if (actions && typeof actions.setDraft === 'function') {
          const current = draftRef.current || ''
          const next = current ? (current.endsWith('\n') ? current : current + '\n') + cleaned : cleaned
          draftRef.current = next
          actions.setDraft(next)
        }
        scheduleWakeSend()
      }, [scheduleWakeSend])

      const transcribeSegment = React.useCallback(async (chunks, current) => {
        if (current.busy) return
        const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
        if (total < 4800) return
        current.busy = true
        try {
          const merged = new Float32Array(total)
          let offset = 0
          for (const chunk of chunks) {
            merged.set(chunk, offset)
            offset += chunk.length
          }
          const samples = resample(merged, current.sampleRate, 16000)
          const wav = encodeWav(samples, 16000)
          const response = await fetch(TRANSCRIBE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ audioBase64: toBase64(wav) }),
          })
          const result = await response.json()
          if (result && result.ok && result.text) handleWakeText(result.text)
        } catch {
          // 网络/识别失败就等下一段
        } finally {
          current.busy = false
        }
      }, [handleWakeText])

      const stopWake = React.useCallback(() => {
        const current = wakeRef.current
        wakeRef.current = null
        wakeSessionRef.current.active = false
        clearTimeout(wakeSendTimerRef.current)
        wakeSendTimerRef.current = 0
        if (!current) return
        // 先摘监听器再停轨道：track.stop() 会触发 onended，不摘掉会自己再进一次重连
        if (current.onDeviceChange && navigator.mediaDevices) {
          try { navigator.mediaDevices.removeEventListener('devicechange', current.onDeviceChange) } catch {}
        }
        if (current.onVisibility) {
          try { document.removeEventListener('visibilitychange', current.onVisibility) } catch {}
        }
        if (current.track) {
          try { current.track.onended = null } catch {}
          try { current.track.onmute = null } catch {}
        }
        try { current.processor.disconnect() } catch {}
        try { current.source.disconnect() } catch {}
        try { current.context.close() } catch {}
        current.stream.getTracks().forEach((track) => track.stop())
      }, [])

      const startWake = React.useCallback(async () => {
        if (wakeRef.current) return
        const config = configRef.current || {}
        const audio = { channelCount: 1, echoCancellation: true, noiseSuppression: true }
        if (config.deviceId) audio.deviceId = { exact: config.deviceId }
        const stream = await navigator.mediaDevices.getUserMedia({ audio })
        let context
        try { context = new AudioContext({ sampleRate: 16000 }) } catch { context = new AudioContext() }
        const source = context.createMediaStreamSource(stream)
        const processor = context.createScriptProcessor(4096, 1, 1)
        const mute = context.createGain()
        mute.gain.value = 0
        const current = {
          stream, context, source, processor, mute,
          chunks: [], pre: [], speaking: false, lastVoice: 0, startedAt: 0,
          busy: false, sampleRate: context.sampleRate,
          track: null, onDeviceChange: null, onVisibility: null, reconnecting: false,
        }
        wakeRef.current = current

        // ---- 设备热插拔 / 流断开时自动重连 ----
        // BRIO 这类设备既是摄像头又带麦克风，一拔流就断，重插回来也不会自己接上。
        // 这里盯着三件事：轨道结束、设备增删、窗口重新可见，任一发生就重建一次。
        const reconnect = (reason) => {
          if (wakeRef.current !== current || current.reconnecting) return
          current.reconnecting = true
          try { console.log('[唤醒] 重连：' + reason) } catch {}
          stopWake()
          setTimeout(() => { startWake().catch(() => {}) }, 700)
        }

        const track = stream.getAudioTracks()[0]
        if (track) {
          current.track = track
          track.onended = () => reconnect('麦克风轨道结束')
          track.onmute = () => reconnect('麦克风被静音')
        }

        if (navigator.mediaDevices && typeof navigator.mediaDevices.addEventListener === 'function') {
          const onDeviceChange = () => reconnect('设备插拔')
          navigator.mediaDevices.addEventListener('devicechange', onDeviceChange)
          current.onDeviceChange = onDeviceChange
        }

        const onVisibility = () => {
          if (document.hidden) return
          if (wakeRef.current !== current) return
          // 窗口切回来时音频上下文常被挂起，恢复它，否则听起来还在听其实已经不采样了
          if (context.state === 'suspended') context.resume().catch(() => {})
        }
        document.addEventListener('visibilitychange', onVisibility)
        current.onVisibility = onVisibility

        processor.onaudioprocess = (event) => {
          if (wakeRef.current !== current) return
          if (recorderRef.current) return // 快捷键录音时不要重复听
          const input = event.inputBuffer.getChannelData(0)
          let sum = 0
          for (let i = 0; i < input.length; i++) sum += input[i] * input[i]
          const rms = Math.sqrt(sum / input.length)
          const now = performance.now()
          if (rms > 0.02) {
            current.lastVoice = now
            if (!current.speaking) {
              current.speaking = true
              current.startedAt = now
              current.chunks = current.pre.slice()
              current.pre = []
            }
          }
          if (current.speaking) {
            current.chunks.push(new Float32Array(input))
            if (now - current.lastVoice > 700 && now - current.startedAt > 350) {
              const chunks = current.chunks
              current.speaking = false
              current.chunks = []
              void transcribeSegment(chunks, current)
            }
          } else {
            current.pre.push(new Float32Array(input))
            while (current.pre.length > 12) current.pre.shift()
          }
        }
        source.connect(processor)
        processor.connect(mute)
        mute.connect(context.destination)
      }, [transcribeSegment, stopWake])

      React.useEffect(() => {
        if (!wakeOn) {
          stopWake()
          return
        }
        startWake().catch((error) => {
          setState({ phase: 'error', level: 0, message: '唤醒监听打不开麦克风：' + (error && error.message ? error.message : String(error)) })
          setTimeout(() => setState({ phase: 'idle', level: 0, message: '' }), 5000)
        })
        const timer = setInterval(() => {
          const session = wakeSessionRef.current
          if (session.active && Date.now() - session.lastAt > 15000) {
            session.active = false
            clearTimeout(wakeSendTimerRef.current)
            wakeSendTimerRef.current = 0
            setState({ phase: 'idle', level: 0, message: '' })
          }
        }, 2000)
        return () => {
          clearInterval(timer)
          stopWake()
        }
      }, [wakeOn, startWake, stopWake])

      if (state.phase === 'idle') return null

      const recording = state.phase === 'recording'
      const listening = state.phase === 'wake'
      const level = Math.min(1, (state.level || 0) * 6)
      const dot = listening
        ? Object.assign({}, S.micDot, { background: '#22c55e', boxShadow: '0 0 0 4px rgba(34,197,94,.25)' })
        : S.micDot
      return h('div', { style: S.pill },
        recording || listening ? h('span', { style: dot }) : h('span', { style: { fontSize: 12 } }, '…'),
        h('span', null, recording ? '正在听…' : (listening ? '已唤醒' : state.message || '识别中…')),
        recording
          ? h('span', { style: S.level }, h('span', { style: { display: 'block', height: '100%', width: Math.round(level * 100) + '%', background: '#f87171' } }))
          : null,
        h('span', { style: { fontSize: 11, opacity: 0.7 } }, recording || listening ? state.message : ''),
      )
    }

    const inject = ['slots']

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('conversation.input.overlay', () => slots.register(
        { name: 'conversation.input.overlay', id: 'voice-hotkey', order: 6, label: '语音快捷键' },
        (props) => h(VoiceHotkey, { inputActions: props.inputActions, useInput: props.useInput }),
      ))
    }

      return { apply, inject, Panel }
    })()

    return {
      inject: ['slots'],
      // 给自检脚本用：切句是纯函数，单独测比跑整个界面省事
      __splitSentences: splitSentences,
      apply(ctx) {
        const slots = ctx.get ? ctx.get('slots') : ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'mo-senses', order: 24, label: '鲸的感官' },
          () => h(Panel),
        ))
        // 会话桥：composer 那个 slot 是 session 作用域，只借它拿 sessionId
        slots.inject('conversation.input.overlay', () => slots.register(
          { name: 'conversation.input.overlay', id: 'mo-senses-voice-session', order: 7, label: '朗读会话桥' },
          (props) => {
            const sid = props && props.sessionId ? String(props.sessionId) : ''
            if (sid && sid !== pillSession) pillSession = sid
            return null
          },
        ))
        // 药丸本体放整页浮层（shell.overlay）：只有这样 fixed 才相对窗口，才能在页面里自由拖
        slots.inject('shell.overlay', () => slots.register(
          { name: 'shell.overlay', id: 'mo-senses-voice-pill', order: 7, label: '朗读小药丸' },
          () => h(VoicePill, {}),
        ))

        // 耳：语音输入的两块 UI（设置页那节 + 输入框上方的快捷键录音）
        try {
          VoiceInput.apply(ctx)
        } catch (error) {
          console.error('[dsh-whale-senses/耳] 客户端挂载失败', error)
        }
      },
    }
  },
})
