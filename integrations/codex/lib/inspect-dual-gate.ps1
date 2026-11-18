param([Parameter(Mandatory=$true)][string]$MetadataPath)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'process-identity.ps1')
Get-DeadDualGateObservation $MetadataPath | ConvertTo-Json -Compress
