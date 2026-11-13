# Лише для розробки: запускає Offgrid, зберігає знімок панелі у вказаний файл і виходить.
#   powershell -File scripts\shot.ps1 <шлях.png> ["фраза для справжнього запиту"] [-View settings:apps]
param([Parameter(Mandatory)][string]$Out, [string]$Ask = "", [string]$View = "")
$root = Split-Path $PSScriptRoot -Parent
$env:OFFGRID_SHOT = $Out
$env:OFFGRID_SHOT_ASK = $Ask
$env:OFFGRID_SHOT_VIEW = $View  # напр. settings:apps, settings:files, log
$p = Start-Process -FilePath "node" -ArgumentList "`"$(Join-Path $root 'srcpp\main.js')`"" -PassThru -NoNewWindow
if (-not $p.WaitForExit(240000)) {
  Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*offgrid*main.js*" -or $_.CommandLine -like "*host.ps1*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -Confirm:$false -ErrorAction SilentlyContinue }
  "TIMEOUT"
} else { "exit: $($p.ExitCode)" }
