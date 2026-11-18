param([string]$SourcePath=(Join-Path $PSScriptRoot '../sidecar.ps1'),[string]$OutputDirectory='')
# Full production C# renderer on bitmaps; no Handle/Show/hooks/input.
$ErrorActionPreference='Stop'
$sample='主聊天：清晰测试 gypq'
$points=@($sample.ToCharArray()|Select-Object -First 8|ForEach-Object {[int]$_})
if(($points-join ',')-ne'20027,32842,22825,65306,28165,26224,27979,35797'){throw 'Chinese sample codepoints corrupted'}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Web.Extensions
$s=[IO.File]::ReadAllText((Resolve-Path $SourcePath)).Replace("`r`n","`n")
$start=$s.IndexOf('$cs = @'+"'`n")+9;$end=$s.IndexOf("`n'@",$start)
Add-Type -TypeDefinition $s.Substring($start,$end-$start) -ReferencedAssemblies @([System.Web.Script.Serialization.JavaScriptSerializer].Assembly.Location,[Windows.Forms.Form].Assembly.Location,[Drawing.Point].Assembly.Location)
# Extract precisely the production Display measurement prefix, stopping BEFORE
# monitor lookup/Show/native positioning. No duplicated sizing formula in test.
# Match runtime's process DPI initialization before constructing any form.
[DshInput]::AutoDisplaySize(48)|Out-Null
$screenGraphics=[Drawing.Graphics]::FromHwnd([IntPtr]::Zero)
try{$gdiDpi=$screenGraphics.DpiY}finally{$screenGraphics.Dispose()}
$type=[DshOverlay].GetNestedType('SessionTip',[Reflection.BindingFlags]'NonPublic');$tip=[Activator]::CreateInstance($type,$true)
$measure=$type.GetMethod('MeasureCaption',[Reflection.BindingFlags]'Instance,NonPublic')
if(-not$measure){
 $prefix=[regex]::Match($s,'public void Display\(Rectangle sprite,string text\)\{caption=text;(.*?)Rectangle work=',[Text.RegularExpressions.RegexOptions]::Singleline).Groups[1].Value
 if(-not$prefix){throw 'Production tooltip measure seam missing'}
 Add-Type -TypeDefinition ('using System;using System.Drawing;using System.Windows.Forms;public static class ActualTipSize {public static Size Measure(string text,Font Font){'+$prefix+'return new Size(width,height);}}') -ReferencedAssemblies @([Windows.Forms.Form].Assembly.Location,[Drawing.Point].Assembly.Location)
}
$caption=$type.GetField('caption',[Reflection.BindingFlags]'Instance,NonPublic');$paint=$type.GetMethod('OnPaint',[Reflection.BindingFlags]'Instance,NonPublic')
$failures=@();$cases=0;"GDI reference DPI=$gdiDpi; replay target DPI=96/120/144/192 (not a monitor switch)"
try{
 foreach($dpi in @(96,120,144,192)){
  # GDI TextRenderer on a bitmap does not scale glyphs with SetResolution.
  # Replay equivalent 9pt-at-target-DPI Font using current GDI DC DPI; no monitor GUI claim.
  $tip.Font=[Drawing.Font]::new('Segoe UI',[single](9*$dpi/$gdiDpi))
  foreach($text in @('主聊天：清晰测试 gypq','主聊天：名字','Chat gypq 中文',('很长的会话名 gypq '*30))){
   $caption.SetValue($tip,$text);$size=if($measure){$measure.Invoke($tip,@())}else{[ActualTipSize]::Measure($text,$tip.Font)};$tip.Width=$size.Width
   $reference=[Drawing.Bitmap]::new($size.Width,128);$small=[Drawing.Bitmap]::new($size.Width,$size.Height)
   $gr=[Drawing.Graphics]::FromImage($reference);$gs=[Drawing.Graphics]::FromImage($small);$gr.Clear($tip.BackColor);$gs.Clear($tip.BackColor)
   try{
    $tip.Height=128;$paint.Invoke($tip,[object[]]@([Windows.Forms.PaintEventArgs]::new($gr,[Drawing.Rectangle]::new(0,0,$size.Width,128))))|Out-Null
    $tip.Height=$size.Height;$paint.Invoke($tip,[object[]]@([Windows.Forms.PaintEventArgs]::new($gs,[Drawing.Rectangle]::new(0,0,$size.Width,$size.Height))))|Out-Null
    $missing=0;$ink=0
    for($y=0;$y-lt128;$y++){for($x=0;$x-lt$size.Width;$x++){if($reference.GetPixel($x,$y).R-gt128){$ink++;if($y-ge$small.Height-or$small.GetPixel($x,$y).R-lt128){$missing++}}}}
    if($ink-eq0){throw 'Empty reference cannot prove glyph completeness'}
    if($size.Width-lt110-or$size.Width-gt420){throw 'Width cap changed'}
    if($tip.IsHandleCreated){throw 'Offscreen test created a window handle'}
    $cases++;if($missing){$failures+=,"dpi=$dpi font=$($tip.Font.SizeInPoints) size=$size missing=$missing"}
    if($OutputDirectory-and$text-eq'主聊天：清晰测试 gypq'){$small.Save((Join-Path $OutputDirectory "tooltip-$dpi.png"));$reference.Save((Join-Path $OutputDirectory "tooltip-reference-$dpi.png"))}
   }finally{$gr.Dispose();$gs.Dispose();$reference.Dispose();$small.Dispose()}
  }
 }

 if($measure){
  # Actual pre-Show path: managed bounds include target workarea clamping;
  # no Display/Show/native positioning is invoked by this test.
  $caption.SetValue($tip,'主聊天：清晰测试 gypq')
  $anchor=[Drawing.Rectangle]::new(-150,100,75,75)
  $type.GetField('anchorSprite',[Reflection.BindingFlags]'Instance,NonPublic').SetValue($tip,$anchor)
  $work=[DshInput]::MonitorAtRectangle($anchor).WorkingArea
  $expected=$type.GetMethod('CaptionBounds',[Reflection.BindingFlags]'Instance,NonPublic').Invoke($tip,[object[]]@($anchor,$work))
  $tip.Bounds=[Drawing.Rectangle]::new(0,0,300,300)
  $type.GetMethod('RelayoutCaption',[Reflection.BindingFlags]'Instance,NonPublic').Invoke($tip,@())|Out-Null
  if($tip.Bounds-ne$expected-or$tip.IsHandleCreated-or$tip.Visible){throw 'Pre-Show managed target bounds not prepared'}
  $fixtureWork=[Drawing.Rectangle]::new(-1920,0,1920,1040);$edge=[Drawing.Rectangle]::new(-20,1000,75,75)
  $clamp=$type.GetMethod('CaptionBounds',[Reflection.BindingFlags]'Instance,NonPublic').Invoke($tip,[object[]]@($edge,$fixtureWork))
  if($clamp.Right-ne0-or$clamp.Bottom-ne996){throw 'Tooltip right/bottom working-area rule changed'}
  $caption.SetValue($tip,'主聊天：清晰测试 gypq');$tip.Font=[Drawing.Font]::new('Segoe UI',[single](9*96/$gdiDpi));$tip.Size=$measure.Invoke($tip,@())
  foreach($dpi in @(96,144,192,120)){
   $tip.Font=[Drawing.Font]::new('Segoe UI',[single](9*$dpi/$gdiDpi))
   $reference=[Drawing.Bitmap]::new($tip.Width,128);$small=[Drawing.Bitmap]::new($tip.Width,$tip.Height)
   $gr=[Drawing.Graphics]::FromImage($reference);$gs=[Drawing.Graphics]::FromImage($small);$gr.Clear($tip.BackColor);$gs.Clear($tip.BackColor)
   try {
    $actualHeight=$tip.Height;$tip.Height=128;$paint.Invoke($tip,[object[]]@([Windows.Forms.PaintEventArgs]::new($gr,[Drawing.Rectangle]::new(0,0,$tip.Width,128))))|Out-Null
    $tip.Height=$actualHeight;$paint.Invoke($tip,[object[]]@([Windows.Forms.PaintEventArgs]::new($gs,[Drawing.Rectangle]::new(0,0,$tip.Width,$actualHeight))))|Out-Null
    for($y=0;$y-lt128;$y++){for($x=0;$x-lt$small.Width;$x++){if($reference.GetPixel($x,$y).R-gt128-and($y-ge$small.Height-or$small.GetPixel($x,$y).R-lt128)){throw 'Unchanged caption FontChanged lifecycle clips glyph'}}}
    if($tip.IsHandleCreated){throw 'FontChanged created handle'};$cases++
   }finally{$gr.Dispose();$gs.Dispose();$reference.Dispose();$small.Dispose()}
  }
 }
}finally{$tip.Dispose()}
if($failures.Count){$failures|Write-Output;throw "Tooltip glyph crop: $($failures.Count)/$cases cases; production Display measure + actual OnPaint"}
"PASS actual Display sizing prefix + full C# SessionTip.OnPaint: $cases bitmap cases, no lost glyph pixels versus unclipped reference, bounded width, no handles/Show/hooks/input."
