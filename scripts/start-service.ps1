$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$healthUrl = "http://127.0.0.1:43125/health"
$expectedVersion = (Get-Content -Raw -LiteralPath (Join-Path $repoRoot "package.json") | ConvertFrom-Json).version
$requiredCapabilities = @("task-execution-v1", "thumbnail-backup-v1", "resource-gate-v1", "phash-pairwise-v2", "task-plan-upload-v1", "semantic-analysis-v1", "task-plan-staging-v1")

function Confirm-ServiceVersion {
  $serviceVersion = Invoke-RestMethod -Uri "http://127.0.0.1:43125/version" -TimeoutSec 2
  $missingCapabilities = @($requiredCapabilities | Where-Object { $_ -notin $serviceVersion.capabilities })
  if ($serviceVersion.service -ne "eagle-culling" -or $serviceVersion.apiVersion -ne 1 -or $serviceVersion.version -ne $expectedVersion -or $missingCapabilities.Count -gt 0) {
    throw "Running service $($serviceVersion.version) is incompatible with project $expectedVersion. Missing capabilities: $($missingCapabilities -join ', '). Safely finish old tasks before upgrading; no process was stopped or started."
  }
}

$health = $null
try {
  $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
} catch { }
if ($health.ok) {
  Confirm-ServiceVersion
  Write-Output "Eagle Culling service $expectedVersion is already running and compatible on 127.0.0.1:43125."
  exit 0
}
if (Get-NetTCPConnection -LocalPort 43125 -State Listen -ErrorAction SilentlyContinue) {
  throw "Port 43125 is occupied but the service is not healthy. No duplicate process was started; inspect the existing service first."
}

Start-Process -FilePath "npm.cmd" -ArgumentList @("run", "serve") -WorkingDirectory $repoRoot -WindowStyle Hidden
for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
  Start-Sleep -Milliseconds 250
  $health = $null
  try {
    $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
  } catch { }
  if ($health.ok) {
    Confirm-ServiceVersion
    Write-Output "Eagle Culling service $expectedVersion started on 127.0.0.1:43125."
    exit 0
  }
}
throw "The local service did not become healthy within 8 seconds. Run npm run serve in $repoRoot to inspect the log."
