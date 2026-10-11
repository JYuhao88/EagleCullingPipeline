param([string]$Root=$env:EAGLE_VALIDATION_ROOT)
if (!$Root) { throw 'Validation root is required' }
$ErrorActionPreference='Stop'
$env:PYTHONUTF8='1'
$env:EAGLE_PYTHON=(Resolve-Path 'python_worker/.venv/Scripts/python.exe').Path
$env:EAGLE_SCORER_PROVIDER='dml'
$env:EAGLE_DINO_PROVIDER='dml'
$env:EAGLE_POSE_PROVIDER='DmlExecutionProvider'
$env:EAGLE_VALIDATION_SERVICE='http://127.0.0.1:43135'
function Run-Step($name,$executable,$arguments) {
 $exitFile=Join-Path $Root "logs/$name.exit"
 if ((Test-Path $exitFile) -and (Get-Content $exitFile) -eq '0') { return }
 while((Invoke-RestMethod 'http://127.0.0.1:43125/runs/status').active) {
  Write-Output 'User analysis active; validation waits without touching it'
  Start-Sleep -Seconds 10
 }
 $stdout=Join-Path $Root "logs/$name.log"
 $stderr=Join-Path $Root "logs/$name.stderr"
 $p=Start-Process $executable -ArgumentList $arguments -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
 $null=$p.Handle
 $p.PriorityClass='BelowNormal'
 $sample=Join-Path $Root "logs/$name-resources.csv"
 'time,gpuUsedMiB,gpuUtilization,nodeWorkingSetMiB,treeWorkingSetMiB' | Set-Content $sample
 Add-Content -Encoding UTF8 (Join-Path $Root 'PROGRESS.md') "$(Get-Date -Format o) | $name PID=$($p.Id) | running | <validation-root>/logs/$name.log | poll exit"
 while (!$p.HasExited) {
  $gpu=nvidia-smi --query-gpu=memory.used,utilization.gpu --format=csv,noheader,nounits
  $ids=New-Object 'System.Collections.Generic.HashSet[int]'
  $ids.Add($p.Id) | Out-Null
  if($name -eq 'real-scale') {
   $serviceInfo=Invoke-RestMethod 'http://127.0.0.1:43135/validation/status'
   if($serviceInfo.pid) { $ids.Add([int]$serviceInfo.pid) | Out-Null }
  }
  $processes=Get-CimInstance Win32_Process
  do {
   $added=$false
   foreach($child in $processes) {
    if ($ids.Contains([int]$child.ParentProcessId) -and $ids.Add([int]$child.ProcessId)) { $added=$true }
   }
  } while ($added)
  $rss=0; $tree=0
  foreach($idValue in $ids) {
   $current=Get-Process -Id $idValue -ErrorAction SilentlyContinue
   if ($current) { $tree += $current.WorkingSet64; if ($idValue -eq $p.Id) { $rss=$current.WorkingSet64 } }
  }
  "$(Get-Date -Format o),$gpu,$([math]::Round($rss/1MB,2)),$([math]::Round($tree/1MB,2))" | Add-Content $sample
  Start-Sleep -Seconds 2
  $p.Refresh()
 }
 $p.WaitForExit()
 $code=$p.ExitCode
 if ($null -eq $code) { throw 'No process exit code; result must not be inferred' }
 Set-Content $exitFile $code
 Add-Content -Encoding UTF8 (Join-Path $Root 'PROGRESS.md') "$(Get-Date -Format o) | $name | $(if($code -eq 0){'done'}else{'failed'}) | <validation-root>/logs/$name.log | next step"
 if ($code -ne 0) { throw "$name failed: $code" }
}
$reservation=Join-Path $Root 'gpu-external.lock'
try {
 $gpuLock=[IO.File]::Open($reservation,'CreateNew','ReadWrite','None')
 foreach($file in Get-ChildItem 'data/windows-test/runs/*/run.json') {
  $run=Get-Content $file.FullName -Raw | ConvertFrom-Json
  if($run.status -eq 'running') { throw 'Another service analysis is running; retry after it completes' }
 }
 Run-Step 'python-scorer' $env:EAGLE_PYTHON @('scripts/windows-scorer.py')
} finally {
 if($gpuLock){ $gpuLock.Dispose(); Remove-Item $reservation }
}
Run-Step 'compare' 'node' @('--max-old-space-size=2048','scripts/windows-compare.mjs')
Run-Step 'inventory' 'node' @('--max-old-space-size=2048','scripts/windows-library.mjs',"$Root/w12-libraries.json")
Run-Step 'real-scale' 'node' @('--max-old-space-size=2048','scripts/windows-real.mjs',"$Root/w12-libraries.json",'1500')
Run-Step 'resources' 'node' @('scripts/windows-resources.mjs')
