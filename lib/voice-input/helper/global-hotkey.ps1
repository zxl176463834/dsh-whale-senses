# Hidden global-hotkey listener for dsh-voice-panel.
# Registers a system-wide hotkey via RegisterHotKey and POSTs to the local DSH
# plugin when it fires. Started automatically by the host; mods/vk are parsed there.
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads BOM-less scripts as
# ANSI, and non-ASCII comments can eat the following newline and break parsing.
param(
  [int]$Mods,
  [int]$Vk,
  [string]$Url
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms

$code = @'
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using System.Net;

public class DshHotkeyForm : Form
{
    const int WM_HOTKEY = 0x0312;

    [DllImport("user32.dll")]
    static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

    [DllImport("user32.dll")]
    static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    private string url;

    public DshHotkeyForm(int mods, int vk, string url)
    {
        this.url = url;
        this.ShowInTaskbar = false;
        this.FormBorderStyle = FormBorderStyle.None;
        this.StartPosition = FormStartPosition.Manual;
        this.Location = new System.Drawing.Point(-4000, -4000);
        this.Size = new System.Drawing.Size(1, 1);
        this.Opacity = 0;
        this.Show();

        if (!RegisterHotKey(this.Handle, 1, (uint)mods, (uint)vk))
        {
            Console.Error.WriteLine("register-failed");
            Environment.Exit(3);
        }
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WM_HOTKEY)
        {
            try
            {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(this.url);
                request.Method = "POST";
                request.ContentLength = 0;
                request.Timeout = 2000;
                request.Proxy = null;
                using (WebResponse response = request.GetResponse()) { }
            }
            catch
            {
                // Host not running: fail silently, next press retries.
            }
        }
        base.WndProc(ref m);
    }

    public static void Run(int mods, int vk, string url)
    {
        Application.Run(new DshHotkeyForm(mods, vk, url));
    }
}
'@

Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition $code

[DshHotkeyForm]::Run($Mods, $Vk, $Url)
