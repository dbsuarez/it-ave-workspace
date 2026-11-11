<#
  Re-runs the read-only Slack package checks documented in REAGHIDRA/02-slack-package-findings.md.

  - Finds the installed Slack package (MSIX) and its app folder.
  - Runs the four scripts in this folder. Output goes to the console only; nothing from the
    Slack package is copied or written to disk.
  - Safe to run repeatedly. Requires Python 3 on PATH. Run from PowerShell (Git Bash cannot
    enter the protected WindowsApps folder).

  Usage:  powershell -ExecutionPolicy Bypass -File REAGHIDRA\scripts\rerun.ps1
#>
$ErrorActionPreference = 'Stop'
$env:PYTHONIOENCODING = 'utf-8'

$package = Get-AppxPackage *slack* | Select-Object -First 1
if (-not $package) { throw 'Slack (MSIX) is not installed on this machine.' }
$root = $package.InstallLocation
$asar = Join-Path $root 'app\resources\app.asar'
$exe = Join-Path $root 'app\Slack.exe'
foreach ($path in @($asar, $exe)) {
  if (-not (Test-Path $path)) { throw "Expected file not found: $path" }
}
"Slack package: $($package.Name) $($package.Version)"
"app.asar sha256: $((Get-FileHash $asar -Algorithm SHA256).Hash.ToLower())"
"Slack.exe sha256: $((Get-FileHash $exe -Algorithm SHA256).Hash.ToLower())"
"(Findings were recorded for 4.53.280.0; a different version may differ.)"
''

$here = $PSScriptRoot
"=== 01 asar layout and term counts ==="
python -X utf8 (Join-Path $here '01_asar_scan.py') $asar
"`n=== 02 asar short contexts (canvas / loaded addresses) ==="
python -X utf8 (Join-Path $here '02_asar_context.py') $asar
"`n=== 03 native addons and Slack.exe term counts ==="
python -X utf8 (Join-Path $here '03_native_scan.py') $root
"`n=== 04 contexts of the stray Slack.exe hits ==="
python -X utf8 (Join-Path $here '04_exe_context.py') $exe
