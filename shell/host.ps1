# Offgrid shell: the native part of the app (window, tray icon, global hotkey, file dialogs).
# It plays the role Electron's main window used to play, but consists only of components Windows already
# trusts: PowerShell + .NET WinForms + the WebView2 runtime that ships with Windows 11.
#
# It has no logic of its own. The Node process (src/app/main.js) starts it and drives it:
#   Node -> shell : one JSON object per line on stdin   (navigate, show, place, tray, menu, hotkey, pick, open, shot, screen, key, desktop, quit)
# The panel address (with its one-time key) arrives through stdin, never on the command line, so that other
# programs cannot read it from the process list.
#   shell -> Node : one JSON object per line on stdout  (ready, hotkey, tray-click, menu, blur, focus, moved, ...)
#
# The window is the "island": a transparent, always-on-top window in which only the shape drawn by the page is
# visible. The page tells the shell which box that shape occupies; the rest of the window is cut away, so
# clicks beside the island reach whatever lies underneath.
# When stdin closes (the Node process is gone) the shell exits by itself.
#
# This file is ASCII-only on purpose: all user-visible text arrives from Node as UTF-8 JSON.
param(
  [Parameter(Mandatory)][string]$DataDir,
  [int]$Width = 500,
  [int]$Height = 700
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
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
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
    [DllImport("user32.dll")] static extern bool ReleaseCapture();
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    // Presses and releases one of the media / volume keys (0xAD..0xB3); nothing else can be typed this way
    public static bool TapMediaKey(int vk) {
        if (vk < 0xAD || vk > 0xB3) return false;
        keybd_event((byte)vk, 0, 0, UIntPtr.Zero); keybd_event((byte)vk, 0, 2, UIntPtr.Zero);
        return true;
    }
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hWnd, StringBuilder name, int max);
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [StructLayout(LayoutKind.Sequential)] struct BlurBehind { public int flags; public bool enable; public IntPtr region; public bool transition; }
    [DllImport("dwmapi.dll")] static extern int DwmEnableBlurBehindWindow(IntPtr hWnd, ref BlurBehind bb);
    [DllImport("gdi32.dll")] static extern IntPtr CreateRectRgn(int l, int t, int r, int b);

    // Per-pixel transparency: with an empty blur region DWM honours the alpha channel, so the black window
    // background disappears and only what the page draws stays visible.
    public static int MakeTransparent(IntPtr hWnd) {
        BlurBehind bb = new BlurBehind(); bb.flags = 3; bb.enable = true; bb.region = CreateRectRgn(0, 0, -1, -1);
        return DwmEnableBlurBehindWindow(hWnd, ref bb);
    }
    // Hands the pressed mouse button over to Windows as if a title bar had been grabbed; returns when the drag ends
    public static void Drag(IntPtr hWnd) { ReleaseCapture(); SendMessage(hWnd, 0xA1, (IntPtr)2, IntPtr.Zero); }
    // True while another program covers a whole screen (a game, a video): the island steps aside then
    public static bool ForegroundIsFullscreen(IntPtr own) {
        IntPtr h = GetForegroundWindow();
        if (h == IntPtr.Zero || h == own) return false;
        StringBuilder sb = new StringBuilder(80); GetClassName(h, sb, 80); string c = sb.ToString();
        if (c == "Progman" || c == "WorkerW" || c == "Shell_TrayWnd" || c == "XamlExplorerHostIslandWindow") return false;
        RECT r; if (!GetWindowRect(h, out r)) return false;
        Rectangle b = Screen.FromHandle(h).Bounds;
        return r.L <= b.Left && r.T <= b.Top && r.R >= b.Right && r.B >= b.Bottom;
    }
}

// A borderless window that never appears in Alt+Tab or on the taskbar
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
$form.MaximizeBox = $false
$form.StartPosition = "Manual"
$form.Size = New-Object System.Drawing.Size($Width, $Height)
$form.BackColor = [System.Drawing.Color]::Black   # black + MakeTransparent = see-through

