param([string]$Root=$env:EAGLE_VALIDATION_ROOT)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
if (!$Root) { throw 'Validation root required' }
$root=$Root
$tool=Join-Path $root 'tools/node_modules/exiftool-vendored.exe/bin/exiftool.exe'
if (!(Test-Path $tool)) {
 & npm install --prefix "$root/tools" --no-audit --no-fund exiftool-vendored.exe@13.59.3
 if($LASTEXITCODE -ne 0){throw 'Portable ExifTool install failed'}
}
& $tool -ver
if($LASTEXITCODE -ne 0){throw 'ExifTool validation failed'}
$configPath="$root/repo/config/local.json"
$config=@{}
if(Test-Path $configPath){
 $value=Get-Content $configPath -Encoding UTF8 -Raw | ConvertFrom-Json
 foreach($entry in $value.psobject.Properties){$config[$entry.Name]=$entry.Value}
}
$config.EAGLE_EXIFTOOL=$tool.Replace('\','/')
$json=$config | ConvertTo-Json -Depth 10
[IO.File]::WriteAllText($configPath,$json,(New-Object System.Text.UTF8Encoding($false)))
Write-Output 'Portable tool configured locally; system PATH unchanged'
