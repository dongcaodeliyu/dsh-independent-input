# Executes the real observation module against in-memory UIA-shaped objects.
# No windows, native input, real UIA providers, or hooks are started.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
public class Box { public double X=10,Y=20,Width=100,Height=30; }
public class Kind { public string ProgrammaticName="ControlType.Edit"; }
public class Properties {
 public string Name="Editor",AutomationId="input"; public Kind ControlType=new Kind();
 public int NativeWindowHandle=0; public bool IsEnabled=true,IsOffscreen=false,IsPassword=false; public Box BoundingRectangle=new Box();
}
public class ValueProperties { public string Value=""; public bool IsReadOnly=false; }
public static class DshOverlay { public static string TrustedCaption="initial"; public static int Indicators=0; public static bool ShowIndicatorAt(int x,int y){Indicators++;return true;} }
public class ValuePattern {
 public ValueProperties Current=new ValueProperties(); public int Writes=0; public bool ThrowAfterWrite=false;
 public void SetValue(string text){if(DshOverlay.Indicators==0)throw new Exception("missing pre-action indicator");Current.Value=text;Writes++;if(ThrowAfterWrite)throw new Exception("uncertain provider failure");}
}
public class InvokePattern { public int Calls=0; public void Invoke(){if(DshOverlay.Indicators==0)throw new Exception("missing pre-action indicator");Calls++;} }
public class Element {
 public Properties Current=new Properties(); public ValuePattern Value=new ValuePattern(); public InvokePattern Invoke=new InvokePattern();
 public int Runtime=1; public bool HasValue=true,HasInvoke=false; public Element[] Children=new Element[0];
 public int[] GetRuntimeId(){return new int[]{42,Runtime};}
 public Element[] FindAll(object scope,object condition){return Children;}
 public object GetCurrentPattern(object id){
  string name=(string)id.GetType().GetProperty("ProgrammaticName").GetValue(id,null);
  if(name.Contains("Value")&&HasValue)return Value;
  if(name.Contains("Invoke")&&HasInvoke)return Invoke;
  throw new Exception("unsupported pattern");
 }
}
public static class DshInput {
 public static bool SessionActive=false; public static bool Paused=false; public static void CheckNotPaused(){if(Paused)throw new Exception("paused-partial");}
 public static int Offset=0,NativeRoot=1,NativePosts=0,NativeWrites=0; public static string NativeText=""; public static bool NativeCorrupt=false;
 public static bool IsWindow(IntPtr hwnd){return hwnd.ToInt64()>=1&&hwnd.ToInt64()<=3;}
 public static IntPtr RootOf(IntPtr h){return new IntPtr(NativeRoot);}
 public static int WindowPid(IntPtr h){return 10;}
 public static string WindowClass(IntPtr h){return h.ToInt64()==3?"WindowsForms10.BUTTON.app.fixture":"WindowsForms10.EDIT.app.fixture";}
 public static IntPtr GetWindowLongPtrW(IntPtr h,int index){return IntPtr.Zero;}
 public static bool PostMessage(IntPtr h,uint message,IntPtr w,IntPtr l){CheckNotPaused();if(h.ToInt64()!=3||message!=0xF5)throw new Exception("wrong button target");NativePosts++;return true;}
 public static string GetTextMessage(IntPtr h){return NativeText;}
 public static bool SetTextMessage(IntPtr h,string text){CheckNotPaused();if(h.ToInt64()!=2)throw new Exception("wrong edit target");NativeWrites++;NativeText=NativeCorrupt?"bad":text;return true;}

