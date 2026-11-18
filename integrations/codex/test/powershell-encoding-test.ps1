param([string]$SourceRoot=(Split-Path $PSScriptRoot -Parent))
$ErrorActionPreference='Stop'
if($PSVersionTable.PSVersion.Major-ne5){throw 'Run this check using Windows PowerShell 5.1 powershell.exe'}
$files=Get-ChildItem -LiteralPath $SourceRoot -Recurse -File -Filter '*.ps1'
foreach($file in $files){$b=[IO.File]::ReadAllBytes($file.FullName);if($b.Length-lt3 -or $b[0]-ne239 -or $b[1]-ne187 -or $b[2]-ne191){throw ('Missing UTF8 BOM: '+$file.FullName)};$e=$null;$t=$null;[Management.Automation.Language.Parser]::ParseFile($file.FullName,[ref]$t,[ref]$e)|Out-Null;if($e.Count){throw ('PS5 ParseFile failed: '+$file.FullName+': '+($e|Out-String))}}
"PASS PS5.1 actual ParseFile+BOM: $($files.Count) staged/runtime/test PowerShell files"
