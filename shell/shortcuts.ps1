# Prints, one per line, where each given shortcut (.lnk) points. Read-only: nothing is started or changed.
# Used by src/tools/appfinder.js when the assistant proposes to add a program to the allowed list.
# ASCII-only on purpose; paths arrive as arguments and leave as UTF-8.
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Paths)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$shell = New-Object -ComObject WScript.Shell
foreach ($p in $Paths) {
  $target = ""
  try { $target = $shell.CreateShortcut($p).TargetPath } catch { }
  [Console]::Out.WriteLine($target)
}
