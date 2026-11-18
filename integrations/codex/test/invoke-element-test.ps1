# Actual dispatcher and provider route; fake HWND/provider, no hooks or desktop input.
param([string]$SourceRoot=(Split-Path $PSScriptRoot -Parent))
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -TypeDefinition @'
using System;
public class InvokeFixture {public int Calls=0;public bool Denied=false,Fail=false;public void Invoke(){Calls++;if(Denied)throw new UnauthorizedAccessException();if(Fail)throw new Exception("uncertain");}}
public class InvokeElementFixture {public InvokeFixture Pattern=new InvokeFixture();public int[] GetRuntimeId(){return new int[]{1};}public object GetCurrentPattern(object p){return Pattern;}}
public static class DshInput {public static bool Paused=false,SessionActive=false;public static long Foreground=11;public static string Reason="";public static void Pause(string reason){Paused=true;Reason=reason;}public static IntPtr GetForegroundWindow(){return new IntPtr(Foreground);}public static IntPtr RootOf(IntPtr h){return h;}public static bool IsWindow(IntPtr h){return true;}public static int[] WindowRect(IntPtr h){return new int[]{0,0,600,400};}public static void CheckNotPaused(){if(Paused)throw new Exception("paused");}}
'@
. (Join-Path $SourceRoot 'lib/observation.ps1')
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $SourceRoot 'sidecar.ps1'),[ref]$tokens,[ref]$errors)
. ([scriptblock]::Create($ast.Find({param($n)$n-is[Management.Automation.Language.FunctionDefinitionAst]-and$n.Name-eq'Invoke-Request'},$true).Extent.Text))
function Get-PausedResult {return $null}
function Commit-InputSource {}
function Show-StateAt {}
function Show-InputIndicator {if($script:SwitchForegroundHint){[DshInput]::Foreground=22}}
function Get-ElementSnapshot {return $script:Shape}
function Setup {
 [DshInput]::Paused=$false;[DshInput]::Foreground=11;$script:SwitchForegroundHint=$false;$script:focusPolicy='preserve';$script:SessionFinished=$false
 $script:Element=New-Object InvokeElementFixture
 $script:Shape=@{type='ControlType.Button';enabled=$true;offscreen=$false;password=$false;nativePassword=$false;patterns=@('Invoke');rect=@{x=10;y=20;width=100;height=30}}
}
function Observe {
 $script:CurrentObservation=@{id='fresh';hwnd=11;root=$script:Element;rootRuntimeId='1';windowRect='0,0,600,400';entries=@{e=@{element=$script:Element;signature=($script:Shape|ConvertTo-Json -Depth 6 -Compress)}}}
}
function Request {Invoke-Request @{cmd='click';mode='invoke';hwnd=11;observationId='fresh';elementId='e'}}
foreach($role in @('ControlType.Button','ControlType.Hyperlink')){Setup;$script:Shape.type=$role;Observe;$r=Request;if(-not$r.ok-or$r.verified-or$r.verification-ne'invoke-dispatch-only'-or$script:Element.Pattern.Calls-ne1){throw ('explicit invoke role contract '+($r|ConvertTo-Json -Depth 6 -Compress))}}
foreach($case in @('foreign','hint-foreign','disabled','offscreen','password','Edit','pattern','stale','coordinates','missing','wrong-action')){
 Setup
 switch($case){'disabled'{$script:Shape.enabled=$false}'offscreen'{$script:Shape.offscreen=$true}'password'{$script:Shape.password=$true}'Edit'{$script:Shape.type='ControlType.Edit'}'pattern'{$script:Shape.patterns=@()}'foreign'{[DshInput]::Foreground=22}'hint-foreign'{$script:SwitchForegroundHint=$true}}
 Observe;$req=@{cmd='click';mode='invoke';hwnd=11;observationId='fresh';elementId='e'}
 switch($case){'stale'{$req.observationId='old'}'coordinates'{$req.x=10;$req.y=20}'missing'{$req.Remove('elementId')}'wrong-action'{$req.cmd='type'}}
 $r=Invoke-Request $req;if($r.ok-ne$false-or$script:Element.Pattern.Calls-ne0){throw ('refused route reached provider: '+$case+' '+($r|ConvertTo-Json -Depth 6 -Compress))}
}
Setup;Observe;$script:Element.Pattern.Fail=$true;$r=Request;if($r.reason-ne'invoke-uncertain'-or-not$r.providerCalled-or$r.inputSent-eq$false-or$r.partial-ne'possible'-or$script:Element.Pattern.Calls-ne1){throw 'called provider uncertainty lost'}
Setup;Observe;$script:Element.Pattern.Denied=$true;$r=Request;if($r.reason-ne'permission-refusal'-or-not$r.stopRequired-or-not[DshInput]::Paused-or[DshInput]::Reason-ne'permission-refusal'-or$script:Element.Pattern.Calls-ne1){throw 'permission denial must stop once without fallback'}
'PASS actual dispatcher Invoke: Button/Hyperlink, fresh identity, own/foreign and post-feedback foreground gates, zero-call refusals, one-call uncertainty and permission stop. No security-dialog/Host acceptance.'