 public static int[] WindowRect(IntPtr hwnd){return new[]{Offset,0,600,400};}
 public static string WindowTitle(IntPtr hwnd){return "Memory fixture";}
}
'@
$tt=$null;$ee=$null;$aa=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '../sidecar.ps1'),[ref]$tt,[ref]$ee)
$commit=$aa.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Commit-InputSource'},$true);Invoke-Expression $commit.Extent.Text
. (Join-Path $PSScriptRoot '../lib/observation.ps1')
$script:uia=$true
$script:focusPolicy='allow-activation'
$script:root=New-Object Element
$script:editor=New-Object Element; $script:editor.Runtime=2
$script:button=New-Object Element; $script:button.Runtime=3; $script:button.HasValue=$false; $script:button.HasInvoke=$true; $script:button.Current.Name='Save'
$script:root.Children=@($script:editor,$script:button)
function Get-ObservationRoot { return $script:root }
function Get-ElementParentKey($element) { if($element.Runtime -ne 1){return '42,1'};return $null }
function Get-ObservationFirstChild($element) { if($element.Children.Count){return $element.Children[0]};return $null }
$script:siblingCalls=0
function Get-ObservationNextSibling($element) { $script:siblingCalls++; if([object]::ReferenceEquals($element,$script:editor)){return $script:button};return $null }
function Observe { $o=New-InputObservation 1 10; if(-not $o.ok -or $o.elements.Count -ne 3){throw 'observation missing elements'}; return $o }
function Act($o,$id,$cmd='type',$text='test',$mode='uia') { return Invoke-ObservedElement @{cmd=$cmd;mode=$mode;hwnd=1;observationId=$o.observationId;elementId=$id;text=$text;replace=$true} }
$o=Observe
if($o.elements[1].parentId -ne 'e0' -or $o.elements[1].patterns -notcontains 'Value'){throw 'tree/pattern metadata missing'}
$text='Unicode '+[char]0x4e3b+[char]0x5c4f
$r=Act $o e1 type $text
if(-not $r.verified -or $script:editor.Value.Current.Value -cne $text -or $script:editor.Value.Writes -ne 1){throw ('semantic type failed: '+($r|ConvertTo-Json -Depth 5 -Compress))}
if((Act $o e1).reason -ne 'stale-observation'){throw 'consumed observation accepted twice'}
$o=Observe;$script:editor.Current.Name='Changed'
if((Act $o e1).reason -ne 'stale-observation'){throw 'changed element accepted'}
$o=Observe;[DshInput]::Offset=50
if((Act $o e1).reason -ne 'stale-observation'){throw 'moved window accepted'}
[DshInput]::Offset=0;$o=Observe;$script:editor.Runtime=9
if((Act $o e1).reason -ne 'stale-observation'){throw 'replaced runtime accepted'}
$o=Observe;$r=Act $o e2 click
if(-not $r.ok -or $r.verified -or $script:button.Invoke.Calls -ne 1){throw 'click must invoke once without claiming consumer effect'}
$script:editor.Current.IsPassword=$true;$script:editor.Value.Current.Value='must-not-expose'
$o=Observe
if($null -ne $o.elements[1].value -or (Act $o e1).reason -ne 'element-value-unsupported'){throw 'password value exposure/write'}
$script:editor.Current.IsPassword=$false;$script:editor.Value.ThrowAfterWrite=$true;$o=Observe;$before=$script:editor.Value.Writes
$r=Act $o e1 type 'one-write'
if($r.ok -or $script:editor.Value.Writes -ne $before+1){throw 'uncertain write was retried'}
$script:siblingCalls=0;$limited=New-InputObservation 1 1
if($limited.elements.Count -ne 1 -or -not $limited.truncated -or $script:siblingCalls -ne 0){throw 'limit must bound traversal before walking siblings'}
Write-Output 'PASS: real observation interface tree/IDs; Unicode verified write; stale consumed/name/rect/runtime; semantic invoke once; password redaction; no duplicate uncertain write'

$script:editor.Current.NativeWindowHandle=2
$script:button.Current.NativeWindowHandle=3
$script:button.Current.ControlType.ProgrammaticName='ControlType.Button'
$providerClicks=$script:button.Invoke.Calls; $providerWrites=$script:editor.Value.Writes
foreach($mode in @('auto','message')) {
 $o=Observe; $before=[DshInput]::NativePosts; $r=Act $o e2 click '' $mode
 if(-not $r.ok -or $r.via -ne 'bm_click-element' -or [DshInput]::NativePosts -ne $before+1){throw 'native button must post once to observed child'}
 $o=Observe; $before=[DshInput]::NativeWrites; $r=Act $o e1 type '后台 中文 English' $mode
 if(-not $r.verified -or $r.via -ne 'wm_settext-element' -or [DshInput]::NativeWrites -ne $before+1){throw 'native edit must write once and verify child'}
}
if($script:button.Invoke.Calls -ne $providerClicks -or $script:editor.Value.Writes -ne $providerWrites){throw 'auto/message invoked provider side effect'}
$script:editor.Current.NativeWindowHandle=0; $o=Observe
if((Act $o e1 type 'blocked' auto).reason -ne 'focus-preserving-unsupported'){throw 'unknown native element auto must refuse'}
$script:editor.Current.NativeWindowHandle=2; $o=Observe; [DshInput]::NativeRoot=9; $before=[DshInput]::NativeWrites
if((Act $o e1 type 'blocked' auto).reason -ne 'stale-observation' -or [DshInput]::NativeWrites -ne $before){throw 'native ownership change must stale without send'}
[DshInput]::NativeRoot=1; [DshInput]::NativeCorrupt=$true; $o=Observe; $before=[DshInput]::NativeWrites
$r=Act $o e1 type 'one-native-attempt' message
if($r.reason -ne 'element-write-unverified' -or [DshInput]::NativeWrites -ne $before+1 -or $script:editor.Value.Writes -ne $providerWrites){throw 'uncertain native write repeated/fell back'}
$o=Observe; $r=Act $o e2 click '' uia
if(-not $r.mayActivate -or $script:button.Invoke.Calls -ne $providerClicks+1){throw 'explicit provider action must report mayActivate'}
Write-Output 'PASS: actual ID auto/message dispatch uses only observed native Button/Edit child; one native send/readback; unknown refuses; owner changes stale; explicit uia mayActivate; no provider fallback'

