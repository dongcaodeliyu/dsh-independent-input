# Shipped request dispatcher with thin native recorders. No real HWND/input/UI.
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;using System.Collections.Generic;
public static class DshInput {
 public static bool SessionActive=false,Paused=false,NativeEdit=false;public static int Writes=0;public static string Text="";public static List<long> Recipients=new List<long>();
 public static void CheckNotPaused(){}public static bool IsWindow(IntPtr h){return h.ToInt64()==100||h.ToInt64()==200||h.ToInt64()==300;}
 public static IntPtr RootOf(IntPtr h){return new IntPtr(100);}public static IntPtr ChildAt(IntPtr h,int x,int y){return new IntPtr(200);}
 public static string WindowClass(IntPtr h){return NativeEdit?"Edit":h.ToInt64()==100?"Chrome_WidgetWin_1":"Chrome_RenderWidgetHostHWND";}
 public static int[] WindowRect(IntPtr h){return new int[]{0,0,600,400};}
 public static void PostText(IntPtr h,string value){Recipients.Add(h.ToInt64());}
 public static void PostKey(IntPtr h,int key,bool down,bool extended,bool sys){Recipients.Add(h.ToInt64());}
 public static string GetTextMessage(IntPtr h){return Text;}public static bool SetTextMessage(IntPtr h,string text){Recipients.Add(h.ToInt64());Text=text;Writes++;return true;}
}
'@
$source=[IO.File]::ReadAllText((Join-Path $PSScriptRoot '../sidecar.ps1'))
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors)
foreach($name in @('Invoke-Request','Get-Vk')){$node=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true);Invoke-Expression $node.Extent.Text}
function Get-PausedResult {return $null}
function Get-FocusPolicyBlock {return $null}
function Commit-InputSource {[DshInput]::CheckNotPaused()}
function Show-InputIndicator {}
function Show-StateAt {}
function Get-InputObservationStatus($id,$hwnd){$script:GuardHwnd=$hwnd;return @{ok=($id -eq 'fresh' -and $hwnd -eq $script:CurrentObservation.hwnd);reason='stale-observation'}}
$script:SessionFinished=$false;$script:cursorStyle='pointer'
$script:CurrentObservation=@{hwnd=100}
$r=Invoke-Request @{cmd='type';hwnd=300;windowObservationId='fresh';text='probe';mode='message'}
if(-not $r.ok -or $r.hwnd -ne 300 -or $r.target -ne 100 -or $script:GuardHwnd -ne 100 -or [DshInput]::Recipients[0] -ne 300){throw 'explicit child type was promoted to root or root guard lost'}
[DshInput]::Recipients.Clear();$script:CurrentObservation=@{hwnd=100}
$r=Invoke-Request @{cmd='key';hwnd=100;windowObservationId='fresh';keys='enter';x=20;y=30;mode='message'}
if(-not $r.ok -or $r.hwnd -ne 200 -or $r.target -ne 100 -or ([DshInput]::Recipients -join ',') -ne '200,200'){throw 'key coordinate route not sent to actual child'}
[DshInput]::Recipients.Clear();$script:CurrentObservation=@{hwnd=300}
$r=Invoke-Request @{cmd='key';hwnd=300;windowObservationId='fresh';keys='enter';mode='message'}
if($r.reason -ne 'root-window-observation-required' -or [DshInput]::Recipients.Count){throw 'child observation accepted instead of requiring root observation'}
[DshInput]::Recipients.Clear();$r=Invoke-Request @{cmd='key';hwnd=100;keys='enter';x=20;mode='message'}
if($r.ok -ne $false -or [DshInput]::Recipients.Count){throw 'partial key coordinate sent input'}
$script:CurrentObservation=@{hwnd=100};[DshInput]::NativeEdit=$true
$r=Invoke-Request @{cmd='type';hwnd=300;windowObservationId='fresh';text='native-value';replace=$true;mode='auto'}
if(-not $r.verified -or $r.hwnd -ne 300 -or [DshInput]::Writes -ne 1 -or [DshInput]::Text -cne 'native-value'){throw 'standard native Edit setter/readback regressed'}
'PASS actual dispatcher: explicit child recipient preserved with root observation; child observation refused; coordinate key child recipient; partial pair refused; native Edit one-write exact readback; no global focus lookup'
