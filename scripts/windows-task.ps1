param(
 [Parameter(Mandatory=$true)][string]$Root,
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-z0-9-]+$')][string]$Step,
 [Parameter(Mandatory=$true)][string]$Script,
 [switch]$Worker
)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$env:PYTHONUTF8='1'
$logs=Join-Path $Root 'logs'
New-Item -ItemType Directory -Force $logs | Out-Null
$exitFile=Join-Path $logs "$Step.exit"
$progress=Join-Path $Root 'PROGRESS.md'
if ((Test-Path $exitFile) -and (Get-Content $exitFile) -eq '0') { return }
if ($Worker) {
 try {
  $lock=[IO.File]::Open((Join-Path $logs "$Step.lock"), 'OpenOrCreate', 'ReadWrite', 'None')
 } catch { Write-Output 'Task already running'; return }
 (Get-Process -Id $pid).PriorityClass='BelowNormal'
 $env:EAGLE_VALIDATION_ROOT=$Root
 Set-Location (Join-Path $Root 'repo')
 try {
  & $Script
  if (!$?) { throw 'Task failed' }
  Set-Content $exitFile 0
  Add-Content -Encoding UTF8 $progress "$(Get-Date -Format o) | $Step | done | <validation-root>/logs/$Step.log | next step"
 } catch {
  $_ | Out-String | Write-Output
  Set-Content $exitFile 1
  Add-Content -Encoding UTF8 $progress "$(Get-Date -Format o) | $Step | failed | <validation-root>/logs/$Step.log | inspect"
 }
 $lock.Dispose()
 return
}
# CIM detaches the process from OpenSSH. Keep the arguments in a local script;
# do not use this launcher with untrusted paths containing shell metacharacters.
foreach($value in @($Root,$Script,$PSCommandPath)) {
 if ($value -match '["&|<>%]') { throw 'Unsupported shell character in task path' }
}
$log=Join-Path $logs "$Step.log"
$cmd='cmd.exe /d /s /c "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""' +
 $PSCommandPath + '"" -Root ""' + $Root + '"" -Step ' + $Step +
 ' -Script ""' + $Script + '"" -Worker > ""' + $log + '"" 2>&1"'
$result=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
 CommandLine=$cmd;CurrentDirectory=$Root
}
if ($result.ReturnValue -ne 0) { throw "CIM launch failed: $($result.ReturnValue)" }
Add-Content -Encoding UTF8 $progress "$(Get-Date -Format o) | $Step PID=$($result.ProcessId) | running | <validation-root>/logs/$Step.log | poll exit"
$result | Select-Object ProcessId,ReturnValue
