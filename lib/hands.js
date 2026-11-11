/**
 * dsh-mo-hands — 一双真正能干活的「手」：看屏幕、点鼠标、敲键盘、找窗口。
 *
 * 为什么不用浏览器 CDP（2026-10-26 实测结论，别重复踩）：
 *   系统 Edge 156 的 CDP，Browser 级命令正常，但 page 级 target（Page/Runtime domain）
 *   无论走 /devtools/page WS、browser WS + attach（flatten 与否）、还是 --remote-debugging-pipe，
 *   全部超时无响应；而 --screenshot 命令行能正常出图。→ 放弃 CDP，改走 Windows 桌面自动化。
 *
 * 能力（全部经 pwsh 调 Win32/System.Windows.Forms）：
 *   snap    截屏（全屏 / 指定窗口标题）
 *   click / dblclick / move  鼠标
 *   type    输入文本（中文走剪贴板 + Ctrl+V，SendKeys 发不了中文）
 *   key     按键，如 {ENTER} {TAB} {ESC} ^a
 *   focus   按标题激活窗口
 *   windows 列出可见窗口（标题 + 位置 + 尺寸）
 *   uia     读某个窗口的 UI 自动化控件树（能拿到按钮名和坐标）
 *
 * 红线：只操作用户明确要求的目标；不擅自点击/关闭别人的窗口。
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readBody, sendJson } from './http.js'

export const name = 'dsh-mo-hands'
export const inject = ['tools']

const PWSH_CANDIDATES = [
  'C:/Program Files/PowerShell/7/pwsh.exe',
  'C:/Program Files/PowerShell/7-preview/pwsh.exe',
  'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
  'pwsh.exe',
  'powershell.exe',
]
let cachedPwsh = null
function findPwsh() {
  if (cachedPwsh !== null) return cachedPwsh
  for (const c of PWSH_CANDIDATES) {
    if (/^[A-Za-z]:/.test(c)) { if (existsSync(c)) { cachedPwsh = c; return c } }
    else { cachedPwsh = c; return c }  // 裸命令名交给 PATH 解析
  }
  cachedPwsh = 'powershell.exe'
  return cachedPwsh
}

const BOOT_LOG = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-whale-senses.log')
function bootLog(msg) {
  try { appendFileSync(BOOT_LOG, new Date().toISOString() + ' ' + msg + String.fromCharCode(10)) } catch {}
}
bootLog('module loaded')

const BS = String.fromCharCode(92)
function psPath(p) { return String(p).split(BS).join('/') }

function stamp() {
  const d = new Date()
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '-' + p(d.getMilliseconds(), 3)
}

function workspaceRoot(ctx, exec) {
  try { const c = readHandCfg().shotRoot; if (c) return String(c).replace(/\\+$/, '') } catch {}
  const cands = []
  const push = (v) => { if (typeof v === 'string' && v) cands.push(v.replace(/\\+$/, '')) }
  try { const pol = ctx.get('sandboxPolicy'); if (pol) push(pol.workspaceRoot) } catch {}
  try {
    if (exec) {
      push(exec.cwd)
      const a = exec.agent
      if (a) {
        push(a.cwd); push(a.workspaceRoot); push(a.workspace); push(a.workingDirectory); push(a.root)
        try { push(a.session && a.session.cwd) } catch {}
        try { push(a.config && a.config.cwd) } catch {}
      }
    }
  } catch {}
  try { push(process.env.DSH_WORKSPACE) } catch {}
  const good = cands.filter((c) => !/[\\/]\.dsh[\\/]profiles[\\/]/.test(c))
  bootLog('工作区候选: ' + JSON.stringify(cands) + ' → 用 ' + (good[0] || '(兜底)'))
  if (good[0]) return good[0]
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'hands-shots')
}

/** PowerShell 里的公共前置（P/Invoke + 辅助函数）。 */
const PS_PRELUDE = String.raw`$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing, UIAutomationClient, UIAutomationTypes
if (-not ('MoHandsWin' -as [type])) {
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class MoHandsWin {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
}
try { [MoHandsWin]::SetProcessDPIAware() | Out-Null } catch {}
$MoShotDir = '__SHOTDIR__'
New-Item -ItemType Directory -Force -Path $MoShotDir | Out-Null
function Mo-FindWindow([string]$title) {
  $ps = Get-Process | Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle -like "*$title*" } | Select-Object -First 1
  if (-not $ps) { return $null }
  return $ps.MainWindowHandle
}
function Mo-Snap([string]$path, $hwnd) {
  if ($hwnd) {
    $r = New-Object MoHandsWin+RECT
    [MoHandsWin]::GetWindowRect($hwnd, [ref]$r) | Out-Null
    $w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
    if ($w -le 0 -or $h -le 0) { return $false }
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size $w, $h))
  } else {
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
  }
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  return $true
}
function Mo-Click([int]$x, [int]$y) {
  [MoHandsWin]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 120
  [MoHandsWin]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
  [MoHandsWin]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
}
`

