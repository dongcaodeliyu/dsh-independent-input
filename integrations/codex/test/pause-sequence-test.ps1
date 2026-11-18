# Compile the shipped message loops with only their Win32 transport replaced by
# an in-memory recorder. No UI input, windows, hooks, or sidecar are started.
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Web.Extensions
$source=(Get-Content -Raw -Encoding UTF8 (Join-Path $PSScriptRoot '../sidecar.ps1')).Replace("`r`n","`n")
$start=$source.IndexOf('$cs = @' + "'" + "`n")+9
$cs=$source.Substring($start,$source.IndexOf("`n'@",$start)-$start)
$post=@'
public static System.Collections.Generic.List<string> TestMessages = new System.Collections.Generic.List<string>();
public static int PauseAfter = 0;
public static bool PostMessage(IntPtr hwnd, uint message, IntPtr w, IntPtr l) {
 TestMessages.Add(message.ToString()+":"+w.ToInt64());
 if(PauseAfter>0 && TestMessages.Count==PauseAfter) Paused=true;
 return true;
}
'@
$patterns=@{
 '\[DllImport\("user32.dll"[^\n]*\)\]\s*public static extern bool PostMessage\([^;]+;'=$post
 '\[DllImport\("user32.dll"[^\n]*\)\]\s*public static extern bool ScreenToClient\([^;]+;'='public static bool ScreenToClient(IntPtr h, ref POINT p) { return true; }'
 '\[DllImport\("user32.dll"[^\n]*\)\]\s*public static extern uint MapVirtualKey\([^;]+;'='public static uint MapVirtualKey(uint code, uint type) { return 0; }'
 '\[DllImport\("user32.dll"[^\n]*\)\]\s*public static extern bool IsWindow\([^;]+;'='public static bool IsWindow(IntPtr h) { return true; }'
}
foreach($entry in $patterns.GetEnumerator()){
 if([regex]::Matches($cs,$entry.Key).Count -ne 1){throw 'interop test seam not found exactly once'}
 $cs=[regex]::Replace($cs,$entry.Key,$entry.Value)
}
Add-Type -TypeDefinition $cs -ReferencedAssemblies @([System.Web.Script.Serialization.JavaScriptSerializer].Assembly.Location,[System.Windows.Forms.Form].Assembly.Location,[System.Drawing.Point].Assembly.Location)
function Reset([int]$after){[DshInput]::Paused=$false;[DshInput]::TestMessages.Clear();[DshInput]::PauseAfter=$after}
function ExpectPause([scriptblock]$operation){try{&$operation;throw 'missing-pause'}catch{if($_.Exception.Message -notmatch 'paused-partial'){throw}}}
Reset 1;ExpectPause {[DshInput]::PostText([IntPtr]1,'abcdefghij')}
if([DshInput]::TestMessages.Count -ne 1){throw 'text continued after pause'}
Reset 2;ExpectPause {[DshInput]::PostMouseClick([IntPtr]1,10,10,$false,10)}
if(([DshInput]::TestMessages -join ',') -ne '512:0,513:1,514:0'){throw 'multi-click continued or missed same-target release'}
Reset 3;ExpectPause {[DshInput]::PostMouseDrag([IntPtr]1,10,10,200,200,20)}
if(([DshInput]::TestMessages -join ',') -ne '512:0,513:1,512:1,514:0'){throw 'drag continued or missed same-target release'}
$a=$source.IndexOf("    'key' {");$b=$source.IndexOf("    'scroll' {",$a)
Invoke-Expression ('function Invoke-TestKey($req) { switch($req.cmd) {'+$source.Substring($a,$b-$a)+'} }')
function Get-PausedResult {return $null}
function Show-InputIndicator { }
function Get-Vk([string]$name){switch($name){ctrl{17} shift{16} a{65}}}
Reset 1;ExpectPause {Invoke-TestKey ([pscustomobject]@{cmd='key';hwnd=1;keys='ctrl+shift+a'})}
if(([DshInput]::TestMessages -join ',') -ne '256:17,257:17'){throw 'key sequence continued or released unposted keys'}
Write-Output 'PASS: shipped text/multi-click/drag/key sequences stop after pause; only posted same-target buttons/keys released; no native input'
