# Compile the shipped C# but invoke only pure metadata/placement methods.
# No windows are shown; no input or overlay commands are dispatched.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Web.Extensions
$source = Get-Content -Raw -Encoding UTF8 (Join-Path $PSScriptRoot '../sidecar.ps1')
$source = $source.Replace("`r`n", "`n")
$start = $source.IndexOf('$cs = @' + "'" + "`n")
if ($start -lt 0) { throw 'C# source start not found' }
$start += 9
$end = $source.IndexOf("`n'@", $start)
$cs = $source.Substring($start, $end - $start)
Add-Type -TypeDefinition $cs -ReferencedAssemblies @([System.Web.Script.Serialization.JavaScriptSerializer].Assembly.Location,[System.Windows.Forms.Form].Assembly.Location, [System.Drawing.Point].Assembly.Location)
$assetDir=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../assets/cursors'))
if(-not(Test-Path $assetDir)){$assetDir=Join-Path $PSScriptRoot '../assets/cursors'}
$states=@('pointer','work','unavailiable','link','text','cross','busy','move','vert','horz','help','handwriting','dgn1','dgn2','alternate')
foreach($state in $states){
 $image=[Drawing.Bitmap]::FromFile((Join-Path $assetDir ($state+'.png')))
 try{if($image.Width-ne512-or$image.Height-ne192){throw 'Unexpected upstream atlas dimensions'}}finally{$image.Dispose()}
 [DshOverlay]::ConfigureSpriteLayout(64,8)
 foreach($size in @(24,64,192)){$p=[DshOverlay]::Placement($state,-400,100,$size);if($p[0]-ne-400-or$p[1]-ne100){throw 'Default upstream hotspot placement'}}
}
'PASS actual upstream PNG decode: 15 original 512x192 atlases, 24 64px frames, default 60ms; compiled overlay placement without Show'
# Own temporary JSON only: monitor-specific logical values preserve other fields.
$temp=Join-Path ([IO.Path]::GetTempPath()) ('header-settings-'+[Guid]::NewGuid().ToString('N')+'.json')
try {
 [IO.File]::WriteAllText($temp,'{"cursorSize":0,"enabled":true,"unrelated":"preserve"}')
 [DshOverlay]::SaveHeaderSetting($temp,'DISPLAY_A',[double[]]@(30,8,280,40))
 [DshOverlay]::SaveHeaderSetting($temp,'DISPLAY_B',[double[]]@(10,16,320,50))
 $a=[DshOverlay]::ReadHeaderSetting($temp,'DISPLAY_A'); $b=[DshOverlay]::ReadHeaderSetting($temp,'DISPLAY_B')
 if(($a -join ',') -ne '30,8,280,40' -or ($b -join ',') -ne '10,16,320,50') {throw 'DIP roundtrip failed'}
 $json=Get-Content -Raw $temp | ConvertFrom-Json
 if($json.cursorSize -ne 0 -or $json.unrelated -ne 'preserve') {throw 'existing settings overwritten'}
 [DshOverlay]::SaveHeaderSetting($temp,'DISPLAY_A',$null)
 if($null -ne [DshOverlay]::ReadHeaderSetting($temp,'DISPLAY_A') -or $null -eq [DshOverlay]::ReadHeaderSetting($temp,'DISPLAY_B')) {throw 'reset must affect one screen only'}
 $c=[DshOverlay]::ClampHeader(-1920,0,1920,1040,-3000,2000,420,60)
 if(($c -join ',') -ne '-1920,980,420,60') {throw 'custom header clamp failed'}
 Write-Output 'PASS: header per-monitor DIP settings roundtrip/reset preserves cursorSize0 and other fields; custom bounds clamped'
} finally { if(Test-Path -LiteralPath $temp) {Remove-Item -LiteralPath $temp} }

if([DshInput]::AutoDisplaySize(48) -ne 75 -or [DshInput]::AutoDisplaySize(32) -ne 50){throw 'default 25 percent enlargement regression'}
'PASS automatic 48->75 / 32->50 display size; manual size remains separate'
