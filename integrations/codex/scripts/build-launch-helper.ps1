param([string]$OutputPath)
$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
if(-not $OutputPath){$OutputPath=Join-Path $root 'native/bin/launch-helper.exe'}
$OutputPath=[IO.Path]::GetFullPath($OutputPath)
[IO.Directory]::CreateDirectory((Split-Path $OutputPath -Parent))|Out-Null
$compiler=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
& $compiler /nologo /target:winexe /optimize+ /reference:System.Web.Extensions.dll "/out:$OutputPath" (Join-Path $root 'native/launch-helper/Program.cs')
if($LASTEXITCODE-ne0){throw 'launch-helper-build-failed'}
