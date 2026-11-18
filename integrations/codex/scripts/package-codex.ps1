param([string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
if (-not $OutputDirectory) { $OutputDirectory = Join-Path (Split-Path $root -Parent) 'outputs' }
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$version = (Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root '.codex-plugin/plugin.json') | ConvertFrom-Json).version
$stage = Join-Path ([System.IO.Path]::GetTempPath()) ('codex-independent-input-' + [Guid]::NewGuid().ToString('N'))
$plugin = Join-Path $stage 'dsh-independent-input'
New-Item -ItemType Directory -Path $plugin -Force | Out-Null
try {
  if (-not (Test-Path -LiteralPath (Join-Path $root 'native/window-capture/bin/win-x64/dsh-window-capture.exe'))) {
    throw 'Build native/window-capture/build.cmd before packaging'
  }
  & (Join-Path $PSScriptRoot 'build-launch-helper.ps1')
  $entries = @('.codex-plugin', '.agents', '.mcp.json', 'skills', 'hooks', 'scripts', 'test', 'lib', 'index.js', 'client.js', 'sidecar.ps1', 'cordis.patch.yml', 'package.json', 'README.md', 'LICENSE', 'NOTICE', 'docs')
  foreach ($entry in $entries) {
    $sourcePath = Join-Path $root $entry
    if (Test-Path -LiteralPath $sourcePath) { Copy-Item -LiteralPath $sourcePath -Destination $plugin -Recurse }
  }
  Copy-Item -LiteralPath (Join-Path $root '../../assets') -Destination (Join-Path $plugin 'assets') -Recurse
  Copy-Item -LiteralPath (Join-Path $root '../../NOTICE') -Destination (Join-Path $plugin 'assets/NOTICE')
  $native = @(
    'native/bin/launch-helper.exe', 'native/launch-helper/Program.cs',
    'native/window-capture/build.cmd', 'native/window-capture/main.cpp',
    'native/window-capture/README.md', 'native/window-capture/test-cli.ps1',
    'native/window-capture/bin/win-x64/dsh-window-capture.exe'
  )
  foreach ($entry in $native) {
    $destination = Join-Path $plugin $entry
    New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $root $entry) -Destination $destination
  }
  $ps5 = Join-Path $env:WINDIR 'System32/WindowsPowerShell/v1.0/powershell.exe'
  & $ps5 -NoProfile -ExecutionPolicy Bypass -File (Join-Path $plugin 'test/powershell-encoding-test.ps1') -SourceRoot $plugin
  if ($LASTEXITCODE -ne 0) { throw 'Package blocked: staged PowerShell BOM/PS5 parsing failed' }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = Join-Path $OutputDirectory "dsh-independent-input-codex-$version.zip"
  if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip }
  [System.IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip)
  Copy-Item -LiteralPath (Join-Path $root 'README.md') -Destination (Join-Path $OutputDirectory 'INSTALL.zh-CN.md') -Force
  Get-FileHash -LiteralPath $zip -Algorithm SHA256 | Format-List
} finally {
  # This stage was created directly from a GUID under the verified temp root.
  $resolvedStage = [System.IO.Path]::GetFullPath($stage)
  $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
  if ($resolvedStage.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path $resolvedStage -Leaf).StartsWith('codex-independent-input-')) {
    Remove-Item -LiteralPath $resolvedStage -Recurse -Force
  }
}
