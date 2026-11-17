# Starts Offgrid without a console window (used by the desktop shortcut).
# The app itself refuses a second copy: if it is already running, this just brings its panel up.
# Console output goes to data\console.log so that a failed start can still be investigated.
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$data = Join-Path $root "data"
New-Item -ItemType Directory -Force $data | Out-Null
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = Join-Path $env:ProgramFiles "nodejs\node.exe" }
Start-Process -FilePath $node -WorkingDirectory $root -WindowStyle Hidden `
  -ArgumentList '--disable-warning=ExperimentalWarning', '"src\app\main.js"' `
  -RedirectStandardOutput (Join-Path $data "console.log") -RedirectStandardError (Join-Path $data "console-errors.log")
