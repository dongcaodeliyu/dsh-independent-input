param([string]$SourceRoot=(Join-Path $PSScriptRoot '..'))
# Shipped methods and inventory, native-call recorder only. No Form or HWND.
$ErrorActionPreference='Stop'
$source=[IO.File]::ReadAllText((Join-Path $SourceRoot 'sidecar.ps1')).Replace('[System.Windows.Forms.Screen]::AllScreens','[DshCachedScreen]::AllScreens')
$current=[IO.File]::ReadAllText((Join-Path $PSScriptRoot '../sidecar.ps1'))
$start=$current.IndexOf('    // Do not use WinForms Screen')
$end=$current.IndexOf('    [DllImport("shcore.dll")]', $start)
$code=$current.Substring($start,$end-$start)
function Extract-CSharp([string]$anchor) {$start=$current.IndexOf($anchor);$open=$current.IndexOf('{',$start);$depth=1;$i=$open+1;while($depth -gt 0){if($current[$i] -eq '{'){$depth++};if($current[$i] -eq '}'){$depth--};$i++};return $current.Substring($start,$i-$start)}
$header=Extract-CSharp 'public void DisplayAt(int x,int y,bool paused)'
$placement=Extract-CSharp 'public static int[] HeaderPlacement('
$clamp=Extract-CSharp 'public static int[] ClampHeader('

