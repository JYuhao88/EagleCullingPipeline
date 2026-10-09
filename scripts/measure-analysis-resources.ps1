param([int]$IntervalMs = 200, [int]$PerFormat = 5)
$ErrorActionPreference = 'Stop'
if ($IntervalMs -lt 50) { throw 'Sampling interval must be at least 50ms' }
if ($PerFormat -lt 1) { throw 'PerFormat must be a positive integer' }
$repoRoot = Split-Path -Parent $PSScriptRoot
$outputRoot = Join-Path ([IO.Path]::GetTempPath()) ('eagle-resource-audit-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $outputRoot | Out-Null
$nodePath = (Get-Command node).Source
$gpuCommand = Get-Command nvidia-smi -ErrorAction SilentlyContinue
function Read-Gpu {
    if (-not $gpuCommand) { return @() }
    $gpuRows = & $gpuCommand.Source '--query-gpu=index,name,memory.used,memory.total,utilization.gpu' '--format=csv,noheader,nounits' 2>$null
    if ($LASTEXITCODE -ne 0) { return @() }
    return @($gpuRows | ForEach-Object {
        $parts = $_ -split ',\s*'
        if ($parts.Count -eq 5) {
            [pscustomobject]@{index=[int]$parts[0];name=$parts[1];usedMiB=[double]$parts[2];totalMiB=[double]$parts[3];utilizationPercent=[double]$parts[4]}
        }
    })
}
$baselineGpu = @(Read-Gpu)
$stdout = Join-Path $outputRoot 'analysis.stdout.json'
$stderr = Join-Path $outputRoot 'analysis.stderr.log'
$startedAt = [DateTime]::UtcNow
# Launch only the existing read-only auditor on a random analysis service port.
# The old Eagle service and its executor are not restarted or modified.
$auditProcess = Start-Process -FilePath $nodePath -ArgumentList @('scripts/audit-real-analysis.mjs','--semantic','--adjacent','--high-quality','--per-format',"$PerFormat") -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
# Retain the actual OS handle before exit. Windows PowerShell otherwise may
# lose ExitCode for a short-lived Start-Process -PassThru process.
[void]$auditProcess.Handle
$samples = [Collections.Generic.List[object]]::new()
$seen = @{}
$monitorError = $null
try {
    do {
        $sampleStarted = [DateTime]::UtcNow
        # Venv Python launchers can have another Python child. Resolve all
        # descendants of this audit PID, never include unrelated Python apps.
        $candidates = @(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='python.exe' OR Name='pythonw.exe'")
        $descendants = @{}; $descendants[$auditProcess.Id] = $true
        do {
            $added = $false
            foreach ($candidate in $candidates) {
                if ($descendants.ContainsKey([int]$candidate.ParentProcessId) -and -not $descendants.ContainsKey([int]$candidate.ProcessId)) {
                    $descendants[[int]$candidate.ProcessId] = $true; $added = $true
                }
            }
        } while ($added)
        $processRows = @()
        foreach ($processId in $descendants.Keys) {
            $measured = Get-Process -Id $processId -ErrorAction SilentlyContinue
            if (-not $measured) { continue }
            $row = [pscustomobject]@{id=$measured.Id;name=$measured.ProcessName;startedAt=$measured.StartTime.ToUniversalTime().ToString('o');workingSetBytes=$measured.WorkingSet64;privateBytes=$measured.PrivateMemorySize64;cpuMs=$measured.TotalProcessorTime.TotalMilliseconds}
            $processRows += $row
            $key = "$($row.id):$($row.startedAt)"
            if (-not $seen.ContainsKey($key)) { $seen[$key] = [pscustomobject]@{id=$row.id;name=$row.name;startedAt=$row.startedAt;peakObservedWorkingSetBytes=0;peakObservedPrivateBytes=0;lastObservedCpuMs=0} }
            $seen[$key].peakObservedWorkingSetBytes = [Math]::Max($seen[$key].peakObservedWorkingSetBytes,$row.workingSetBytes)
            $seen[$key].peakObservedPrivateBytes = [Math]::Max($seen[$key].peakObservedPrivateBytes,$row.privateBytes)
            $seen[$key].lastObservedCpuMs = [Math]::Max($seen[$key].lastObservedCpuMs,$row.cpuMs)
        }
        $gpu = @(Read-Gpu)
        $samples.Add([pscustomobject]@{at=$sampleStarted.ToString('o');workingSetBytes=($processRows | Measure-Object workingSetBytes -Sum).Sum;privateBytes=($processRows | Measure-Object privateBytes -Sum).Sum;processes=$processRows;gpu=$gpu;samplingCostMs=([DateTime]::UtcNow-$sampleStarted).TotalMilliseconds})
        $auditProcess.Refresh()
        if (-not $auditProcess.HasExited) { Start-Sleep -Milliseconds $IntervalMs }
    } while (-not $auditProcess.HasExited)
    $auditProcess.WaitForExit()
} catch {
    # Never kill the analysis or Eagle on a monitoring failure. Still observe
    # this exact process handle to completion so a live audit is not orphaned.
    $monitorError = $_.Exception.Message
    $auditProcess.WaitForExit()
}
$endedAt = [DateTime]::UtcNow
$audit = $null
try { $audit = Get-Content -LiteralPath $stdout -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
$report = [pscustomobject]@{
    startedAt=$startedAt.ToString('o');endedAt=$endedAt.ToString('o');elapsedMs=($endedAt-$startedAt).TotalMilliseconds
    rootProcessId=$auditProcess.Id;exitCode=$auditProcess.ExitCode;monitorError=$monitorError;sampleCount=$samples.Count
    requestedIntervalMs=$IntervalMs;requestedPerFormat=$PerFormat;peakObservedTreeWorkingSetMiB=[Math]::Round((($samples | Measure-Object workingSetBytes -Maximum).Maximum / 1MB),1)
    peakObservedTreePrivateMiB=[Math]::Round((($samples | Measure-Object privateBytes -Maximum).Maximum / 1MB),1)
    processes=@($seen.Values);baselineGpu=$baselineGpu;samples=@($samples.ToArray());audit=$audit
    caveats=@('Tree working sets include shared pages and are not unique physical RAM; snapshots can miss peaks.','CPU totals are last observed values; processes may exit between samples.','GPU figures are whole-machine usage, not attributable model VRAM; existing Eagle/desktop are included.','Sampling itself adds overhead; elapsed time is not an unsampled throughput benchmark.',"This is a read-only sample of up to $($PerFormat * 4) files, not a full-library mutation or sustained-load acceptance test.")
}
$reportPath = Join-Path $outputRoot 'resources.json'
$report | ConvertTo-Json -Depth 15 | Set-Content -LiteralPath $reportPath -Encoding UTF8
[pscustomobject]@{reportPath=$reportPath;exitCode=$report.exitCode;monitorError=$monitorError;sampleCount=$samples.Count;peakObservedTreeWorkingSetMiB=$report.peakObservedTreeWorkingSetMiB;peakObservedTreePrivateMiB=$report.peakObservedTreePrivateMiB;processes=$report.processes;auditReportPath=$audit.reportPath;unchangedOriginals=$audit.unchangedOriginals;unchangedMetadata=$audit.unchangedMetadata} | ConvertTo-Json -Depth 5
if ($monitorError -or $auditProcess.ExitCode -ne 0 -or -not $audit) { exit 1 }
