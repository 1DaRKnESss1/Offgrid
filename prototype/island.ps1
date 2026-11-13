# Prototype of the "island" window: a transparent always-on-top window whose only visible part is the pill
# drawn by the page. It answers one question: can WebView2 in a plain WinForms window give us a free-form,
# smoothly animated, draggable shape? Not part of the app; run it by hand:
#   powershell -NoProfile -ExecutionPolicy Bypass -File prototype\island.ps1
# Options: -Seconds N (close by itself), -Shot file.png (save what is really on screen around the window),
#          -State idle|listening|thinking|speaking|confirm|open (freeze one state), -Gpu (let the page use the GPU)
param([int]$Seconds = 0, [string]$Shot = "", [string]$State = "", [switch]$Gpu, [int]$Width = 440, [int]$Height = 330)
$ErrorActionPreference = "Stop"
$libs = Join-Path (Split-Path $PSScriptRoot -Parent) "shell\webview2"
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Path (Join-Path $libs "Microsoft.Web.WebView2.Core.dll")
Add-Type -Path (Join-Path $libs "Microsoft.Web.WebView2.WinForms.dll")
[Microsoft.Web.WebView2.Core.CoreWebView2Environment]::SetLoaderDllFolderPath($libs)
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public static class Glass {
    [StructLayout(LayoutKind.Sequential)] struct BlurBehind { public int flags; public bool enable; public IntPtr region; public bool transition; }
    [DllImport("dwmapi.dll")] static extern int DwmEnableBlurBehindWindow(IntPtr hWnd, ref BlurBehind bb);
    [DllImport("gdi32.dll")] static extern IntPtr CreateRectRgn(int l, int t, int r, int b);
    // An empty blur region makes DWM honour the window's alpha channel: black GDI pixels become see-through
    public static int Enable(IntPtr hWnd) {
        BlurBehind bb = new BlurBehind(); bb.flags = 3; bb.enable = true; bb.region = CreateRectRgn(0, 0, -1, -1);
        return DwmEnableBlurBehindWindow(hWnd, ref bb);
    }
}
public static class Mover {
    [DllImport("user32.dll")] static extern bool ReleaseCapture();
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr w, IntPtr l);
    // Hands the pressed mouse button over to Windows as if the title bar had been grabbed
    public static void Drag(IntPtr hWnd) { ReleaseCapture(); SendMessage(hWnd, 0xA1, (IntPtr)2, IntPtr.Zero); }
}
public class IslandForm : Form {
    protected override CreateParams CreateParams {
        get { CreateParams cp = base.CreateParams; cp.ExStyle |= 0x80; return cp; } // WS_EX_TOOLWINDOW
    }
    protected override bool ShowWithoutActivation { get { return true; } }
}
"@

$form = New-Object IslandForm
$form.Text = "Offgrid island"
$form.FormBorderStyle = "None"
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.MaximizeBox = $false
$form.StartPosition = "Manual"
$form.Size = New-Object System.Drawing.Size($Width, $Height)
$form.BackColor = [System.Drawing.Color]::Black
$area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$form.Location = New-Object System.Drawing.Point(($area.Left + [int](($area.Width - $Width) / 2)), $area.Top)

$wv = New-Object Microsoft.Web.WebView2.WinForms.WebView2
$wv.Dock = "Fill"
$wv.DefaultBackgroundColor = [System.Drawing.Color]::Transparent
$props = New-Object Microsoft.Web.WebView2.WinForms.CoreWebView2CreationProperties
$props.UserDataFolder = Join-Path (Split-Path $PSScriptRoot -Parent) "data\webview2-proto"
$props.AdditionalBrowserArguments = $(if ($Gpu) { "" } else { "--disable-gpu" })
$wv.CreationProperties = $props
$form.Controls.Add($wv)

$page = "file:///" + ((Join-Path $PSScriptRoot "island.html") -replace "\\", "/")
if ($State) { $page += "?s=$State" }
$wv.add_CoreWebView2InitializationCompleted({
  param($s, $e)
  if (-not $e.IsSuccess) { Write-Host "WebView2 failed: $($e.InitializationException.Message)"; [System.Windows.Forms.Application]::ExitThread(); return }
  $set = $wv.CoreWebView2.Settings
  $set.AreDefaultContextMenusEnabled = $false
  # The page reports the box its island occupies; everything outside it stops being part of the window,
  # so clicks there go to whatever is underneath.
  $wv.CoreWebView2.add_WebMessageReceived({
    param($s2, $e2)
    try {
      $m = $e2.WebMessageAsJson | ConvertFrom-Json
      if ($m.t -eq 'box') {
        $k = $form.DeviceDpi / 96.0
        $x = [int]($m.x * $k); $y = [int]($m.y * $k); $w = [int]($m.w * $k); $h = [int]($m.h * $k); $d = [int]([Math]::Min($m.r * 2 * $k, [Math]::Min($w, $h)))
        $path = New-Object System.Drawing.Drawing2D.GraphicsPath
        $path.AddArc($x, $y, $d, $d, 180, 90); $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
        $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90); $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
        $path.CloseFigure()
        $old = $form.Region
        $form.Region = New-Object System.Drawing.Region($path)
        $path.Dispose()
        if ($old) { $old.Dispose() }
      } elseif ($m.t -eq 'drag') { [Mover]::Drag($form.Handle)
      } elseif ($m.t -eq 'fps') { Write-Host "fps: $($m.v)" }
    } catch { Write-Host "message error: $($_.Exception.Message)" }
  })
  $wv.CoreWebView2.Navigate($page)
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 500
$script:ticks = 0
$timer.add_Tick({
  $script:ticks++
  if ($Shot -and $script:ticks -eq 8) {
    # a real screen capture of the window area: shows whether the background is truly see-through
    $bmp = New-Object System.Drawing.Bitmap($form.Width, $form.Height)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($form.Location, [System.Drawing.Point]::Empty, $form.Size)
    $bmp.Save($Shot, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    Write-Host "saved $Shot; window at $($form.Location)"
  }
  if ($Seconds -gt 0 -and $script:ticks -ge $Seconds * 2) { $form.Close(); [System.Windows.Forms.Application]::ExitThread() }
})
$form.add_FormClosed({ [System.Windows.Forms.Application]::ExitThread() })

[void]$form.Handle
Write-Host "glass: $([Glass]::Enable($form.Handle))"
[void]$wv.EnsureCoreWebView2Async($null)
$form.Show()
$timer.Start()
[System.Windows.Forms.Application]::Run()
