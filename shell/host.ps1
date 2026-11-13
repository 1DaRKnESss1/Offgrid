# Offgrid shell: the native part of the app (window, tray icon, global hotkey, file dialogs).
# It plays the role Electron's main window used to play, but consists only of components Windows already
# trusts: PowerShell + .NET WinForms + the WebView2 runtime that ships with Windows 11.
#
# It has no logic of its own. The Node process (src/app/main.js) starts it and drives it:
#   Node -> shell : one JSON object per line on stdin   (show, hide, tray, menu, hotkey, pick, open, shot, quit)
#   shell -> Node : one JSON object per line on stdout  (ready, hotkey, tray-click, menu, blur, focus, picked, ...)
# When stdin closes (the Node process is gone) the shell exits by itself.
#
# This file is ASCII-only on purpose: all user-visible text arrives from Node as UTF-8 JSON.
param(
  [Parameter(Mandatory)][string]$Url,
  [Parameter(Mandatory)][string]$DataDir,
  [int]$Width = 400,
  [int]$Height = 540,
  [int]$Margin = 12
)
$ErrorActionPreference = "Stop"
$libs = Join-Path $PSScriptRoot "webview2"

$utf8 = New-Object System.Text.UTF8Encoding $false
$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)
$stdout = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$stdout.AutoFlush = $true
function Emit($obj) { try { $stdout.WriteLine(($obj | ConvertTo-Json -Compress -Depth 5)) } catch { } }

try {
  Add-Type -AssemblyName System.Windows.Forms, System.Drawing
  Add-Type -Path (Join-Path $libs "Microsoft.Web.WebView2.Core.dll")
  Add-Type -Path (Join-Path $libs "Microsoft.Web.WebView2.WinForms.dll")
  [Microsoft.Web.WebView2.Core.CoreWebView2Environment]::SetLoaderDllFolderPath($libs)

  Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class HotkeyWindow : NativeWindow {
    [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr hWnd, int id, uint mods, uint vk);
    [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr hWnd, int id);
    public event EventHandler Pressed;
    public HotkeyWindow() { CreateHandle(new CreateParams()); }
    // 0x4000 = MOD_NOREPEAT: holding the keys down does not fire again
    public bool Register(uint mods, uint vk) { UnregisterHotKey(Handle, 1); return RegisterHotKey(Handle, 1, mods | 0x4000, vk); }
    public void Unregister() { UnregisterHotKey(Handle, 1); }
    protected override void WndProc(ref Message m) {
        if (m.Msg == 0x0312 && Pressed != null) Pressed(this, EventArgs.Empty);
        base.WndProc(ref m);
    }
}

public static class Native {
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr hIcon);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr hWnd, int attr, ref int value, int size);
}

// A borderless panel that never appears in Alt+Tab or on the taskbar
public class PanelForm : Form {
    protected override CreateParams CreateParams {
        get { CreateParams cp = base.CreateParams; cp.ExStyle |= 0x80; return cp; } // WS_EX_TOOLWINDOW
    }
    protected override bool ShowWithoutActivation { get { return true; } }
}
"@
} catch {
  Emit @{ t = "fatal"; error = $_.Exception.Message }
  exit 1
}

$script:quitting = $false
$script:visible = $false
$script:tasks = New-Object System.Collections.ArrayList   # pending async work: @{ task; done }

# ---------- window ----------
$form = New-Object PanelForm
$form.Text = "Offgrid"
$form.FormBorderStyle = "None"
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.StartPosition = "Manual"
$form.Size = New-Object System.Drawing.Size($Width, $Height)
$form.BackColor = [System.Drawing.Color]::FromArgb(32, 32, 32)

function Place-Panel {
  $area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $form.Location = New-Object System.Drawing.Point(($area.Right - $form.Width - $Margin), ($area.Bottom - $form.Height - $Margin))
}

$wv = New-Object Microsoft.Web.WebView2.WinForms.WebView2
$wv.Dock = "Fill"
$wv.DefaultBackgroundColor = [System.Drawing.Color]::FromArgb(32, 32, 32)
$props = New-Object Microsoft.Web.WebView2.WinForms.CoreWebView2CreationProperties
$props.UserDataFolder = $DataDir
# The video card's memory belongs to the language model: the panel is drawn on the CPU
$props.AdditionalBrowserArguments = "--disable-gpu --disable-features=msSmartScreenProtection"
$wv.CreationProperties = $props
$form.Controls.Add($wv)

