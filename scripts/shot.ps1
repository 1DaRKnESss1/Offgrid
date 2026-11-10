# Лише для розробки: запускає Offgrid, зберігає знімок панелі у вказаний файл і виходить.
#   powershell -File scripts\shot.ps1 <шлях.png> ["фраза для справжнього запиту"] [-View settings:apps]
param([Parameter(Mandatory)][string]$Out, [string]$Ask = "", [string]$View = "")
$root = Split-Path $PSScriptRoot -Parent
$env:OFFGRID_SHOT = $Out
$env:OFFGRID_SHOT_ASK = $Ask
$env:OFFGRID_SHOT_VIEW = $View  # напр. settings:apps, settings:files, log
$p = Start-Process -FilePath (Join-Path $root "node_modules\electron\dist\electron.exe") -ArgumentList "`"$root`"" -PassThru
if (-not $p.WaitForExit(150000)) {
  Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.ExecutablePath -like "$root\*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -Confirm:$false -ErrorAction SilentlyContinue }
  "TIMEOUT"
} else { "exit: $($p.ExitCode)" }
