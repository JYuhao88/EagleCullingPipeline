$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$healthUrl = "http://127.0.0.1:43125/health"

try {
  $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
  if ($health.ok) {
    Write-Output "Eagle Culling service is already running on 127.0.0.1:43125."
    exit 0
  }
} catch { }

Start-Process -FilePath "npm.cmd" -ArgumentList @("run", "serve") -WorkingDirectory $repoRoot -WindowStyle Hidden
for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
  Start-Sleep -Milliseconds 250
  try {
    $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
    if ($health.ok) {
      Write-Output "Eagle Culling service started on 127.0.0.1:43125."
      exit 0
    }
  } catch { }
}
throw "The local service did not become healthy within 8 seconds. Run npm run serve in $repoRoot to inspect the log."
