# dsh-mo-senses / desktop.ps1
# Desktop presence probe for the emotion engine.
# Prints ONE line of JSON: how long since the last keyboard/mouse input,
# plus the current foreground window (process name + title).
# Read-only: no hooks, no key contents, no admin rights.
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class MoDeskProbe {
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int max);
  public static long IdleMs() {
    LASTINPUTINFO l = new LASTINPUTINFO();
    l.cbSize = (uint)Marshal.SizeOf(l);
    if (!GetLastInputInfo(ref l)) return -1;
    return (long)((uint)Environment.TickCount - l.dwTime);
  }
}
"@

$idle = [MoDeskProbe]::IdleMs()
$h = [MoDeskProbe]::GetForegroundWindow()
$fgPid = 0
$title = ''
$procName = ''
if ($h -ne [IntPtr]::Zero) {
  [MoDeskProbe]::GetWindowThreadProcessId($h, [ref]$fgPid) | Out-Null
  $sb = New-Object System.Text.StringBuilder 512
  [MoDeskProbe]::GetWindowText($h, $sb, 512) | Out-Null
  $title = $sb.ToString()
  if ($fgPid -gt 0) {
    $p = Get-Process -Id $fgPid -ErrorAction SilentlyContinue
    if ($p) { $procName = $p.ProcessName }
  }
}

$out = @{
  ok = $true
  idleMs = [long]$idle
  idleMin = [math]::Round([double]$idle / 60000.0, 2)
  foreground = @{
    pid = [int]$fgPid
    proc = [string]$procName
    title = [string]$title
  }
  at = [long][DateTimeOffset]::Now.ToUnixTimeMilliseconds()
}
Write-Output ($out | ConvertTo-Json -Depth 5 -Compress)
