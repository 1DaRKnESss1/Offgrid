# Завантажує бібліотеки WebView2 (офіційний пакет Microsoft з nuget.org) у shell\webview2 і перевіряє їхні підписи.
# Потрібно зробити один раз:  powershell -File scripts\setup-webview2.ps1
# Сам рушій WebView2 уже є в Windows 11; ці три файли — лише «перехідник» до нього для .NET.
# Контрольна сума пакета саме цієї версії: завантажене має збігатися з нею байт у байт.
# Для іншої версії передай і -Version, і -Sha256 (суму дивись на сторінці пакета на nuget.org).
param([string]$Version = "1.0.4314.35", [string]$Sha256 = "90778deb1b77e36292828b4b5833c9255c27533f40e0ddd55891ae718944edc4")
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$target = Join-Path $root "shell\webview2"
$work = Join-Path $root "shell\.webview2-download"

if (Test-Path $work) { Remove-Item -Recurse -Force $work -Confirm:$false }
New-Item -ItemType Directory -Force $work | Out-Null
New-Item -ItemType Directory -Force $target | Out-Null

$zip = Join-Path $work "webview2.zip"
$url = "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$Version/microsoft.web.webview2.$Version.nupkg"
"Завантажую $url"
Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
"Розмір пакета: {0:N1} МБ" -f ((Get-Item $zip).Length / 1MB)
$actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
if ($actual -ne $Sha256.ToLower()) {
  Remove-Item -Recurse -Force $work -Confirm:$false
  "ПОМИЛКА: контрольна сума пакета не збігається (очікував $Sha256, отримав $actual). Нічого не встановлено."
  exit 1
}
"Контрольна сума пакета збігається"
Expand-Archive -Path $zip -DestinationPath (Join-Path $work "pkg") -Force

$files = @(
  "pkg\lib\net462\Microsoft.Web.WebView2.Core.dll",
  "pkg\lib\net462\Microsoft.Web.WebView2.WinForms.dll",
  "pkg\runtimes\win-x64\native\WebView2Loader.dll"
)
$ok = $true
foreach ($f in $files) {
  $src = Join-Path $work $f
  if (-not (Test-Path $src)) { "НЕ ЗНАЙДЕНО в пакеті: $f"; $ok = $false; continue }
  $sig = Get-AuthenticodeSignature $src
  $signer = if ($sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { "" }
  $good = $sig.Status -eq "Valid" -and $signer -like "*O=Microsoft Corporation*"
  "{0,-40} підпис: {1}{2}" -f (Split-Path $f -Leaf), $sig.Status, $(if ($good) { " (Microsoft)" } else { " — НЕ ПРИЙНЯТО: $signer" })
  # копіюємо лише файли з чинним підписом Microsoft
  if ($good) { Copy-Item $src $target -Force } else { $ok = $false }
}
Remove-Item -Recurse -Force $work -Confirm:$false
if ($ok) { "Готово: $target" } else { "ПОМИЛКА: не всі файли пройшли перевірку"; exit 1 }
