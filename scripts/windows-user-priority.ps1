param([string]$Root=$env:EAGLE_VALIDATION_ROOT)
if (!$Root) { throw 'Validation root required' }
$ErrorActionPreference='Stop'
# Observe the user service only. Cancel/stop only this validation's owned work.
while (!(Test-Path "$Root/logs/validation-final.exit")) {
 try {
  $user=Invoke-RestMethod 'http://127.0.0.1:43125/runs/status' -TimeoutSec 10 -DisableKeepAlive
  if ($user.active) {
   $test=Invoke-RestMethod 'http://127.0.0.1:43135/runs/status' -TimeoutSec 10 -DisableKeepAlive
   if ($test.active -and $test.active.id -match '^run-[a-zA-Z0-9_-]+$' -and
       (Test-Path "$Root/repo/data/windows-test/runs/$($test.active.id)/run.json")) {
    $null=Invoke-RestMethod "http://127.0.0.1:43135/runs/$($test.active.id)/cancel" -Method Post -TimeoutSec 10 -DisableKeepAlive
    Add-Content -Encoding UTF8 "$Root/PROGRESS.md" "$(Get-Date -Format o) | validation yields to active user run; test run cancelled | failed | <validation-root>/logs/user-priority.log | resume test checkpoints after user idle"
   }
   if ((Test-Path "$Root/gpu-external.lock") -and !(Test-Path "$Root/logs/release-bench.exit")) {
    $entry=Get-Content "$Root/PROGRESS.md" | Select-String 'release-bench PID=(\d+)' | Select-Object -Last 1
    if ($entry) {
     $ownedId=[int]$entry.Matches[0].Groups[1].Value
     $processes=Get-CimInstance Win32_Process
     $owned=$processes | Where-Object ProcessId -eq $ownedId
     if ($owned.CommandLine -match 'scripts[/\\]bench\.mjs') {
      $ids=New-Object 'System.Collections.Generic.HashSet[int]'
      $ids.Add($ownedId) | Out-Null
      do {
       $added=$false
       foreach($child in $processes) {
        if($ids.Contains([int]$child.ParentProcessId) -and $ids.Add([int]$child.ProcessId)) { $added=$true }
       }
      } while($added)
      foreach($childId in $ids) { if($childId -ne $ownedId){Stop-Process -Id $childId -ErrorAction SilentlyContinue} }
      Stop-Process -Id $ownedId -ErrorAction SilentlyContinue
      Add-Content -Encoding UTF8 "$Root/PROGRESS.md" "$(Get-Date -Format o) | release benchmark yields to user run | failed | <validation-root>/logs/release-bench.log | retry cached benchmark when user idle"
     }
    }
   }
  }
 } catch { Write-Output 'Priority observer unavailable; inspect local services' }
 Start-Sleep -Seconds 2
}
