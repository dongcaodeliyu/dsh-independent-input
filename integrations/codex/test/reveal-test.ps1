# Actual RevealWindow and request dispatcher; native recorder, no OS/UI/input.
$ErrorActionPreference='Stop'
$s=[IO.File]::ReadAllText((Join-Path $PSScriptRoot '../sidecar.ps1'))
$start=$s.IndexOf('    public static bool RevealWindow(');$brace=$s.IndexOf('{',$start);$depth=1;$end=$brace+1
while($depth-gt0){if($s[$end]-eq'{'){$depth++};if($s[$end]-eq'}'){$depth--};$end++}
$method=$s.Substring($start,$end-$start)
$prefix=@'
using System;
public static class DshInput {
 public static bool SessionActive,Paused,Visible=true,Iconic=false,Valid=true;public static long Root=100;public static int Calls;public static uint Flags;public static long InsertAfter;public static int[] Geometry;
 public static bool IsWindow(IntPtr h){return Valid;}public static IntPtr RootOf(IntPtr h){return new IntPtr(Root);}public static bool IsWindowVisible(IntPtr h){return Visible;}public static bool IsIconic(IntPtr h){return Iconic;}public static int[] WindowRect(IntPtr h){return new int[]{10,20,600,400};}public static IntPtr GetForegroundWindow(){return new IntPtr(999);}
 public static void CheckNotPaused(){if(Paused)throw new Exception("paused");}
 public static bool SetWindowPos(IntPtr h,IntPtr after,int x,int y,int w,int height,uint flags){Calls++;Flags=flags;InsertAfter=after.ToInt64();Geometry=new int[]{x,y,w,height};return true;}
'@
Add-Type -TypeDefinition ($prefix+$method+'}')
$t=$null;$e=$null;$ast=[Management.Automation.Language.Parser]::ParseInput($s,[ref]$t,[ref]$e)
$node=$ast.Find({param($n)$n-is[Management.Automation.Language.FunctionDefinitionAst]-and$n.Name-eq'Invoke-Request'},$true);Invoke-Expression $node.Extent.Text
function Get-PausedResult{if([DshInput]::Paused){return @{ok=$false;paused=$true;reason='paused'}};return $null}
function Get-FocusPolicyBlock{return $null};function Commit-InputSource{};function Show-InputIndicator{}
$script:SessionFinished=$false
$r=Invoke-Request @{cmd='reveal';hwnd=100}
if(-not$r.ok-or[DshInput]::Calls-ne1-or[DshInput]::InsertAfter-ne0-or[DshInput]::Flags-ne0x213-or([DshInput]::Geometry-join',')-cne'0,0,0,0'){throw 'actual reveal did not use HWND_TOP + exact noactivate/nomove/nosize/noownerzorder flags'}
if($r.foregroundBeforeSample-ne999-or$r.foregroundAfterSample-ne999-or$r.backgroundReadiness-cne'unverified'){throw 'endpoint samples incorrectly reported'}
foreach($case in @('child','hidden','minimized','invalid','paused','readonly')){
 [DshInput]::Root=100;[DshInput]::Visible=$true;[DshInput]::Iconic=$false;[DshInput]::Valid=$true;[DshInput]::Paused=$false;$env:DSH_INPUT_READONLY='0';$hwnd=100
 switch($case){'child'{$hwnd=200}'hidden'{[DshInput]::Visible=$false}'minimized'{[DshInput]::Iconic=$true}'invalid'{[DshInput]::Valid=$false}'paused'{[DshInput]::Paused=$true}'readonly'{$env:DSH_INPUT_READONLY='1'}}
 $r=Invoke-Request @{cmd='reveal';hwnd=$hwnd};if($r.ok-ne$false-or[DshInput]::Calls-ne1){throw ('reveal refusal dispatched: '+$case)}
}
$env:DSH_INPUT_READONLY=$null
'PASS actual dispatcher/RevealWindow: exact HWND_TOP flags0x213, zero geometry, no topmost/nozorder/show flags; child/hidden/minimized/invalid/paused/readonly all zero dispatch; endpoint FG samples only, fake native recorder'
