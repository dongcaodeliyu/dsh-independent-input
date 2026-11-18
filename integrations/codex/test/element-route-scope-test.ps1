# Actual semantic dispatcher and begin seam; no native input or UI providers.
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
public class RouteRoot {public int[] GetRuntimeId(){return new int[]{1};}}
public static class DshInput {public static bool Paused=false,SessionActive=false;public static int Sends=0;public static void CheckNotPaused(){}public static bool IsWindow(IntPtr h){return h!=IntPtr.Zero;}public static IntPtr RootOf(IntPtr h){return new IntPtr(100);}public static int WindowPid(IntPtr h){return 7;}public static int[] WindowRect(IntPtr h){return new int[]{0,0,400,300};}public static bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l){Sends++;return true;}}
public static class DshOverlay {public static void ResetSessionTarget(){}}
'@
. (Join-Path $PSScriptRoot '../lib/observation.ps1')
function Get-ElementSnapshot($element){return $script:Snapshot}
function Commit-InputSource{};function Show-InputIndicator{};function Get-StatusResult{return @{ok=$true;paused=$false;sessionState='active'}}
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '../sidecar.ps1'),[ref]$tokens,[ref]$errors)
$node=$ast.Find({param($x)$x-is[Management.Automation.Language.FunctionDefinitionAst]-and$x.Name-eq'Invoke-Request'},$true)
. ([scriptblock]::Create($node.Extent.Text))
$script:SessionFinished=$false
function Fresh($id='owned'){
 $script:Snapshot=@{enabled=$true;offscreen=$false;type='ControlType.Button';nativeWindowHandle=0;nativeRoot=0;nativePid=0;nativeClass='';rect=@{x=10;y=20;width=30;height=30};patterns=@('Invoke');state=@{}}
 $entry=@{element=(New-Object RouteRoot);signature=($script:Snapshot|ConvertTo-Json -Depth 6 -Compress)}
 $script:CurrentObservation=@{id=$id;hwnd=100;root=(New-Object RouteRoot);rootRuntimeId='1';windowRect='0,0,400,300';entries=@{e=$entry}}
}
Fresh;$req=@{cmd='click';mode='auto';hwnd=100;observationId='owned';elementId='e'};$r=Invoke-ObservedElement $req
if($r.reason-ne'focus-preserving-unsupported'-or$r.routeScope-ne'element-native'-or$r.inputSent-ne$false-or$r.providerCalled-ne$false-or$r.attempted-ne$false){throw 'RED precise semantic refusal contract missing'}
if([DshInput]::Sends-ne0-or$r.ContainsKey('nativeClass')-or$r.ContainsKey('nativeWindowHandle')){throw 'refusal dispatched or leaked native detail'}
Fresh 'before-begin';[void](Invoke-Request @{cmd='begin'});$r=Invoke-ObservedElement @{cmd='click';mode='auto';hwnd=100;observationId='before-begin';elementId='e'}
if($r.reason-ne'stale-observation'-or$r.observationInvalidatedBy-ne'begin'-or$r.inputSent-ne$false){throw 'RED begin invalidation not identified'}
$r=Invoke-ObservedElement @{cmd='click';mode='auto';hwnd=100;observationId='unrelated';elementId='e'}
if($r.ContainsKey('observationInvalidatedBy')){throw 'unrelated old ID falsely attributed to begin'}
Fresh 'next-begin';[void](Invoke-Request @{cmd='begin'})
if($script:LastObservationInvalidation.id-ne'next-begin'-or$script:LastObservationInvalidation.Count-ne2){throw 'invalidation must retain one bounded record'}
Fresh;$script:Snapshot.nativeWindowHandle=500;$script:Snapshot.nativeClass='Button';$script:Snapshot.nativeRoot=100;$script:Snapshot.nativePid=7;$script:CurrentObservation.entries.e.signature=($script:Snapshot|ConvertTo-Json -Depth 6 -Compress)
$r=Invoke-ObservedElement $req;if($r.via-ne'bm_click-element'-or[DshInput]::Sends-ne1){throw 'standard native Button compatibility lost'}
'PASS actual element route: precise zero-input refusal; begin invalidation only exact ID, bounded record; standard Button still one BM_CLICK. Fake native/provider seam, no desktop acceptance.'