# Puts the window at a remembered place; if that place is no longer on any screen (a monitor was unplugged),
# or none is given, the island goes to the top centre of the main screen.
function Place-Window($x, $y) {
  if ($null -ne $x -and $null -ne $y) {
    $grip = New-Object System.Drawing.Point(([int]$x + [int]($form.Width / 2)), ([int]$y + 26))   # where the pill is
    foreach ($scr in [System.Windows.Forms.Screen]::AllScreens) {
      if ($scr.Bounds.Contains($grip)) { $form.Location = New-Object System.Drawing.Point([int]$x, [int]$y); return }
    }
  }
  $area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $form.Location = New-Object System.Drawing.Point(($area.Left + [int](($area.Width - $form.Width) / 2)), $area.Top)
}

function Set-Shape($m) {
  $k = $form.DeviceDpi / 96.0
  $x = [int]($m.x * $k); $y = [int]($m.y * $k); $w = [int]($m.w * $k); $h = [int]($m.h * $k)
  if ($w -lt 8 -or $h -lt 8) { return }
  $d = [int][Math]::Max(2, [Math]::Min($m.r * 2 * $k, [Math]::Min($w, $h)))
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc($x, $y, $d, $d, 180, 90); $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90); $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  $old = $form.Region
  $form.Region = New-Object System.Drawing.Region($path)
  $path.Dispose()
  if ($old) { $old.Dispose() }
}

$wv = New-Object Microsoft.Web.WebView2.WinForms.WebView2
$wv.Dock = "Fill"
$wv.DefaultBackgroundColor = [System.Drawing.Color]::Transparent
$props = New-Object Microsoft.Web.WebView2.WinForms.CoreWebView2CreationProperties
$props.UserDataFolder = $DataDir
# The video card's memory belongs to the language model: the island is drawn on the CPU (and still runs at full frame rate)
$props.AdditionalBrowserArguments = "--disable-gpu --disable-features=msSmartScreenProtection"
$wv.CreationProperties = $props
$form.Controls.Add($wv)

$script:origin = $null   # set by the 'navigate' command
$script:pendingUrl = $null
$script:coreReady = $false

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
    $core.add_NavigationStarting({ param($s2, $e2) if (-not $script:origin -or -not $e2.Uri.StartsWith($script:origin + "/")) { $e2.Cancel = $true } })
    $core.add_NewWindowRequested({ param($s2, $e2) $e2.Handled = $true })
    $core.add_PermissionRequested({ param($s2, $e2) $e2.State = [Microsoft.Web.WebView2.Core.CoreWebView2PermissionState]::Deny })
    $core.add_DownloadStarting({ param($s2, $e2) $e2.Cancel = $true })
    # The page may ask for exactly two things: to reshape the window and to start dragging it
    $core.add_WebMessageReceived({
      param($s2, $e2)
      try {
        if (-not $script:origin -or -not $e2.Source.StartsWith($script:origin + "/")) { return }
        $m = $e2.WebMessageAsJson | ConvertFrom-Json
        if ($m.t -eq "box") { Set-Shape $m }
        elseif ($m.t -eq "drag") {
          [Native]::Drag($form.Handle)
          Emit @{ t = "moved"; x = $form.Location.X; y = $form.Location.Y }
        }
      } catch { Emit @{ t = "error"; error = $_.Exception.Message } }
    })
    $script:coreReady = $true
    if ($script:pendingUrl) { $core.Navigate($script:pendingUrl); $script:pendingUrl = $null }
  } catch { Emit @{ t = "fatal"; error = $_.Exception.Message } }
})
$script:loaded = $false
$wv.add_NavigationCompleted({
  param($s, $e)
  if (-not $script:loaded) {
    $script:loaded = $true
    Emit @{ t = "ready"; ok = [bool]$e.IsSuccess; browser = $wv.CoreWebView2.Environment.BrowserVersionString }
    if ($e.IsSuccess) { Show-Island }
  }
})

$form.add_Activated({ Emit @{ t = "focus" } })
$form.add_Deactivate({ Emit @{ t = "blur" } })
$form.add_FormClosing({
  param($s, $e)
  if (-not $script:quitting) { $e.Cancel = $true }   # Alt+F4 does not close the island
})

# The island is always on screen (without taking focus) unless a full-screen program is in front
$script:aside = $false
function Show-Island {
  if ($script:aside) { return }
  if (-not $script:visible) { [void][Native]::ShowWindow($form.Handle, 4); $script:visible = $true; Emit @{ t = "shown" } }   # SW_SHOWNOACTIVATE
}