$code=$code.Replace('[DllImport("user32.dll",SetLastError=true)] static extern bool EnumDisplayMonitors(IntPtr dc,IntPtr clip,MonitorEnumProc callback,IntPtr data);','static bool EnumDisplayMonitors(IntPtr dc,IntPtr clip,MonitorEnumProc callback,IntPtr data) {Calls++;for(int i=0;i<Topology.Length;i++){var b=Topology[i].Bounds;var r=new RECT {Left=b.Left,Top=b.Top,Right=b.Right,Bottom=b.Bottom};if(!callback(new IntPtr(i+1),IntPtr.Zero,ref r,IntPtr.Zero))return false;}return true;}')
$code=$code.Replace('[DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool GetMonitorInfoW(IntPtr monitor,ref MONITORINFOEX info);','static bool GetMonitorInfoW(IntPtr monitor,ref MONITORINFOEX info){var m=Topology[monitor.ToInt32()-1];info.device=m.DeviceName;info.flags=m.Primary?1u:0u;info.monitor=new RECT {Left=m.Bounds.Left,Top=m.Bounds.Top,Right=m.Bounds.Right,Bottom=m.Bounds.Bottom};info.work=new RECT {Left=m.WorkingArea.Left,Top=m.WorkingArea.Top,Right=m.WorkingArea.Right,Bottom=m.WorkingArea.Bottom};return true;}')
$code=$code.Replace('[DllImport("user32.dll")] static extern IntPtr MonitorFromRect(ref RECT rect,uint flags);','static IntPtr MonitorFromRect(ref RECT rect,uint flags){return MonitorFromPoint(new POINT {X=rect.Left+(rect.Right-rect.Left)/2,Y=rect.Top+(rect.Bottom-rect.Top)/2},flags);}')
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System;using System.Drawing;using System.Collections.Generic;using System.Runtime.InteropServices;
public static class DshInput {
 public struct POINT {public int X,Y;}public struct RECT {public int Left,Top,Right,Bottom;}
 public static bool SetWindowPos(IntPtr h,IntPtr z,int x,int y,int w,int height,int flags){return true;}
 public static int Calls;public static MonitorSnapshot[] Topology;public static uint DpiAt(int x,int y){return MonitorAtPoint(x,y).Dpi;}
 public static IntPtr MonitorFromPoint(POINT p,uint flags){for(int i=0;i<Topology.Length;i++)if(Topology[i].Bounds.Contains(p.X,p.Y))return new IntPtr(i+1);return new IntPtr(1);}
 public static int GetDpiForMonitor(IntPtr h,int kind,out uint x,out uint y){x=y=Topology[h.ToInt32()-1].Dpi;return 0;}
$code
}
public class ActualHeaderRecorder {
 public bool dragging,resizing,Visible;public Rectangle work,Bounds;public string device="",SettingsPath="",Text;public int dpi;public IntPtr Handle=IntPtr.Zero;
 public static string HeaderText(bool paused){return paused?"paused":"active";}public static double[] ReadHeaderSetting(string p,string d){return null;}
 public void CancelInteraction(){dragging=resizing=false;}public void Show(){Visible=true;}public void RenderHeader(){}
$placement
$clamp
$header
}
// A cold WinForms Screen cache stays at the first topology. This reproduces
// the long-lived inventory path while native enumeration changes underneath.
public static class DshCachedScreen {public static DshInput.MonitorSnapshot[] AllScreens;}
"@
function New-Monitor($device,$x,$y,$w,$h,$primary,$dpi) {
 $m=New-Object DshInput+MonitorSnapshot;$m.DeviceName=$device;$m.Bounds=[Drawing.Rectangle]::new($x,$y,$w,$h);$m.WorkingArea=[Drawing.Rectangle]::new($x,$y,$w,$h-40);$m.Primary=$primary;$m.Dpi=$dpi;return $m
}
$headerProbe=New-Object ActualHeaderRecorder
$one=New-Monitor 'MAIN' 0 0 2560 1600 $true 144
$side=New-Monitor 'SIDE' -1920 -200 1920 1080 $false 96
[DshInput]::Topology=@($one);[DshCachedScreen]::AllScreens=@($one)
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors)
$function=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Get-MonitorInfo'},$true)
Invoke-Expression $function.Extent.Text
if(@(Get-MonitorInfo).Count -ne 1){throw 'first inventory'}
$headerProbe.DisplayAt(100,100,$false);if($headerProbe.device -ne 'MAIN'){throw 'header first screen'}
[DshInput]::Topology=@($one,$side)
$fresh=@(Get-MonitorInfo)
if($fresh.Count -ne 2){throw 'RED: long-lived Get-MonitorInfo retained the one-screen cache after hotplug'}
if($fresh[1].device -ne 'SIDE' -or $fresh[1].bounds.x -ne -1920 -or $fresh[1].dpi -ne 96 -or $fresh[1].workArea.height -ne 1040){throw 'physical monitor properties lost'}
$headerProbe.DisplayAt(-900,100,$false);if($headerProbe.device -ne 'SIDE' -or $headerProbe.dpi -ne 96 -or $headerProbe.Bounds.Left -lt -1920 -or $headerProbe.Bounds.Right -gt 0){throw 'actual header DisplayAt retained old topology'}
if([DshInput]::PreferredMonitor('secondary').DeviceName -ne 'SIDE' -or [DshInput]::PreferredMonitor('primary').DeviceName -ne 'MAIN'){throw 'preferred monitor did not refresh'}
if([DshInput]::MonitorAtPoint(-900,100).DeviceName -ne 'SIDE'){throw 'header point monitor stale'}
if([DshInput]::MonitorAtRectangle([Drawing.Rectangle]::new(-900,100,75,75)).DeviceName -ne 'SIDE'){throw 'tooltip rectangle monitor stale'}
if([DshInput]::VirtualBounds().Left -ne -1920){throw 'full capture union stale'}
[DshInput]::Topology=@($one)
if(@(Get-MonitorInfo).Count -ne 1 -or [DshInput]::PreferredMonitor('secondary').DeviceName -ne 'MAIN' -or [DshInput]::VirtualBounds().Left -ne 0){throw 'unplug fallback stale'}
if($current -match 'Screen\.FromPoint|Screen\.FromRectangle|\[System.Windows.Forms.Screen\]::|SystemInformation\]::VirtualScreen'){throw 'monitor-aware path still uses cached WinForms topology'}
if([DshInput]::Calls -lt 7){throw 'enumeration was cached'}
'PASS actual shipped monitor enumeration/read/select + Get-MonitorInfo: same-process 1->2->1 topology; negative bounds/workarea/DPI/primary preserved; secondary/point/rectangle/virtual bounds refresh; native-call recorder only, no windows'
