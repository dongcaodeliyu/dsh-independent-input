# Actual dispatcher and actual window guard; fake native recorder, no OS input/UI.
param([string]$Sidecar=(Join-Path $PSScriptRoot '../sidecar.ps1'))
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;using System.Collections.Generic;
public class FakeRoot {public int Runtime=1;public int[] GetRuntimeId(){return new int[]{42,Runtime};}}
public static class DshInput {
 public static bool SessionActive=false,Paused=false,ChangeOnChild=false;public static long Root=100;public static int Offset=0;public static List<long> Posts=new List<long>();
 public static void CheckNotPaused(){} public static bool IsWindow(IntPtr h){return h!=IntPtr.Zero;}
 public static IntPtr RootOf(IntPtr h){return new IntPtr(Root);} public static IntPtr ChildAt(IntPtr h,int x,int y){if(ChangeOnChild)Root=900;return new IntPtr(200);}
 public static int[] WindowRect(IntPtr h){return new int[]{Offset,0,600,400};}
 public static string WindowClass(IntPtr h){return "Chrome_RenderWidgetHostHWND";}
 public static void PostText(IntPtr h,string text){Posts.Add(h.ToInt64());}
 public static void PostKey(IntPtr h,int key,bool down,bool extended,bool sys){Posts.Add(h.ToInt64());}
}
'@
function Import-Function($path,$names){$t=$null;$e=$null;$a=[Management.Automation.Language.Parser]::ParseFile($path,[ref]$t,[ref]$e);if($e){throw $e};foreach($name in $names){$n=$a.Find({param($x)$x-is[Management.Automation.Language.FunctionDefinitionAst]-and$x.Name-eq$name},$true);. ([scriptblock]::Create($n.Extent.Text)) | Out-Null;Set-Item "function:script:$name" (Get-Item "function:$name").ScriptBlock}}
Import-Function $Sidecar @('Invoke-Request','Get-Vk')
Import-Function (Join-Path $PSScriptRoot '../lib/observation.ps1') @('Get-StaleObservationResult','Get-InputObservationStatus')
$script:RealWindowGuard=(Get-Item function:Get-InputObservationStatus).ScriptBlock
function Get-InputObservationStatus($id,$hwnd){$r=& $script:RealWindowGuard $id $hwnd;if($r.ok -and $script:ChangeAfterGuard){[DshInput]::Root=900};return $r}
function Get-PausedResult{return $null};function Get-FocusPolicyBlock{return $null};function Commit-InputSource{};function Show-InputIndicator{};function Show-StateAt{}
$script:SessionFinished=$false;$script:cursorStyle='pointer';$failures=@();$checks=0
function Fresh { $script:ChangeAfterGuard=$false;[DshInput]::Root=100;[DshInput]::Offset=0;[DshInput]::ChangeOnChild=$false;[DshInput]::Posts.Clear();$script:CurrentObservation=@{id='fresh';hwnd=100;root=(New-Object FakeRoot);rootRuntimeId='42,1';windowRect='0,0,600,400'} }
function Check($condition,$message){$script:checks++;if(-not$condition){$script:failures+=$message}}
foreach($cmd in @('type','key')){
 $req=@{cmd=$cmd;hwnd=200;text='owned-probe';keys='enter';mode='message'}
 Fresh;[DshInput]::Root=900;$r=Invoke-Request $req;Check ($r.ok-eq$false-and[DshInput]::Posts.Count-eq0) "$cmd cross-root dispatched"
 Fresh;$script:CurrentObservation=$null;$r=Invoke-Request $req;Check ($r.ok-eq$false-and$r.reason-eq'observation-required'-and[DshInput]::Posts.Count-eq0) "$cmd no observation dispatched"
 Fresh;$r=Invoke-Request $req;Check ($r.ok-eq$true-and[DshInput]::Posts.Count-gt0-and$r.target-eq100) "$cmd valid same-root refused";Check ($null-eq$script:CurrentObservation) "$cmd did not consume observation"
 Fresh;[DshInput]::Offset=1;$r=Invoke-Request $req;Check ($r.ok-eq$false-and[DshInput]::Posts.Count-eq0) "$cmd stale geometry dispatched"
 Fresh;$script:CurrentObservation.root.Runtime=2;$r=Invoke-Request $req;Check ($r.ok-eq$false-and[DshInput]::Posts.Count-eq0) "$cmd stale runtime dispatched"
 Fresh;$req.windowObservationId='fresh';$r=Invoke-Request $req;Check ($r.ok-eq$true-and[DshInput]::Posts.Count-gt0) "$cmd explicit guard refused"
 Fresh;[DshInput]::Root=900;$r=Invoke-Request $req;Check ($r.ok-eq$false-and[DshInput]::Posts.Count-eq0) "$cmd explicit cross-root dispatched"
 Fresh;$req.Remove('windowObservationId');$req.x=20;$req.y=30;[DshInput]::ChangeOnChild=$true;$r=Invoke-Request $req;Check ($r.reason-eq'keyboard-recipient-changed'-and[DshInput]::Posts.Count-eq0) "$cmd recipient changed after guard dispatched"
 Fresh;$req.Remove('x');$req.Remove('y');$script:ChangeAfterGuard=$true;$r=Invoke-Request $req;Check ($r.reason-eq'keyboard-recipient-changed'-and[DshInput]::Posts.Count-eq0) "$cmd guard-return root change authorized new root"
 Fresh;$script:CurrentObservation.hwnd=200;$r=Invoke-Request $req;Check ($r.reason-eq'root-window-observation-required'-and[DshInput]::Posts.Count-eq0) "$cmd accepted child observation as root"
}
@{checks=$checks;failures=$failures;actualDispatcher=$true;actualObservationGuard=$true;native='fake recorder; no OS/game acceptance'}|ConvertTo-Json -Depth 4
if($failures.Count){throw ($failures-join'; ')}
