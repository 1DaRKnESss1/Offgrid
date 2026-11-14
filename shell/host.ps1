# Offgrid shell: the native part of the app (window, tray icon, global hotkey, file dialogs).
# It plays the role Electron's main window used to play, but consists only of components Windows already
# trusts: PowerShell + .NET WinForms + the WebView2 runtime that ships with Windows 11.
#
# It has no logic of its own. The Node process (src/app/main.js) starts it and drives it:
#   Node -> shell : one JSON object per line on stdin   (navigate, show, place, tray, menu, hotkey, pick, open, shot, screen, key, media, appvol, sound, desktop, type, copy, clip, quit)
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
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort vk; public ushort scan; public uint flags; public uint time; public IntPtr extra; }
    [StructLayout(LayoutKind.Explicit, Size = 40)] struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public KEYBDINPUT ki; }
    [DllImport("user32.dll")] static extern uint SendInput(uint count, INPUT[] inputs, int size);
    // Types text into whatever window has the keyboard, character by character (as Unicode, independent of the
    // keyboard layout). Control characters are dropped: this can never press Enter, Tab or a shortcut.
    public static bool TypeText(string text) {
        if (IntPtr.Size != 8 || text == null) return false;
        System.Collections.Generic.List<INPUT> list = new System.Collections.Generic.List<INPUT>();
        foreach (char ch in text) {
            if (ch < 32 || ch == 127) continue;
            INPUT down = new INPUT(); down.type = 1; down.ki.scan = ch; down.ki.flags = 4;
            INPUT up = down; up.ki.flags = 6;
            list.Add(down); list.Add(up);
        }
        if (list.Count == 0) return true;
        return SendInput((uint)list.Count, list.ToArray(), 40) == list.Count;
    }
    // Ctrl+C in the focused window: used only to read the text the user has selected
    public static void PressCopy() {
        keybd_event(0x11, 0, 0, UIntPtr.Zero); keybd_event(0x43, 0, 0, UIntPtr.Zero);
        keybd_event(0x43, 0, 2, UIntPtr.Zero); keybd_event(0x11, 0, 2, UIntPtr.Zero);
    }
    public static bool IsForeground(IntPtr hWnd) { return GetForegroundWindow() == hWnd; }
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hWnd, StringBuilder name, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string cls, string name);
    // Media and volume commands go straight to the Windows shell as WM_APPCOMMAND, not as key presses: a key
    // press lands in whatever window has the focus (our own panel swallowed it, other windows printed "?").
    // vk is the virtual key the command corresponds to (0xAD..0xB3, except "stop"); nothing else is accepted.
    public static bool TapMediaKey(int vk) {
        int cmd;
        switch (vk) {
            case 0xAD: cmd = 8; break;   // mute
            case 0xAE: cmd = 9; break;   // volume down
            case 0xAF: cmd = 10; break;  // volume up
            case 0xB0: cmd = 11; break;  // next track
            case 0xB1: cmd = 12; break;  // previous track
            case 0xB3: cmd = 14; break;  // play / pause
            default: return false;
        }
        IntPtr shell = FindWindow("Shell_TrayWnd", null);
        if (shell == IntPtr.Zero) return false;
        SendMessage(shell, 0x0319, shell, (IntPtr)(cmd << 16));
        return true;
    }
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

