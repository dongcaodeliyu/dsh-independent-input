# Execute extracted shipped functions with thin native recorders, never a HWND.
param([string]$SourceRoot=(Join-Path $PSScriptRoot '..'))
$ErrorActionPreference='Stop'
$source=[IO.File]::ReadAllText((Join-Path $SourceRoot 'sidecar.ps1'))
$observation=[IO.File]::ReadAllText((Join-Path $SourceRoot 'lib/observation.ps1'))
function Extract-Function([string]$text,[string]$name) {
 $tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseInput($text,[ref]$tokens,[ref]$errors)
 $node=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)
 if(-not $node){throw $name};return $node.Extent.Text
}
Add-Type -TypeDefinition @'
using System;using System.Collections.Generic;
public static class DshInput {
 public static bool Paused=false,SessionActive;public static int BoundsCalls;
 public static void CheckNotPaused(){if(Paused)throw new Exception("paused");}
 public static bool IsFeedbackWindow(IntPtr h){return h.ToInt64()==777;}
 public static bool IsWindow(IntPtr h){return true;} public static IntPtr RootOf(IntPtr h){return h;}
 public static bool IsIconic(IntPtr h){return false;}public static bool IsZoomed(IntPtr h){return false;}
 public static bool SetWindowPos(IntPtr h,IntPtr z,int x,int y,int w,int height,int flags){BoundsCalls++;return false;}
}
public static class DshOverlay {
 public static string TrustedCaption;public static bool HintOk=true;public static List<string> Events=new List<string>();
 public static bool ShowIndicatorAt(int x,int y){Events.Add("hint:"+x+","+y);return HintOk;}
 public static void ShowStyledAt(int x,int y,string style){Events.Add("cursor:"+x+","+y+":"+style);}
}
'@
foreach($name in @('Commit-InputSource','Invoke-Request','Show-StateAt','Capture-TargetWindow')) {Invoke-Expression (Extract-Function $source $name)}
Invoke-Expression (Extract-Function $observation 'Show-InputIndicator')
function Get-PausedResult {if([DshInput]::Paused){return @{ok=$false;paused=$true;reason='paused'}}}
function Get-FocusPolicyBlock($req){return $null}
$script:SessionFinished=$false;$script:cursorStyle='work';$script:styleNames=@('pointer','work')
$r=Invoke-Request @{cmd='move';x=2800;y=200;trustedCaption='fixture'}
if(-not $r.ok -or ([DshOverlay]::Events -join '|') -ne 'hint:2800,200|cursor:2800,200:work'){throw 'move must prepare destination hint before cursor and preserve manual style'}
[DshOverlay]::Events.Clear();[DshOverlay]::HintOk=$false
try {Invoke-Request @{cmd='bounds';hwnd=1;x=2400;y=100;width=800;height=600};throw 'expected hint rejection'}catch{if($_.Exception.Message -notmatch 'target-screen-indicator-failed'){throw}}
if([DshInput]::BoundsCalls -ne 0){throw 'failed hint dispatched native bounds'}
if(([DshOverlay]::Events -join '|') -ne 'hint:2800,400'){throw 'bounds hint must use requested destination center'}
[DshOverlay]::Events.Clear();[DshInput]::Paused=$true
$r=Invoke-Request @{cmd='move';x=1;y=2}
if($r.reason -ne 'paused' -or [DshOverlay]::Events.Count){throw 'paused request changed hint'}
$r=Capture-TargetWindow 777 'C:\must-not-start.png'
if($r.reason -ne 'feedback-window-capture-unsupported'){throw 'feedback capture reached native helper'}
'PASS actual extracted entrypoints: move destination hint before cursor; manual style retained; validated bounds destination before dispatch; hint failure/paused dispatch zero; feedback HWND capture rejected before helper'