# Give the island the keyboard: the page has opened its panel and the user is about to type
function Focus-Island {
  $script:aside = $false
  Show-Island
  $form.Activate()
  [void][Native]::SetForegroundWindow($form.Handle)
  [void]$wv.Focus()
}

function Check-Fullscreen {
  $full = [Native]::ForegroundIsFullscreen($form.Handle)
  if ($full -and -not $script:aside) { $script:aside = $true; if ($script:visible) { $form.Hide(); $script:visible = $false; Emit @{ t = "hidden" } } }
  elseif (-not $full -and $script:aside) { $script:aside = $false; if ($script:loaded) { Show-Island } }
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
    "navigate" {
      $u = [Uri][string]$cmd.url
      if ($u.Host -ne "127.0.0.1") { throw "only the local panel address is allowed" }
      $script:origin = $u.GetLeftPart([System.UriPartial]::Authority)
      if ($script:coreReady) { $wv.CoreWebView2.Navigate($u.AbsoluteUri) } else { $script:pendingUrl = $u.AbsoluteUri }
    }
    "show"   { if ([bool]$cmd.focus) { Focus-Island } else { Show-Island } }
    "place"  { Place-Window $cmd.x $cmd.y }
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
    "screen" {
      # A picture of the screen the mouse is on, for the assistant's "look at the screen" tool. The island steps
      # aside for a moment so that it is not in the picture. Saved where Node asks; Node deletes it right away.
      $b = [System.Windows.Forms.Screen]::FromPoint([System.Windows.Forms.Cursor]::Position).Bounds
      $was = $script:visible
      if ($was) { $form.Hide(); [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 140 }
      $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
      try {
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
        $g.Dispose()
      } finally { if ($was) { [void][Native]::ShowWindow($form.Handle, 4) } }
      $max = [int]$cmd.max
      if ($max -ge 320 -and $b.Width -gt $max) {
        $h = [int]($b.Height * $max / $b.Width)
        $small = New-Object System.Drawing.Bitmap($max, $h)
        $g = [System.Drawing.Graphics]::FromImage($small)
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.DrawImage($bmp, 0, 0, $max, $h)
        $g.Dispose(); $bmp.Dispose(); $bmp = $small
      }
      $bmp.Save([string]$cmd.path, [System.Drawing.Imaging.ImageFormat]::Png)
      Emit @{ t = "reply"; id = $cmd.id; ok = $true; w = $bmp.Width; h = $bmp.Height }
      $bmp.Dispose()
    }
    "key" {
      $n = [Math]::Max(1, [Math]::Min(10, [int]$cmd.times))
      $ok = $true
      for ($i = 0; $i -lt $n; $i++) { if (-not [Native]::TapMediaKey([int]$cmd.vk)) { $ok = $false; break } }
      Emit @{ t = "reply"; id = $cmd.id; ok = $ok }
    }
    "desktop" {
      # Minimise every window (show the desktop) or bring them back
      $sh = New-Object -ComObject Shell.Application
      if ([bool]$cmd.restore) { $sh.UndoMinimizeAll() } else { $sh.MinimizeAll() }
      Emit @{ t = "reply"; id = $cmd.id; ok = $true }
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
$script:beat = 0
$timer.add_Tick({
  try {
    if (++$script:beat % 25 -eq 0) { Check-Fullscreen }
    while ($script:read.IsCompleted) {
      $line = $script:read.Result
      if ($null -eq $line) { Stop-Shell; return }      # Node is gone
      $script:read = $stdin.ReadLineAsync()
      if ($line.Trim()) {
        try { Invoke-Command-Line $line } catch {
          # a failed command still gets its reply, otherwise Node would wait for it forever (e.g. a file dialog)
          $failedId = $null
          try { $failedId = ($line | ConvertFrom-Json).id } catch { }
          if ($null -ne $failedId) { Emit @{ t = "reply"; id = $failedId; ok = $false; error = $_.Exception.Message } } else { Emit @{ t = "error"; error = $_.Exception.Message } }
        }
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

# The window handle must exist before WebView2 can attach to it; the island appears once its page has loaded
[void]$form.Handle
[void][Native]::MakeTransparent($form.Handle)
Place-Window $null $null
[void]$wv.EnsureCoreWebView2Async($null)
$timer.Start()
[System.Windows.Forms.Application]::Run()