// The Windows volume mixer: every program that makes sound has its own volume. Only volume and mute are
// touched; programs are matched by process name.
public static class AppVolume {
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class DeviceEnumerator { }
    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator {
        [PreserveSig] int EnumAudioEndpoints(int flow, int mask, out IntPtr devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice device);
    }
    [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice { [PreserveSig] int Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o); }
    [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionManager2 {
        [PreserveSig] int GetAudioSessionControl(IntPtr a, int b, out IntPtr c);
        [PreserveSig] int GetSimpleAudioVolume(IntPtr a, int b, out IntPtr c);
        [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator e);
    }
    [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionEnumerator {
        [PreserveSig] int GetCount(out int n);
        [PreserveSig] int GetSession(int i, [MarshalAs(UnmanagedType.IUnknown)] out object session);
    }
    [Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionControl2 {
        [PreserveSig] int f0(); [PreserveSig] int f1(); [PreserveSig] int f2(); [PreserveSig] int f3(); [PreserveSig] int f4();
        [PreserveSig] int f5(); [PreserveSig] int f6(); [PreserveSig] int f7(); [PreserveSig] int f8(); [PreserveSig] int f9(); [PreserveSig] int f10();
        [PreserveSig] int GetProcessId(out uint pid);
    }
    [Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface ISimpleAudioVolume {
        [PreserveSig] int SetMasterVolume(float level, ref Guid ctx);
        [PreserveSig] int GetMasterVolume(out float level);
        [PreserveSig] int SetMute(bool mute, ref Guid ctx);
        [PreserveSig] int GetMute(out bool mute);
    }

    // names: fragments of process names to change (null = change nothing, just list). delta: -1..1 added to the
    // volume. Returns "changed=Name:45,Name:45;all=Name,Name" (levels in percent; "m" after a level = muted).
    public static string Apply(string[] names, float delta, bool toggleMute) {
        System.Collections.Generic.List<string> changed = new System.Collections.Generic.List<string>();
        System.Collections.Generic.List<string> all = new System.Collections.Generic.List<string>();
        IMMDeviceEnumerator en = (IMMDeviceEnumerator)(new DeviceEnumerator());
        IMMDevice device;
        if (en.GetDefaultAudioEndpoint(0, 1, out device) != 0 || device == null) return "changed=;all=";
        Guid iid = typeof(IAudioSessionManager2).GUID; object o;
        if (device.Activate(ref iid, 23, IntPtr.Zero, out o) != 0) return "changed=;all=";
        IAudioSessionEnumerator sessions;
        if (((IAudioSessionManager2)o).GetSessionEnumerator(out sessions) != 0) return "changed=;all=";
        int count; sessions.GetCount(out count);
        Guid none = Guid.Empty;
        for (int i = 0; i < count; i++) {
            object s; if (sessions.GetSession(i, out s) != 0 || s == null) continue;
            IAudioSessionControl2 ctl = s as IAudioSessionControl2; ISimpleAudioVolume vol = s as ISimpleAudioVolume;
            if (ctl == null || vol == null) continue;
            uint pid; if (ctl.GetProcessId(out pid) != 0 || pid == 0) continue;
            string name;
            try { name = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch { continue; }
            if (!all.Contains(name)) all.Add(name);
            if (names == null) continue;
            bool match = false;
            foreach (string n in names) { if (n.Length >= 2 && name.IndexOf(n, StringComparison.OrdinalIgnoreCase) >= 0) { match = true; break; } }
            if (!match) continue;
            float level; vol.GetMasterVolume(out level);
            bool muted; vol.GetMute(out muted);
            if (toggleMute) { muted = !muted; vol.SetMute(muted, ref none); }
            else {
                level = Math.Max(0f, Math.Min(1f, level + delta));
                vol.SetMasterVolume(level, ref none);
                if (delta > 0 && muted) { muted = false; vol.SetMute(false, ref none); }
            }
            string entry = name + ":" + (int)Math.Round(level * 100) + (muted ? "m" : "");
            if (!changed.Contains(entry)) changed.Add(entry);
        }
        return "changed=" + string.Join(",", changed.ToArray()) + ";all=" + string.Join(",", all.ToArray());
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
$props.AdditionalBrowserArguments = "--disable-gpu --disable-features=msSmartScreenProtection,HardwareMediaKeyHandling"
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
$hotkey2 = New-Object HotkeyWindow   # the dictation key
$hotkey2.add_Pressed({ Emit @{ t = "hotkey2" } })

# ---------- media players ----------
# Windows keeps a list of everything that plays media (Spotify, a browser tab with YouTube, a video player).
# A media key reaches only ONE of them - the "current" one. Here every player is addressed directly, so
# "pause" really pauses whatever is playing, and "play" resumes exactly what was paused.
$script:media = $null
$script:pausedByUs = @()
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $script:asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
  $script:media = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
} catch { $script:media = $null }

function Wait-Async($op, [Type]$type) {
  $task = $script:asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $until = [DateTime]::Now.AddSeconds(3)
  while (-not $task.IsCompleted -and [DateTime]::Now -lt $until) { Start-Sleep -Milliseconds 15 }
  if ($task.IsCompleted -and -not $task.IsFaulted -and -not $task.IsCanceled) { return $task.Result }
  return $null
}

# action: pause | play | toggle | next | previous | status. Returns @{ ok; players = how many were addressed; playing = names }
function Invoke-Media([string]$action) {
  if (-not $script:media) { return $null }
  $mgr = Wait-Async ($script:media::RequestAsync()) $script:media
  if (-not $mgr) { return $null }
  $all = @($mgr.GetSessions())
  $playing = @($all | Where-Object { $_.GetPlaybackInfo().PlaybackStatus.ToString() -eq "Playing" })
  $names = @($playing | ForEach-Object { [string]$_.SourceAppUserModelId })
  if ($action -eq "status") { return @{ ok = $true; players = $all.Count; playing = $names } }
  if ($action -eq "toggle") { if ($playing.Count -gt 0) { $action = "pause" } else { $action = "play" } }
  $targets = @()
  if ($action -eq "pause") {
    $targets = $playing
    if ($targets.Count -gt 0) { $script:pausedByUs = $names }
  } elseif ($action -eq "play") {
    if ($playing.Count -gt 0) { return @{ ok = $true; players = 0; playing = $names; already = $true } }
    $targets = @($all | Where-Object { $script:pausedByUs -contains [string]$_.SourceAppUserModelId })
    if ($targets.Count -eq 0) { $cur = $mgr.GetCurrentSession(); if ($cur) { $targets = @($cur) } }
  } else {
    if ($playing.Count -gt 0) { $targets = @($playing[0]) } else { $cur = $mgr.GetCurrentSession(); if ($cur) { $targets = @($cur) } }
  }
  $done = 0
  foreach ($t in $targets) {
    $op = $null
    switch ($action) {
      "pause" { $op = $t.TryPauseAsync() }
      "play" { $op = $t.TryPlayAsync() }
      "next" { $op = $t.TrySkipNextAsync() }
      "previous" { $op = $t.TrySkipPreviousAsync() }
    }
    if ($op -and (Wait-Async $op ([bool]))) { $done++ }
  }
  return @{ ok = ($done -gt 0); players = $done; playing = $names }
}

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
    "hotkey" { $hk = $hotkey; if ($cmd.slot -eq 2) { $hk = $hotkey2 }; $ok = $hk.Register([uint32]$cmd.mods, [uint32]$cmd.vk); Emit @{ t = "reply"; id = $cmd.id; ok = [bool]$ok } }
    "unhotkey" { if ($cmd.slot -eq 2) { $hotkey2.Unregister() } else { $hotkey.Unregister() }; Emit @{ t = "reply"; id = $cmd.id; ok = $true } }
    "type" {
      # never into our own window: dictation is meant for other programs
      $ok = $false
      if (-not [Native]::IsForeground($form.Handle)) { $ok = [Native]::TypeText([string]$cmd.text) }
      Emit @{ t = "reply"; id = $cmd.id; ok = [bool]$ok }
    }
    "copy" {
      # The text selected in the focused window. The clipboard is emptied first so that an old value is not
      # mistaken for the selection; if nothing was selected, the old text is put back.
      $text = ""
      if (-not [Native]::IsForeground($form.Handle)) {
        $old = ""
        try { $old = [System.Windows.Forms.Clipboard]::GetText() } catch { }
        try { [System.Windows.Forms.Clipboard]::Clear() } catch { }
        [Native]::PressCopy()
        for ($i = 0; $i -lt 15 -and -not $text; $i++) {
          Start-Sleep -Milliseconds 40
          [System.Windows.Forms.Application]::DoEvents()
          try { $text = [System.Windows.Forms.Clipboard]::GetText() } catch { }
        }
        if (-not $text -and $old) { try { [System.Windows.Forms.Clipboard]::SetText($old) } catch { } }
      }
      Emit @{ t = "reply"; id = $cmd.id; ok = $true; text = $text }
    }
    "clip" {
      $ok = $true
      try { [System.Windows.Forms.Clipboard]::SetText([string]$cmd.text) } catch { $ok = $false }
      Emit @{ t = "reply"; id = $cmd.id; ok = $ok }
    }
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
      $n = [Math]::Max(1, [Math]::Min(25, [int]$cmd.times))
      $ok = $true
      for ($i = 0; $i -lt $n; $i++) { if (-not [Native]::TapMediaKey([int]$cmd.vk)) { $ok = $false; break } }
      Emit @{ t = "reply"; id = $cmd.id; ok = $ok }
    }
    "media" {
      $r = $null
      try { $r = Invoke-Media ([string]$cmd.action) } catch { $r = $null }
      if ($null -eq $r) { Emit @{ t = "reply"; id = $cmd.id; ok = $false; unsupported = $true } }
      else { Emit @{ t = "reply"; id = $cmd.id; ok = [bool]$r.ok; players = [int]$r.players; playing = @($r.playing); already = [bool]$r.already } }
    }
    "appvol" {
      # volume of one program in the Windows mixer; names = process-name fragments, delta in percent, or mute toggle
      $names = $null
      if ($cmd.names) { $names = [string[]]@($cmd.names | ForEach-Object { [string]$_ } | Where-Object { $_ -match "^[\w .-]{2,40}$" }) }
      $out = ""
      try { $out = [AppVolume]::Apply($names, ([single]$cmd.delta) / 100, [bool]$cmd.mute) } catch { $out = "" }
      Emit @{ t = "reply"; id = $cmd.id; ok = [bool]$out; result = $out }
    }
    "sound" {
      # the timer alarm: a standard Windows sound, nothing of our own
      $ok = $true
      try {
        $wav = Join-Path $env:SystemRoot "Media\Alarm01.wav"
        if (Test-Path $wav) { $p = New-Object System.Media.SoundPlayer $wav; $p.Play() } else { [System.Media.SystemSounds]::Exclamation.Play() }
      } catch { $ok = $false }
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
  try { $hotkey.Unregister(); $hotkey2.Unregister() } catch { }
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
