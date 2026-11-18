# Actual shipped request/element/value functions with an in-memory provider.
# No windows, real UIA provider, hooks, input or production control namespace.
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -TypeDefinition @'
using System;
public class ValueState {
 public string Backing="before",Pending=null;public bool IsReadOnly=false,ThrowRead=false;public int ReadsRemaining=0,Writes=0;
 public string Value {get{if(ThrowRead&&Writes>0)throw new Exception("readback failed");if(Pending!=null){if(ReadsRemaining--<=0){Backing=Pending;Pending=null;}}return Backing;}}
}
public class ValuePatternFixture {
 public ValueState Current=new ValueState();public bool ThrowSet=false,Mismatch=false,ChangeIdentity=false;public ElementFixture Owner;
 public void SetValue(string value){Current.Writes++;if(ChangeIdentity)Owner.Id++;if(Mismatch)Current.Backing="mismatch";else if(Current.ReadsRemaining>0)Current.Pending=value;else Current.Backing=value;if(ThrowSet)throw new Exception("setter threw after write");}
}
public class ElementFixture {
 public int Id=2,PatternGets=0;public object LastPattern;public ValuePatternFixture Pattern=new ValuePatternFixture();
 public int[] GetRuntimeId(){return new int[]{Id};}
 public object GetCurrentPattern(object identity){PatternGets++;LastPattern=identity;return Pattern;}
 public void SetFocus(){throw new Exception("forbidden focus");}
}
public class RootFixture {public int[] GetRuntimeId(){return new int[]{1};}}
public static class DshInput {public static bool Paused=false,SessionActive=false;public static long Foreground=11;public static IntPtr GetForegroundWindow(){return new IntPtr(Foreground);}public static IntPtr RootOf(IntPtr h){return h;}public static bool IsWindow(IntPtr h){return true;}public static int[] WindowRect(IntPtr h){return new int[]{0,0,600,400};}public static void CheckNotPaused(){if(Paused)throw new Exception("paused");}}
'@
function Load-Function($file,$name){$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseInput([IO.File]::ReadAllText($file),[ref]$tokens,[ref]$errors);$node=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true);if(-not $node){throw $name};Invoke-Expression ('function global:'+$name+$node.Extent.Text.Substring(('function '+$name).Length))}
$obs=Join-Path $PSScriptRoot '../lib/observation.ps1';$sidecar=Join-Path $PSScriptRoot '../sidecar.ps1'
foreach($name in @('Invoke-ObservedValue','Invoke-ObservedElement','Get-FocusPolicyBlock','Get-StaleObservationResult')){Load-Function $obs $name}
Load-Function $sidecar 'Invoke-Request'
function Get-PausedResult {return $null}
function Commit-InputSource { [DshInput]::CheckNotPaused() }
function Show-InputIndicator {if($script:MutateHint){$script:Element.Pattern.Current.Backing='changed'};if($script:SwitchForegroundHint){[DshInput]::Foreground=22}}
function Show-StateAt {}
function Get-ElementSnapshot($element){$out=[ordered]@{};foreach($key in $script:Shape.Keys){$out[$key]=$script:Shape[$key]};$out.runtimeId=($element.GetRuntimeId()-join ',');$out.value=if($out.password){$null}else{$element.Pattern.Current.Value};return $out}
function Setup {
 $script:SessionFinished=$false;$script:focusPolicy='preserve';$script:MutateHint=$false;$script:SwitchForegroundHint=$false;[DshInput]::Foreground=11
 $script:Element=New-Object ElementFixture;$script:Element.Pattern.Owner=$script:Element
 $script:Shape=[ordered]@{runtimeId='2';type='ControlType.Edit';enabled=$true;offscreen=$false;password=$false;nativePassword=$false;nativeReadOnly=$false;state=@{readonly=$false};patterns=@('Value');value='before';rect=@{x=10;y=20;width=100;height=30};nativeWindowHandle=0;nativeClass='css-class-not-a-type'}
}
function Observe {
 $signature=(Get-ElementSnapshot $script:Element)|ConvertTo-Json -Depth 6 -Compress
 $script:CurrentObservation=@{id='fresh';hwnd=11;root=(New-Object RootFixture);rootRuntimeId='1';windowRect='0,0,600,400';entries=@{e=@{element=$script:Element;signature=$signature}}}
}
function Request {param([string]$text='next',[bool]$replace=$true);return Invoke-Request @{cmd='type';hwnd=11;mode='value';observationId='fresh';elementId='e';text=$text;replace=$replace}}
Setup;Observe;$r=Request; if(-not $r.ok -or $r.verification -ne 'value-readback-only' -or $r.focusRequested -ne $false -or $r.focusEffect -ne 'unverified' -or -not $r.mayActivate -or $script:Element.Pattern.Current.Writes -ne 1){throw 'single semantic setter/readback contract'}
if(-not [Object]::ReferenceEquals($script:Element.LastPattern,[System.Windows.Automation.ValuePattern]::Pattern)){throw 'non-Value provider used'}
Setup;Observe;$r=Request 'plus' $false;if(-not $r.ok -or $script:Element.Pattern.Current.Backing -cne 'beforeplus'){throw 'append guarded current value'}
Setup;Observe;$r=Request 'before';if(-not $r.ok -or -not $r.noOp -or $r.attempted -or $script:Element.Pattern.Current.Writes){throw 'equal-value no-op invoked setter'}
Setup;$script:Shape.type='ControlType.ComboBox';Observe;$r=Request;if(-not $r.ok){throw 'editable Value ComboBox rejected'}
foreach($rejection in @('type','pattern','readonly','password','disabled','stale','coordinates','ids','uia')){
 Setup
 switch($rejection){'type'{$script:Shape.type='ControlType.Button'} 'pattern'{$script:Shape.patterns=@()} 'readonly'{$script:Shape.state.readonly=$true} 'password'{$script:Shape.password=$true} 'disabled'{$script:Shape.enabled=$false}}
 Observe
 $request=@{cmd='type';hwnd=11;mode='value';observationId='fresh';elementId='e';text='next';replace=$true}
 switch($rejection){'stale'{$request.observationId='old'} 'coordinates'{$request.x=10;$request.y=20} 'ids'{$request.Remove('elementId')} 'uia'{$request.mode='uia'}}
 $r=Invoke-Request $request
 if($r.ok -ne $false -or $script:Element.Pattern.Current.Writes -ne 0){throw ('refusal before provider write: '+$rejection)}
}
Setup;Observe;$script:Element.Pattern.Current.IsReadOnly=$true;$r=Request;if($r.reason -ne 'element-readonly' -or $script:Element.Pattern.Current.Writes){throw 'live provider readonly refused'}
Setup;Observe;$script:MutateHint=$true;$r=Request 'append' $false;if($r.reason -ne 'stale-observation' -or $script:Element.Pattern.Current.Writes){throw 'value changed during hint was appended without guard'}
Setup;Observe;$script:Element.Pattern.Current.ReadsRemaining=8;$r=Request 'delayed';if(-not $r.ok -or $script:Element.Pattern.Current.Writes -ne 1){throw 'async old-to-target readback must not rewrite'}
foreach($failure in @('Mismatch','ThrowSet','ThrowRead','ChangeIdentity')){
 Setup;Observe
 if($failure -eq 'ThrowRead'){$script:Element.Pattern.Current.ThrowRead=$true}else{$script:Element.Pattern.$failure=$true}
 $r=Request
 if($r.ok -ne $false -or $r.attempted -ne $true -or $r.partial -ne 'possible' -or $script:Element.Pattern.Current.Writes -ne 1){throw ('write-uncertain/no-fallback: '+$failure)}
}
'PASS actual request/element/value functions: fresh IDs/types/readonly/password/coordinate refusal; append guard; no-op; one setter with delayed readback; mismatch/throw/identity change uncertain; no focus/legacy/native fallback'
Setup;Observe;[DshInput]::Foreground=22;$r=Request
if($r.reason-ne'value-requires-foreground-under-preserve'-or$r.providerCalled-ne$false-or$r.inputSent-ne$false-or$script:Element.Pattern.Current.Writes-ne0-or$script:Element.PatternGets-ne0){throw 'foreign foreground preserve reached provider'}
Setup;Observe;[DshInput]::Foreground=22;$script:focusPolicy='allow-activation';$r=Request
if(-not$r.verified-or$script:Element.Pattern.Current.Writes-ne1){throw 'persistent allow activation value regressed'}
'PASS actual focus policy: foreign foreground zero provider/setter; own foreground legal Value; persistent allow-activation retains explicit semantics'
Setup;Observe;$script:SwitchForegroundHint=$true;$r=Request
if($r.reason-ne'value-requires-foreground-under-preserve'-or$r.providerCalled-ne$false-or$r.inputSent-ne$false-or$script:Element.Pattern.Current.Writes-ne0){throw 'foreground changed during hint still reached setter/fallback'}
'PASS actual setter gate after indicator: initial own foreground becomes foreign, zero SetValue/no fallback'