$origin = ([Uri]$Url).GetLeftPart([System.UriPartial]::Authority)

$wv.add_CoreWebView2InitializationCompleted({
  param($s, $e)
  try {
    if (-not $e.IsSuccess) { Emit @{ t = "fatal"; error = $e.InitializationException.Message }; return }
    $core = $wv.CoreWebView2
    $set = $core.Settings
    $set.AreDevToolsEnabled = $false
    $set.AreDefaultContextMenusEnabled = $false
    $set.IsStatusBarEnabled = $false
    $set.IsZoomControlEnabled = $false
    $set.AreBrowserAcceleratorKeysEnabled = $false
    $set.IsPasswordAutosaveEnabled = $false
    $set.IsGeneralAutofillEnabled = $false
    # The panel shows only its own local page: no other navigation, no new windows, no permissions, no downloads
    $core.add_NavigationStarting({ param($s2, $e2) if (-not $e2.Uri.StartsWith($origin + "/")) { $e2.Cancel = $true } })
    $core.add_NewWindowRequested({ param($s2, $e2) $e2.Handled = $true })
    $core.add_PermissionRequested({ param($s2, $e2) $e2.State = [Microsoft.Web.WebView2.Core.CoreWebView2PermissionState]::Deny })
    $core.add_DownloadStarting({ param($s2, $e2) $e2.Cancel = $true })
    $core.Navigate($Url)
  } catch { Emit @{ t = "fatal"; error = $_.Exception.Message } }
})
$script:loaded = $false
$wv.add_NavigationCompleted({
  param($s, $e)
  if (-not $script:loaded) { $script:loaded = $true; Emit @{ t = "ready"; ok = [bool]$e.IsSuccess; browser = $wv.CoreWebView2.Environment.BrowserVersionString } }
})

$form.add_Activated({ Emit @{ t = "focus" } })
$form.add_Deactivate({ Emit @{ t = "blur" } })
$form.add_FormClosing({
  param($s, $e)
  if (-not $script:quitting) { $e.Cancel = $true; Hide-Panel }
})

function Show-Panel([bool]$focus) {
  Place-Panel
  if ($focus) {
    $form.Show()
    $form.Activate()
    [void][Native]::SetForegroundWindow($form.Handle)
    [void]$wv.Focus()
  } elseif (-not $script:visible) {
    [void][Native]::ShowWindow($form.Handle, 4)   # SW_SHOWNOACTIVATE: appear without stealing focus
  }
  if (-not $script:visible) { $script:visible = $true; Emit @{ t = "shown" } }
}

function Hide-Panel {
  if ($script:visible) { $form.Hide(); $script:visible = $false; Emit @{ t = "hidden" } }
}

# ---------- tray ----------
$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = [System.Drawing.SystemIcons]::Application
$tray.Text = "Offgrid"
$tray.Visible = $true
$tray.add_MouseClick({ param($s, $e) if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Emit @{ t = "tray-click" } } })
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$tray.ContextMenuStrip = $menu
$script:iconHandle = [IntPtr]::Zero

function Set-TrayIcon([string]$pngBase64) {
  $ms = New-Object System.IO.MemoryStream(, [Convert]::FromBase64String($pngBase64))
  $bmp = New-Object System.Drawing.Bitmap($ms)
  $h = $bmp.GetHicon()
  $tray.Icon = [System.Drawing.Icon]::FromHandle($h)
  if ($script:iconHandle -ne [IntPtr]::Zero) { [void][Native]::DestroyIcon($script:iconHandle) }
  $script:iconHandle = $h
  $bmp.Dispose(); $ms.Dispose()
}

function Set-Menu($items) {
  $menu.Items.Clear()
  foreach ($it in $items) {
    if ($it.separator) { [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)); continue }
    $mi = New-Object System.Windows.Forms.ToolStripMenuItem([string]$it.label)
    $mi.Tag = [string]$it.id
    if ($null -ne $it.enabled) { $mi.Enabled = [bool]$it.enabled }
    if ($null -ne $it.checked) { $mi.Checked = [bool]$it.checked }
    $mi.add_Click({ param($s, $e) Emit @{ t = "menu"; id = $s.Tag } })
    [void]$menu.Items.Add($mi)
  }
}

