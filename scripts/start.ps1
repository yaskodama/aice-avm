# start.ps1 — one-shot launcher for aice-avm on Windows.
#
#   * If OCaml/dune is installed, it builds from source.
#   * Otherwise it downloads the prebuilt server.exe / send.exe from the
#     latest GitHub release (no toolchain needed).
#   * Then it starts the receiver, which opens the Xinu desktop UI in your
#     browser at http://localhost:PORT/ — load and run actors from there.
#
# Usage (from the repo root):
#   powershell -ExecutionPolicy Bypass -File scripts\start.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\start.ps1 -Port 8080
#   powershell -ExecutionPolicy Bypass -File scripts\start.ps1 -Port 8080 -Sample samples\Rotate4Lines.abcl

param(
  [int]$Port = 8080,
  [string]$Sample = ""
)

$ErrorActionPreference = "Stop"
$repo = "yaskodama/aice-avm"

# repo root = parent of this script's folder
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

function Get-Binaries {
  if (Get-Command dune -ErrorAction SilentlyContinue) {
    Write-Host "[start] dune found — building from source..." -ForegroundColor Cyan
    dune build
    return @("$root\_build\default\server.exe", "$root\_build\default\send.exe")
  }
  $bin = Join-Path $root "bin"
  $srv = Join-Path $bin "server.exe"
  $snd = Join-Path $bin "send.exe"
  if (-not (Test-Path $srv) -or -not (Test-Path $snd)) {
    Write-Host "[start] dune not found — downloading prebuilt binaries from the latest release..." -ForegroundColor Cyan
    New-Item -ItemType Directory -Force -Path $bin | Out-Null
    $base = "https://github.com/$repo/releases/latest/download"
    Invoke-WebRequest "$base/server.exe" -OutFile $srv
    Invoke-WebRequest "$base/send.exe"   -OutFile $snd
  }
  return @($srv, $snd)
}

$exes   = Get-Binaries
$server = $exes[0]
$send   = $exes[1]

Write-Host "[start] launching receiver on port $Port (the desktop UI opens in your browser)..." -ForegroundColor Green
$proc = Start-Process -FilePath $server -ArgumentList "$Port" -PassThru
Start-Sleep -Seconds 2

if ($Sample -ne "") {
  Write-Host "[start] sending $Sample ..." -ForegroundColor Green
  & $send "127.0.0.1:$Port" $Sample
}

Write-Host ""
Write-Host "[start] receiver PID $($proc.Id) is running — desktop UI at http://localhost:$Port/" -ForegroundColor Yellow
Write-Host "[start] load actors from the UI, or:  $send 127.0.0.1:$Port samples\Rotate4Lines.abcl"
Read-Host "[start] press Enter to stop the receiver"
Stop-Process -Id $proc.Id -ErrorAction SilentlyContinue
