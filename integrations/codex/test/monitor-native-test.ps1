# Compile full shipped C#, invoke only readonly monitor/size methods. No Show.
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Web.Extensions
$source=[IO.File]::ReadAllText((Join-Path $PSScriptRoot '../sidecar.ps1')).Replace("`r`n","`n")
$start=$source.IndexOf('$cs = @'+"'`n")+9;$end=$source.IndexOf("`n'@",$start)
Add-Type -TypeDefinition $source.Substring($start,$end-$start) -ReferencedAssemblies @([System.Web.Script.Serialization.JavaScriptSerializer].Assembly.Location,[System.Windows.Forms.Form].Assembly.Location,[Drawing.Point].Assembly.Location)
$first=@([DshInput]::EnumerateMonitors());$result=@()
foreach($m in $first){
 $x=$m.Bounds.X+[int]($m.Bounds.Width/2);$y=$m.Bounds.Y+[int]($m.Bounds.Height/2)
 if([DshInput]::MonitorAtPoint($x,$y).DeviceName -ne $m.DeviceName){throw 'native point/inventory mismatch'}
 if([DshInput]::DpiAt($x,$y) -ne $m.Dpi){throw 'native DPI/inventory mismatch'}
 if([DshInput]::MonitorAtRectangle([Drawing.Rectangle]::new($x,$y,1,1)).DeviceName -ne $m.DeviceName){throw 'native rect/inventory mismatch'}
 $result+=@{device=$m.DeviceName;primary=$m.Primary;dpi=$m.Dpi;bounds=@($m.Bounds.X,$m.Bounds.Y,$m.Bounds.Width,$m.Bounds.Height);workArea=@($m.WorkingArea.X,$m.WorkingArea.Y,$m.WorkingArea.Width,$m.WorkingArea.Height);autoCursorSize=[DshInput]::AutoDisplaySizeAt($x,$y)}
}
if(@([DshInput]::EnumerateMonitors()).Count -ne $first.Count){throw 'topology changed during readonly snapshot; run again when stable'}
@{monitors=$result;preferredSecondary=[DshInput]::PreferredMonitor('secondary').DeviceName;virtualBounds=[DshInput]::VirtualBounds().ToString();uiInitialized=[DshOverlay]::HeaderVisible()} | ConvertTo-Json -Depth 6
if([DshOverlay]::HeaderVisible()){throw 'readonly monitor verification initialized UI'}