# Run the actual compatibility guard gate, using an empty-key no-side-effect branch.
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '../sidecar.ps1'),[ref]$tokens,[ref]$errors)
$fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Invoke-Request'},$true)
Invoke-Expression $fn.Extent.Text
function Get-PausedResult { return $null }
$script:SessionFinished=$false
$o=Observe; $r=Invoke-Request @{cmd='key';hwnd=1;keys='';windowObservationId=$o.observationId}
if($r.reason -ne 'keys required'){throw 'fresh window guard did not reach actual action validation'}
$r=Invoke-Request @{cmd='key';hwnd=1;keys='';windowObservationId=$o.observationId}
if($r.reason -ne 'stale-observation'){throw 'window guard was not consumed once'}
$o=Observe;[DshInput]::Offset=99;$r=Invoke-Request @{cmd='key';hwnd=1;keys='';windowObservationId=$o.observationId}
if($r.reason -ne 'stale-observation'){throw 'changed root geometry did not block guarded compatibility action'}
Write-Output 'PASS: actual windowObservationId gate fresh acceptance, single consumption and moved-root stale rejection; no input emitted'

# Preserve is a runtime policy, never a flag an individual action can override.
$script:focusPolicy='preserve'; $o=Observe; $before=$script:button.Invoke.Calls
$r=Invoke-ObservedElement @{cmd='click';mode='uia';focusPolicy='allow-activation';hwnd=1;observationId=$o.observationId;elementId='e2'}
if($r.reason -ne 'focus-policy-preserve' -or $script:button.Invoke.Calls -ne $before -or $r.providerCalled -ne $false){throw 'semantic provider bypassed fixed preserve policy'}
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '../sidecar.ps1'),[ref]$tokens,[ref]$errors)
$fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Invoke-Request'},$true);Invoke-Expression $fn.Extent.Text
foreach($cmd in @('click','type','key','scroll','drag')) {
 $o=Observe
 foreach($guard in @($false,$true)) {
  $req=@{cmd=$cmd;mode='uia';hwnd=1;x=10;y=10;text='blocked';keys='enter';focusPolicy='allow-activation'}
  if($guard){$req.windowObservationId=$o.observationId}
  $r=Invoke-Request $req
  if($r.reason -ne 'focus-policy-preserve' -or $r.inputSent -ne $false){throw 'compatibility provider bypassed preserve policy/guard'}
 }
}
$o=Observe
if(-not $o.ok){throw 'preserve disabled readonly UIA'}
Write-Output 'PASS: fixed runtime preserve gate blocks semantic/coordinate/guarded UIA, cannot be overridden per action, readonly observation remains available'

# Real action branch owner commit; readonly/stale/unsupported/paused do not steal owner.
$script:focusPolicy='preserve';[DshInput]::Offset=0;[DshInput]::Paused=$false
function OwnerAct($caption){$o=Observe;$r=Invoke-ObservedElement @{cmd='click';mode='auto';hwnd=1;observationId=$o.observationId;elementId='e2';trustedCaption=$caption};if(-not $r.ok){throw ('owner action '+$r.reason)}}
OwnerAct 'A';if([DshOverlay]::TrustedCaption-ne'A'){throw 'A not committed'}
function Get-StatusResult {return @{ok=$true}}
$r=Invoke-Request @{cmd='status';trustedCaption='B'}
$o=Observe;if([DshOverlay]::TrustedCaption-ne'A'){throw 'readonly stole owner'}
[DshInput]::Paused=$true;$r=Invoke-ObservedElement @{cmd='click';mode='auto';hwnd=1;observationId=$o.observationId;elementId='e2';trustedCaption='B'}
if([DshOverlay]::TrustedCaption-ne'A'){throw 'paused stole owner'}
[DshInput]::Paused=$false;$o=Observe;[DshInput]::Offset=1;$r=Invoke-ObservedElement @{cmd='click';mode='auto';hwnd=1;observationId=$o.observationId;elementId='e2';trustedCaption='B'}
if([DshOverlay]::TrustedCaption-ne'A'){throw 'stale stole owner'}
[DshInput]::Offset=0;$o=Observe;$r=Invoke-ObservedElement @{cmd='click';mode='auto';hwnd=1;observationId=$o.observationId;elementId='e0';trustedCaption='B'}
if([DshOverlay]::TrustedCaption-ne'A'){throw 'unsupported stole owner'}
OwnerAct 'B';if([DshOverlay]::TrustedCaption-ne'B'){throw 'B not committed'}
OwnerAct $null;if([string]::IsNullOrEmpty([DshOverlay]::TrustedCaption)-or[DshOverlay]::TrustedCaption-eq'B'){throw 'missing source retained old owner'}
'PASS actual semantic action ownership A -> rejected/readonly B unchanged -> valid B -> absent fallback; no UI'