export const HAND_DEFAULTS = {
  enabled: true,
  snap: true,
  window: true,
  uia: true,
  mouse: true,
  keyboard: true,
  focus: true,
  launch: true,
  shotRoot: '',
}

/** 每个动作归到哪一类开关上；wait 不用开关。 */
const OP_GROUP = {
  snap: 'snap', windows: 'window', uia: 'uia',
  click: 'mouse', dblclick: 'mouse', move: 'mouse',
  type: 'keyboard', key: 'keyboard', focus: 'focus',
}
const GROUP_CN = { snap: '截屏', window: '列窗口', uia: '读控件', mouse: '鼠标', keyboard: '键盘', focus: '切窗口' }
const HAND_CFG_PATH = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-mo-hands.config.json')

export function readHandCfg() {
  let raw = {}
  try { raw = JSON.parse(readFileSync(HAND_CFG_PATH, 'utf8')) } catch {}
  const out = { ...HAND_DEFAULTS }
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled
  for (const k of ['snap', 'window', 'uia', 'mouse', 'keyboard', 'focus', 'launch']) {
    if (typeof raw[k] === 'boolean') out[k] = raw[k]
  }
  if (typeof raw.shotRoot === 'string') out.shotRoot = raw.shotRoot
  return out
}

export function writeHandCfg(patch) {
  const next = { ...readHandCfg() }
  if (patch && typeof patch.enabled === 'boolean') next.enabled = patch.enabled
  for (const k of ['snap', 'window', 'uia', 'mouse', 'keyboard', 'focus', 'launch']) {
    if (patch && typeof patch[k] === 'boolean') next[k] = patch[k]
  }
  if (patch && typeof patch.shotRoot === 'string') next.shotRoot = patch.shotRoot.trim()
  writeFileSync(HAND_CFG_PATH, JSON.stringify(next, null, 2) + String.fromCharCode(10), 'utf8')
  return next
}

/** 哪一项被关了就说哪一项；全都允许返回空串。 */
function deniedReason(cfg, actions) {
  if (!cfg.enabled) return '手在「鲸的感官 → 手」里被整体关掉了，先去打开总开关'
  for (const a of actions) {
    const group = OP_GROUP[String((a && a.op) || '')]
    if (group && cfg[group] === false) return '「' + GROUP_CN[group] + '」这项能力在设置里被关掉了'
  }
  return ''
}

