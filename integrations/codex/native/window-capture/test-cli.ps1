$ErrorActionPreference = 'Stop'
$exe = Join-Path $PSScriptRoot 'bin/win-x64/dsh-window-capture.exe'
function Check-Run($arguments, $exitCode, $reason) {
  $lines = @(& $exe @arguments)
  if ($LASTEXITCODE -ne $exitCode -or $lines.Count -ne 1) { throw 'exit code / JSON line count mismatch' }
  $json = $lines[0] | ConvertFrom-Json
  if ($reason -and $json.reason -ne $reason) { throw 'reason mismatch' }
  return $json
}
$probe = Check-Run @('--probe') 0 $null
if (!$probe.ok -or !$probe.probeOnly -or $probe.captureBackend -ne 'wgc-window') { throw 'probe contract mismatch' }
$null = Check-Run @('--hwnd','0','--path',(Join-Path $env:TEMP 'dsh-invalid-window.png')) 1 'window_closed'
$null = Check-Run @('--hwnd','abc','--path',(Join-Path $env:TEMP 'dsh-invalid-window.png')) 1 'invalid_arguments'
$null = Check-Run @('--hwnd','0','--path','relative.png') 1 'invalid_arguments'
$null = Check-Run @('--timeout-ms','0') 1 'invalid_arguments'
Write-Output 'PASS: probe and 4 rejection cases; no window capture performed.'
