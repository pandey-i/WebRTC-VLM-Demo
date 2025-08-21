param(
  [int] $Duration = 30,
  [string] $Mode = "server"
)

$ErrorActionPreference = "Stop"

Write-Host "Running bench for $Duration s in mode=$Mode"
try {
  $uri = "http://localhost:3000/bench/start?duration=$Duration&mode=$Mode"
  Invoke-RestMethod -Uri $uri -Method GET | ConvertTo-Json -Depth 6 | Write-Output
  Write-Host "metrics.json should be created at project root (output/metrics.json)."
} catch {
  Write-Host "Bench request failed:" $_.Exception.Message
  exit 1
}