# ---------- global hotkey ----------
$hotkey = New-Object HotkeyWindow
$hotkey.add_Pressed({ Emit @{ t = "hotkey" } })

# ---------- commands from Node ----------
function Invoke-Command-Line([string]$line) {
  $cmd = $line | ConvertFrom-Json
  switch ($cmd.c) {
    "show"   { Show-Panel ([bool]$cmd.focus) }
    "hide"   { Hide-Panel }
    "tray"   { if ($cmd.icon) { Set-TrayIcon $cmd.icon }; if ($cmd.tip) { $t = [string]$cmd.tip; if ($t.Length -gt 63) { $t = $t.Substring(0, 63) }; $tray.Text = $t } }
    "menu"   { Set-Menu $cmd.items }
    "hotkey" { $ok = $hotkey.Register([uint32]$cmd.mods, [uint32]$cmd.vk); Emit @{ t = "reply"; id = $cmd.id; ok = [bool]$ok } }
    "unhotkey" { $hotkey.Unregister(); Emit @{ t = "reply"; id = $cmd.id; ok = $true } }
    "pick" {
      $path = $null
      if ($cmd.kind -eq "exe") {
        $dlg = New-Object System.Windows.Forms.OpenFileDialog
        $dlg.Title = [string]$cmd.title
        $dlg.Filter = "*.exe|*.exe"
        $dlg.CheckFileExists = $true
        if ($dlg.ShowDialog($form) -eq [System.Windows.Forms.DialogResult]::OK) { $path = $dlg.FileName }
        $dlg.Dispose()
      } else {
        $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
        $dlg.Description = [string]$cmd.title
        $dlg.ShowNewFolderButton = $false
        if ($dlg.ShowDialog($form) -eq [System.Windows.Forms.DialogResult]::OK) { $path = $dlg.SelectedPath }
        $dlg.Dispose()
      }
      Emit @{ t = "reply"; id = $cmd.id; ok = $true; path = $path }
    }
    "open" {
      # ShellExecute: opens a file, folder or URL with its default program. Node validates the target first.
      $ok = $true
      try { [void][System.Diagnostics.Process]::Start([string]$cmd.target) } catch { $ok = $false }
      Emit @{ t = "reply"; id = $cmd.id; ok = $ok }
    }
    "shot" {
      $fs = [System.IO.File]::Create([string]$cmd.path)
      $task = $wv.CoreWebView2.CapturePreviewAsync([Microsoft.Web.WebView2.Core.CoreWebView2CapturePreviewImageFormat]::Png, $fs)
      [void]$script:tasks.Add(@{ task = $task; stream = $fs; id = $cmd.id })
    }
    "quit" { Stop-Shell }
  }
}

function Stop-Shell {
  if ($script:quitting) { return }
  $script:quitting = $true
  try { $hotkey.Unregister() } catch { }
  try { $tray.Visible = $false; $tray.Dispose() } catch { }
  try { $form.Close() } catch { }
  [System.Windows.Forms.Application]::ExitThread()
}

# stdin is read asynchronously and polled from the UI thread, so the window never blocks on it
$script:read = $stdin.ReadLineAsync()
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 30
$timer.add_Tick({
  try {
    while ($script:read.IsCompleted) {
      $line = $script:read.Result
      if ($null -eq $line) { Stop-Shell; return }      # Node is gone
      $script:read = $stdin.ReadLineAsync()
      if ($line.Trim()) {
        try { Invoke-Command-Line $line } catch { Emit @{ t = "error"; error = $_.Exception.Message } }
      }
    }
    for ($i = $script:tasks.Count - 1; $i -ge 0; $i--) {
      $w = $script:tasks[$i]
      if ($w.task.IsCompleted) {
        $w.stream.Close()
        Emit @{ t = "reply"; id = $w.id; ok = (-not $w.task.IsFaulted) }
        $script:tasks.RemoveAt($i)
      }
    }
  } catch { Emit @{ t = "error"; error = $_.Exception.Message } }
})

# The window handle must exist before WebView2 can attach to it; the panel itself stays hidden until asked
[void]$form.Handle
$round = 2   # DWMWCP_ROUND: rounded corners on Windows 11
[void][Native]::DwmSetWindowAttribute($form.Handle, 33, [ref]$round, 4)
Place-Panel
[void]$wv.EnsureCoreWebView2Async($null)
$timer.Start()
[System.Windows.Forms.Application]::Run()
