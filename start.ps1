param(
  [string] $Mode = $env:MODE
)

$ErrorActionPreference = "Stop"

if (-not $Mode) { $Mode = "wasm" }
$env:MODE = $Mode

Write-Host "Building and starting containers (MODE=$Mode)"
docker-compose up --build


