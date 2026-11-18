param([string]$SourceRoot=(Join-Path $PSScriptRoot '..'))
# Compile actual C#; call the exact hook-filter/record method without any hook,
# SendInput, Form, or keyboard event. Non-stop keys leave no record.
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Web.Extensions
$source=[IO.File]::ReadAllText((Join-Path $SourceRoot 'sidecar.ps1')).Replace("`r`n","`n")
$start=$source.IndexOf('$cs = @'+"'`n")+9;$end=$source.IndexOf("`n'@",$start)
Add-Type -TypeDefinition $source.Substring($start,$end-$start) -ReferencedAssemblies @([System.Web.Script.Serialization.JavaScriptSerializer].Assembly.Location,[System.Windows.Forms.Form].Assembly.Location,[Drawing.Point].Assembly.Location)
[DshInput]::SetStopOwner('{"executionId":"fixture-execution","rootId":"fixture-root","name":"测试主聊天"}')
function Check($expected,$vk,$flags,$event,$left,$right,$other){$actual=[DshInput]::FilterStopKey($vk,1,$flags,$event,$left,$right,$other);if($actual-ne$expected){throw "Disposition expected=$expected actual=$actual"}}
[DshInput]::SessionActive=$false
Check 0 27 0 256 $true $false $false
[DshInput]::SessionActive=$true
Check 0 27 0 256 $false $false $false # plain Esc
Check 0 27 16 256 $true $false $false # injected Esc
Check 0 27 0 257 $true $false $false # unpaired up
foreach($vk in @(162,163)){Check 0 $vk 0 256 $true $false $false;Check 0 $vk 0 257 $false $false $false}
# Shift/Alt/Win are queried individually by callback and collapse into other.
foreach($modifier in @('Shift','Alt','LeftWin','RightWin')){Check 0 27 0 256 $true $false $true}
if([DshInput]::StopInfo){throw 'Non-stop keyboard history recorded'}
Check 1 27 0 256 $true $false $false
$first=[DshInput]::StopInfo
if($first.reason-ne'control-escape'-or$first.source-ne'keyboard-hook'-or$first.keyboard.gesture-ne'Ctrl+Esc'-or-not$first.keyboard.leftControl-or$first.keyboard.rightControl-or$first.keyboard.injected-or-not$first.utcTimestamp){throw 'Ctrl+Esc provenance'}
Check 2 27 0 256 $false $false $false # Ctrl released, repeat still paired
Check 0 27 16 257 $false $false $false # injected up cannot clear latch
Check 2 27 0 257 $false $false $false
Check 0 27 0 256 $true $false $false # already paused: no new capture
if([DshInput]::StopInfo.sequence-ne$first.sequence){throw 'repeat created another stop'}
if([DshInput]::RecordStop('transport-eof','transport-eof',$null)){throw 'EOF replaced origin'}
[DshInput]::Resume()
Check 1 27 0 260 $false $true $false # right Ctrl/sys-keydown
if([DshInput]::StopInfo.sequence-le$first.sequence-or-not[DshInput]::StopInfo.keyboard.rightControl){throw 'new right Ctrl event'}
Check 2 27 0 261 $false $false $false
[DshInput]::Resume()
Check 1 27 0 256 $true $false $false
[DshInput]::SessionActive=$false
Check 2 27 0 257 $false $false $false # finish still pairs accepted up
[DshInput]::SessionActive=$true
[DshInput]::Resume()
Check 1 27 0 256 $true $false $false
[DshInput]::SessionActive=$false
[DshInput]::SessionActive=$true # fresh lifecycle discards stale capture
[DshInput]::Resume()
Check 0 27 0 256 $false $false $false
Check 0 27 0 257 $false $false $false
if([DshOverlay]::HeaderVisible()){throw 'UI initialized'}
'PASS compiled actual stop helper: plain/injected/idle/paused/modifiers pass; either Ctrl exact gesture one stop; only accepted Esc repeats/up consumed; no sticky latch across lifecycle; Ctrl keys pass; no hook/window/input'