export function mountHands(ctx, deps) {
  const route = deps && deps.route
  const say = (deps && deps.say) || ((m) => bootLog('[手] ' + m))
  bootLog('apply start, has tools service = ' + !!(((ctx || {}).tools) && typeof ctx.tools.register === 'function'))
  const root = workspaceRoot(ctx)
  const baseDir = join(root, 'media', 'images', 'hands')
  const tmpDir = join(baseDir, '.tmp')
  try { mkdirSync(tmpDir, { recursive: true }) } catch {}

  bootLog('registering hands')
  try {
  ctx.tools.register({
    name: 'hands',
    description:
      '一双真正能干活的「手」：截屏看画面、移动/点击鼠标、输入文字（支持中文）、按键、按标题激活窗口、列窗口、读界面控件树。'
      + ' 按 actions 顺序执行，截图返回落盘路径（配合 read_image 就能看到画面，形成「看→点→再看」的闭环）。'
      + ' 典型用法：先 windows 找窗口 → focus 激活 → snap 截图看清界面 → 按坐标 click → type 输入 → snap 复查。'
      + ' 只操作用户要求的目标，不要点广告、不要关别人的窗口。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        actions: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              op: { type: 'string', enum: ['snap', 'click', 'dblclick', 'move', 'type', 'key', 'focus', 'windows', 'uia', 'wait'] },
              name: { type: 'string', description: 'snap 的文件名后缀' },
              window: { type: 'string', description: '窗口标题关键字（snap/focus/uia 用）' },
              x: { type: 'number', description: '屏幕绝对 X' },
              y: { type: 'number', description: '屏幕绝对 Y' },
              text: { type: 'string', description: 'type 要输入的文字' },
              keys: { type: 'string', description: 'key 要发的按键，如 {ENTER} 或 ^a' },
              ms: { type: 'number', description: 'wait 毫秒' },
            },
            required: ['op'],
          },
        },
      },
      required: ['actions'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, shots: { type: 'array', items: { type: 'string' } }, results: { type: 'array' } } },
      render: (_args, value) => {
        const out = []
        if (value && value.ok === false) out.push('失败：' + (value.error || '未知原因'))
        for (const r of (value && value.results) || []) {
          if (r.op === 'snap') out.push('截图 → ' + r.file)
          else if (r.op === 'windows') out.push('窗口：' + ((r.list || []).map((w) => w.name + '「' + w.title + '」').join(' / ')))
          else if (r.op === 'uia') out.push('控件 ' + ((r.controls || []).length) + ' 个')
          else if (r.op === 'focus') out.push(r.ok ? ('已激活 ' + r.title) : ('没找到窗口 ' + r.title))
          else if (r.op === 'click' || r.op === 'dblclick' || r.op === 'move') out.push(r.op + ' 于 (' + r.x + ',' + r.y + ')')
          else if (r.op === 'type') out.push('输入 ' + r.len + ' 字（' + r.mode + '）')
          else if (r.op === 'key') out.push('按键 ' + r.keys)
          else if (r.op === 'wait') out.push('等 ' + r.ms + 'ms')
        }
        if (!out.length) out.push(JSON.stringify(value).slice(0, 500))
        return [{ type: 'text', text: out.join(String.fromCharCode(10)) }]
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const actions = Array.isArray(args && args.actions) ? args.actions : []
      if (actions.length === 0) throw new Error('actions 不能为空')
      const denied = deniedReason(readHandCfg(), actions)
      if (denied) return { ok: false, shots: [], results: [], error: denied }
      const wroot = workspaceRoot(ctx, exec)
      const runDir = join(wroot, 'media', 'images', 'hands')
      const runTmp = join(runDir, '.tmp')
      bootLog('execute: cwd=' + wroot + ' execKeys=' + (exec ? Object.keys(exec).join(',') : 'none'))
      mkdirSync(runDir, { recursive: true })
      mkdirSync(runTmp, { recursive: true })
      const id = stamp()
      const shots = []
      const lines = []
      let n = 0
      for (const a of actions) {
        const op = String(a && a.op || '')
        n++
        if (op === 'snap') {
          const fn = join(runDir, id + '-' + (a.name ? String(a.name).replace(/[^w一-龥-]+/g, '_') : 'shot-' + n) + '.png')
          shots.push(fn)
          const w = a.window ? "$w = Mo-FindWindow '" + String(a.window).replace(/'/g, "''") + "'; if ($w) { [MoHandsWin]::SetForegroundWindow($w) | Out-Null; Start-Sleep -Milliseconds 250 }" : '$w = $null'
          lines.push(w + "; $ok = Mo-Snap '" + fn.replace(/'/g, "''") + "' $w; $r += @{ op='snap'; ok=[bool]$ok; file='" + fn.replace(/'/g, "''") + "' }")
        } else if (op === 'click' || op === 'dblclick' || op === 'move') {
          const x = Math.round(Number(a.x ?? 0)), y = Math.round(Number(a.y ?? 0))
          if (op === 'move') lines.push("[MoHandsWin]::SetCursorPos(" + x + ", " + y + ") | Out-Null; $r += @{ op='move'; ok=$true; x=" + x + "; y=" + y + " }")
          else if (op === 'click') lines.push("Mo-Click " + x + " " + y + "; Start-Sleep -Milliseconds 120; $r += @{ op='click'; ok=$true; x=" + x + "; y=" + y + " }")
          else lines.push("Mo-Click " + x + " " + y + "; Start-Sleep -Milliseconds 60; Mo-Click " + x + " " + y + "; Start-Sleep -Milliseconds 120; $r += @{ op='dblclick'; ok=$true; x=" + x + "; y=" + y + " }")
        } else if (op === 'type') {
          const t = String(a.text ?? '')
          if (/[一-龥]/.test(t)) {
            const clipPath = join(runTmp, 'clip-' + id + '-' + n + '.txt'); writeFileSync(clipPath, t, 'utf8'); lines.push("Set-Clipboard -Value (Get-Content -Raw -Encoding UTF8 '" + clipPath + "'); Start-Sleep -Milliseconds 150; [System.Windows.Forms.SendKeys]::SendWait('^v'); Start-Sleep -Milliseconds 250; $r += @{ op='type'; ok=$true; mode='clipboard'; len=" + t.length + " }")
          } else {
            const esc = t.replace(/[+^%~(){}\[\]]/g, (m) => '{' + m + '}')
            lines.push("[System.Windows.Forms.SendKeys]::SendWait('" + esc.replace(/'/g, "''") + "'); Start-Sleep -Milliseconds 120; $r += @{ op='type'; ok=$true; mode='sendkeys'; len=" + t.length + " }")
          }
        } else if (op === 'key') {
          const k = String(a.keys || '{ENTER}').replace(/'/g, "''")
          lines.push("[System.Windows.Forms.SendKeys]::SendWait('" + k + "'); Start-Sleep -Milliseconds 120; $r += @{ op='key'; ok=$true; keys='" + k + "' }")
        } else if (op === 'focus') {
          const t = String(a.window || '').replace(/'/g, "''")
          lines.push("$w = Mo-FindWindow '" + t + "'; if ($w) { [MoHandsWin]::ShowWindow($w, 9) | Out-Null; [MoHandsWin]::SetForegroundWindow($w) | Out-Null; Start-Sleep -Milliseconds 250; $r += @{ op='focus'; ok=$true; title='" + t + "' } } else { $r += @{ op='focus'; ok=$false; error='找不到窗口' } }")
        } else if (op === 'windows') {
          lines.push("$ws = @(); Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { $rc = New-Object MoHandsWin+RECT; $null = [MoHandsWin]::GetWindowRect($_.MainWindowHandle, [ref]$rc); $ws += @{ pid=$_.Id; name=$_.ProcessName; title=$_.MainWindowTitle; x=[int]$rc.Left; y=[int]$rc.Top; w=[int]($rc.Right-$rc.Left); h=[int]($rc.Bottom-$rc.Top) } }; $r += @{ op='windows'; ok=$true; list=$ws }")
        } else if (op === 'uia') {
          const t = String(a.window || '').replace(/'/g, "''")
          lines.push("$rootEl = [System.Windows.Automation.AutomationElement]::RootElement; $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, '" + t + "'); $we = $rootEl.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond); if ($we) { $items = @(); $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker; $fn = $null; $fn = { param($el, $d) if ($d -gt 3 -or $items.Count -ge 60) { return }; $c = $walker.GetFirstChild($el); while ($c -and $items.Count -lt 60) { $b = $c.Current.BoundingRectangle; $items += @{ type=($c.Current.ControlType.ProgrammaticName -replace 'ControlType\.',''); name=$c.Current.Name; x=[int]$b.X; y=[int]$b.Y; w=[int]$b.Width; h=[int]$b.Height }; & $fn $c ($d+1); $c = $walker.GetNextSibling($c) } }; & $fn $we 0; $r += @{ op='uia'; ok=$true; controls=$items } } else { $r += @{ op='uia'; ok=$false; error='找不到窗口' } }")
        } else if (op === 'wait') {
          const ms = Math.max(0, Math.min(30000, Number(a.ms) || 500))
          lines.push("Start-Sleep -Milliseconds " + ms + "; $r += @{ op='wait'; ok=$true; ms=" + ms + " }")
        } else throw new Error('不支持的动作：' + op)
      }
      const outJsonPath = psPath(join(runTmp, 'out-' + id + '.json'))
      const NL = String.fromCharCode(10)
      const script = PS_PRELUDE.replace('__SHOTDIR__', psPath(runDir).replace(/'/g, "''")) + NL + '$r = @()' + NL + lines.join(NL) + NL + '@{ ok = $true; results = $r } | ConvertTo-Json -Depth 6 -Compress | Set-Content -Encoding UTF8 -Path "' + outJsonPath + '"' + NL
      const ps1 = join(runTmp, 'run-' + id + '.ps1')
      const outJson = join(runTmp, 'out-' + id + '.json')
      writeFileSync(ps1, '\uFEFF' + script, 'utf8')
      const code = await runPwsh(ps1)
      let parsed = null
      try { parsed = JSON.parse(readFileSync(outJson, 'utf8').replace(/^\uFEFF/, '')) } catch {}
      if (parsed !== null) {
        try { rmSync(ps1, { force: true }) } catch {}
        try { rmSync(outJson, { force: true }) } catch {}
      } else { bootLog('pwsh 失败，脚本保留: ' + ps1) }
      if (parsed === null) return { ok: false, shots, results: [], error: 'pwsh 没产出结果（exit ' + code + '）' }
      return { ok: true, shots, results: parsed.results || [] }
    },
  })
    bootLog('register ok')
  } catch (e) {
    bootLog('register FAIL: ' + (e && e.message))
    throw e
  }

  // ---- 设置页「手」页签用的接口 ----
  if (typeof route === 'function') {
    route('GET', '/hands/config', async (req, res) => {
      sendJson(res, 200, { ok: true, config: readHandCfg(), defaults: { ...HAND_DEFAULTS } })
    })
    route('POST', '/hands/config', async (req, res) => {
      let body = {}
      try { body = await readBody(req) } catch {}
      const next = writeHandCfg(body || {})
      say('手的开关已更新：' + JSON.stringify(next))
      sendJson(res, 200, { ok: true, config: next })
    })
    route('GET', '/hands/windows', async (req, res) => {
      try {
        const list = await listWindows(root)
        sendJson(res, 200, { ok: true, list })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error && error.message ? error.message : String(error) })
      }
    })
  }
}

/** 列当前有标题的窗口，给设置页「手」页签显示。 */
async function listWindows(root) {
  const NL = String.fromCharCode(10)
  const dir = join(root, 'media', 'images', 'hands', '.tmp')
  mkdirSync(dir, { recursive: true })
  const id = stamp()
  const ps1 = join(dir, 'win-' + id + '.ps1')
  const outJson = join(dir, 'win-' + id + '.json')
  const script = PS_PRELUDE.replace('__SHOTDIR__', psPath(dir).replace(/'/g, "''")) + NL
    + '$ws = @(); Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { $rc = New-Object MoHandsWin+RECT; $null = [MoHandsWin]::GetWindowRect($_.MainWindowHandle, [ref]$rc); $ws += @{ pid=$_.Id; name=$_.ProcessName; title=$_.MainWindowTitle; x=[int]$rc.Left; y=[int]$rc.Top; w=[int]($rc.Right-$rc.Left); h=[int]($rc.Bottom-$rc.Top) } }; @{ ok = $true; list = $ws } | ConvertTo-Json -Depth 5 -Compress | Set-Content -Encoding UTF8 -Path "' + psPath(outJson) + '"' + NL
  writeFileSync(ps1, '\uFEFF' + script, 'utf8')
  await runPwsh(ps1)
  let parsed = null
  try { parsed = JSON.parse(readFileSync(outJson, 'utf8').replace(/^\uFEFF/, '')) } catch {}
  try { rmSync(ps1, { force: true }) } catch {}
  try { rmSync(outJson, { force: true }) } catch {}
  return parsed && Array.isArray(parsed.list) ? parsed.list : []
}

function runPwsh(scriptPath) {
  return new Promise((resolve) => {
    const child = spawn(findPwsh(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], { stdio: 'ignore', windowsHide: true })
    child.on('exit', (c) => resolve(c))
    child.on('error', () => resolve(null))
    setTimeout(() => { try { child.kill() } catch {} resolve(null) }, 120000)
  })
}
