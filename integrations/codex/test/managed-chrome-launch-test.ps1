# Real COM shortcut read/write on owned temp files only; never launches Chrome.
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '../lib/managed-chrome-launch.ps1')
$root=Join-Path ([IO.Path]::GetTempPath()) ('managed-chrome-'+[Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root)|Out-Null
$chrome=Join-Path $env:ProgramFiles 'Google/Chrome/Application/chrome.exe'
if(-not[IO.File]::Exists($chrome)){throw 'Test requires installed Chrome executable metadata (no launch)'}
$shell=New-Object -ComObject WScript.Shell
function Shortcut($name,$target,$arguments){$path=Join-Path $root ($name+'.lnk');$item=$shell.CreateShortcut($path);$item.TargetPath=$target;$item.Arguments=$arguments;$item.WorkingDirectory=$root;$item.Save();return $path}
function Sha($path){$sha=[Security.Cryptography.SHA256]::Create();try{return [BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($path)))}finally{$sha.Dispose()}}
try{
 $tokens=[ManagedChromeArguments]::Parse('--user-data-dir="C:\owned fixture" --app="file:///owned.html"')
 if($tokens.Count-ne2-or$tokens[0]-cne'--user-data-dir=C:\owned fixture'){throw 'quoted parse contract'}
 $profile=Join-Path $root 'owned profile';$args='--user-data-dir="'+$profile+'" --app="file:///owned.html" --no-first-run'
 $path=Shortcut 'managed' $chrome $args;$before=Sha $path
 $prepared=Prepare-ManagedChromeLaunch $path (Join-Path $root 'copies')
 if(-not$prepared.adaptation.newFlag-or-not$prepared.temporaryPath){throw 'managed shortcut was not adapted'}
 $copy=$shell.CreateShortcut($prepared.path)
 if($copy.Arguments-cne($args+' --disable-backgrounding-occluded-windows')-or$copy.WorkingDirectory-cne$root-or$copy.TargetPath-ine$chrome){throw 'arguments/workingdir/target not preserved'}
 if((Sha $path)-cne$before){throw 'original shortcut changed'}
 if(($prepared.adaptation|ConvertTo-Json)-match'owned|file:|profilePath|arguments'){throw 'adaptation metadata exposes arguments/profile'}
 $already=Shortcut 'already' $chrome ($args+' --disable-backgrounding-occluded-windows');$r=Prepare-ManagedChromeLaunch $already
 if(-not$r.adaptation.flagRequested-or$r.temporaryPath){throw 'existing flag duplicated'}
 foreach($bad in @('--app="file:///owned.html"','--user-data-dir="relative"','--user-data-dir="unterminated','--user-data-dir="C:\one" --user-data-dir="C:\two"')){
  $p=Shortcut ('bad-'+[Guid]::NewGuid().ToString('N')) $chrome $bad;$r=Prepare-ManagedChromeLaunch $p
  if($r.path-cne$p-or$r.adaptation.eligible){throw 'unclear managed profile changed original launch'}
 }
 $p=Shortcut 'other' (Join-Path $env:WINDIR 'System32/notepad.exe') $args;$r=Prepare-ManagedChromeLaunch $p;if($r.adaptation.eligible-or$r.path-cne$p){throw 'non-Chrome changed'}
 'PASS actual COM shortcut adapter: explicit isolated Chrome profile only, exact args/workingdir preserved, original SHA unchanged, flag idempotent, unclear/no profile and non-Chrome fallback; no app launched'
}finally{
 # Every path is inside a freshly generated owned test root.
 $resolved=[IO.Path]::GetFullPath($root);$expected=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\'
 if(-not$resolved.StartsWith($expected,[StringComparison]::OrdinalIgnoreCase)){throw 'unexpected cleanup root'}
 Remove-Item -LiteralPath $root -Recurse -Force
}
