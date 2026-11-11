/**
 * 全局快捷键：Electron 宿主进程里没有 globalShortcut 可用（host 跑在 node 模式），
 * 所以借一个隐藏的 PowerShell + WinForms 程序调 RegisterHotKey，按键时 POST 回本机。
 *
 * 注意：RegisterHotKey 只有「按下」没有「松开」，所以全局键是切换式
 * （按一下开始录、再按一下结束），不是按住说话。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'helper', 'global-hotkey.ps1')

const MOD_ALT = 0x0001
const MOD_CONTROL = 0x0002
const MOD_SHIFT = 0x0004
const MOD_WIN = 0x0008

const MODIFIER_TOKENS = {
  alt: MOD_ALT,
  ctrl: MOD_CONTROL,
  control: MOD_CONTROL,
  shift: MOD_SHIFT,
  win: MOD_WIN,
  meta: MOD_WIN,
  super: MOD_WIN,
}

const VK_NAMES = {
  space: 0x20,
  enter: 0x0d,
  tab: 0x09,
  escape: 0x1b,
  esc: 0x1b,
  backspace: 0x08,
  delete: 0x2e,
  insert: 0x2d,
  home: 0x24,
  end: 0x23,
  pageup: 0x21,
  pagedown: 0x22,
  arrowup: 0x26,
  arrowdown: 0x28,
  arrowleft: 0x25,
  arrowright: 0x27,
}

/**
 * 把 "Alt+Q" / "Ctrl+Shift+Space" / "F9" 解析成 RegisterHotKey 需要的 mods + vk。
 * @returns {{mods:number, vk:number, text:string} | null}
 */
export function parseAccelerator(text) {
  const parts = String(text || '').split('+').map((part) => part.trim()).filter(Boolean)
  if (parts.length === 0) return null
  let mods = 0
  let vk = 0
  const names = []
  for (const part of parts) {
    const low = part.toLowerCase()
    if (MODIFIER_TOKENS[low] !== undefined) {
      mods |= MODIFIER_TOKENS[low]
      names.push(low === 'control' ? 'Ctrl' : low.charAt(0).toUpperCase() + low.slice(1))
      continue
    }
    if (/^f([1-9]|1[0-2])$/.test(low)) {
      vk = 0x70 + Number(low.slice(1)) - 1
      names.push(low.toUpperCase())
    } else if (/^[a-z]$/.test(low)) {
      vk = low.toUpperCase().charCodeAt(0)
      names.push(low.toUpperCase())
    } else if (/^[0-9]$/.test(low)) {
      vk = low.charCodeAt(0)
      names.push(low)
    } else if (VK_NAMES[low] !== undefined) {
      vk = VK_NAMES[low]
      names.push(low.charAt(0).toUpperCase() + low.slice(1))
    } else {
      return null
    }
  }
  if (!vk) return null
  // 全局键必须有修饰键，或者本身就是功能键，避免把 A 这种键系统级吞掉
  if (mods === 0 && !/^F\d{1,2}$/i.test(names[names.length - 1])) return null
  return { mods, vk, text: names.join('+') }
}

/** 管理那个隐藏的 PowerShell 热键进程；配置变了就换掉。 */
export class GlobalHotkeyHost {
  constructor(url) {
    this.url = url
    this.child = null
    this.current = ''
  }

  /** 按配置按需启动/停止；返回实际生效的加速键文本（空串=未启用）。 */
  apply(config) {
    const wanted = config && config.globalEnabled && config.globalHotkey ? String(config.globalHotkey) : ''
    if (wanted === this.current && (this.child || !wanted)) return this.current
    this.stop()
    if (!wanted) return ''
    const parsed = parseAccelerator(wanted)
    if (!parsed) {
      console.warn('[dsh-whale-senses/耳] 全局快捷键无法解析：' + wanted)
      return ''
    }
    if (!existsSync(SCRIPT)) {
      console.warn('[dsh-whale-senses/耳] 找不到 helper 脚本：' + SCRIPT)
      return ''
    }
    try {
      const systemRoot = process.env.SystemRoot || 'C:\\Windows'
      const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      this.child = spawn(
        existsSync(powershell) ? powershell : 'powershell.exe',
        [
          '-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
          '-File', SCRIPT,
          '-Mods', String(parsed.mods),
          '-Vk', String(parsed.vk),
          '-Url', this.url,
        ],
        { windowsHide: true, stdio: 'ignore' },
      )
      this.child.on('error', (error) => {
        console.warn('[dsh-whale-senses/耳] 全局快捷键进程起不来：' + error.message)
        this.child = null
        this.current = ''
      })
      this.child.on('exit', (code) => {
        if (this.child !== null) this.current = ''
        this.child = null
        if (code && code !== 0) console.warn('[dsh-whale-senses/耳] 全局快捷键进程退出：' + code)
      })
      this.current = wanted
      console.log('[dsh-whale-senses/耳] 全局快捷键已注册：' + parsed.text)
      return wanted
    } catch (error) {
      console.warn('[dsh-whale-senses/耳] 注册全局快捷键失败：' + (error && error.message ? error.message : String(error)))
      this.child = null
      this.current = ''
      return ''
    }
  }

  stop() {
    if (this.child) {
      try { this.child.kill() } catch {}
    }
    this.child = null
    this.current = ''
  }
}
