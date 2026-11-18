$ErrorActionPreference='Stop'
$source=[IO.File]::ReadAllText((Join-Path $PSScriptRoot '../sidecar.ps1'))
$match=[regex]::Match($source,'(?s)\$cs = @\x27\r?\n(.*?)\r?\n\x27@')
Add-Type -AssemblyName System.Windows.Forms,System.Drawing,System.Web.Extensions
Add-Type -TypeDefinition $match.Groups[1].Value -ReferencedAssemblies @([System.Web.Script.Serialization.JavaScriptSerializer].Assembly.Location,[Windows.Forms.Form].Assembly.Location,[Drawing.Point].Assembly.Location)
$rows=[System.Web.Script.Serialization.JavaScriptSerializer]::new().DeserializeObject('[{"device":"OLD1","x":10,"y":20,"paused":true},{"device":"REMOVED2","x":2000,"y":20,"paused":false}]')
$one=[Func[int,int,DshInput+MonitorSnapshot]]{param($x,$y) $m=New-Object DshInput+MonitorSnapshot;$m.DeviceName='CURRENT1';return $m}
$merged=[DshOverlay]::NormalizeSharedHeaderRows($rows,$one)
if($merged.Length-ne 1-or$merged[0].Paused-or$merged[0].Screen.DeviceName-ne'CURRENT1'){throw 'obsolete monitor rows must merge on current monitor, paused AND'}
$two=[Func[int,int,DshInput+MonitorSnapshot]]{param($x,$y) $m=New-Object DshInput+MonitorSnapshot;$m.DeviceName=if($x-lt1000){'CURRENT1'}else{'CURRENT2'};return $m}
$split=[DshOverlay]::NormalizeSharedHeaderRows($rows,$two)
if($split.Length-ne 2){throw 'two valid current monitor mappings must stay distinct'}
$notices=[System.Web.Script.Serialization.JavaScriptSerializer]::new().DeserializeObject('[{"x":10,"y":20,"paused":true,"indicator":"finished","notice":true},{"x":2000,"y":20,"paused":true,"indicator":"user-stopped","notice":false},{"x":50,"y":20,"paused":false}]')
$merged=[DshOverlay]::NormalizeSharedHeaderRows($notices,$one)
if($merged[0].Paused -or $merged[0].Notice -or $null-ne $merged[0].Indicator){throw 'Running screen must outrank stops and notices mapped to the same display'}
if([DshOverlay]::HeaderText($true,'finished')-eq[DshOverlay]::HeaderText($true,'user-stopped')){throw 'Stop and finish require distinct text'}
'PASS actual production C# normalization: removed monitor merges, paused AND, two current mappings distinct. Resolver seam only; no Form or dual-monitor GUI acceptance.'
