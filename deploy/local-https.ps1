# Makes a locally trusted HTTPS certificate with mkcert and writes the settings the proxy needs.
# Run from the repository root in PowerShell:   powershell -ExecutionPolicy Bypass -File deploy\local-https.ps1
# It installs mkcert (winget) if missing, adds mkcert's local certificate authority to this computer's trust store
# (Windows asks you to confirm), creates deploy\certs\local.pem and local-key.pem for localhost, 127.0.0.1 and this
# computer's LAN addresses, and prints what to add to .env. Nothing leaves this machine; the key stays in deploy\certs
# (ignored by git).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$certs = Join-Path $PSScriptRoot 'certs'

if (-not (Get-Command mkcert -ErrorAction SilentlyContinue)) {
  Write-Host 'Installing mkcert with winget...'
  winget install --id FiloSottile.mkcert -e --accept-package-agreements --accept-source-agreements
  $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not (Get-Command mkcert -ErrorAction SilentlyContinue)) {
    $link = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\mkcert.exe'
    if (Test-Path $link) { $env:Path += ';' + (Split-Path $link) }
  }
}
if (-not (Get-Command mkcert -ErrorAction SilentlyContinue)) { throw 'mkcert is not available. Install it (winget install FiloSottile.mkcert) and run this again.' }

Write-Host 'Adding the local certificate authority to the trust store (confirm the Windows prompt)...'
mkcert -install

$lan = Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -match '^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)' -and $_.PrefixOrigin -ne 'WellKnown' } |
  ForEach-Object { $_.IPAddress }
$names = @('localhost', '127.0.0.1', '::1') + $lan

New-Item -ItemType Directory -Force -Path $certs | Out-Null
mkcert -cert-file (Join-Path $certs 'local.pem') -key-file (Join-Path $certs 'local-key.pem') @names

$addresses = (@('localhost', '127.0.0.1') + $lan | ForEach-Object { "https://$_" }) -join ', '
Write-Host ''
Write-Host 'Done. Add these lines to .env, then start the proxy:'
Write-Host "  CADDYFILE=./deploy/Caddyfile.local"
Write-Host "  LOCAL_SITE_ADDRESSES=$addresses"
Write-Host '  PROXY_HTTPS_PORT=8443'
Write-Host '  docker compose --profile tls up -d proxy'
Write-Host ''
Write-Host 'Then open https://localhost:8443/api/health. For a phone, install the root certificate it names below:'
Write-Host ("  " + (Join-Path (mkcert -CAROOT) 'rootCA.pem'))
