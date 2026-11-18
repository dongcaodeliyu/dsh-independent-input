# Actual production shared-pause watcher only. Never starts hooks/forms/input.
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '../../lib/executor-bootstrap.ps1')
Wait-ExecutorPermit
Add-Type -AssemblyName System.Windows.Forms,System.Drawing,System.Web.Extensions
$source=[IO.File]::ReadAllText((Join-Path $PSScriptRoot '../../sidecar.ps1'))
$match=[regex]::Match($source,'(?s)\$cs = @''\r?\n(.*?)\r?\n''@')
Add-Type -TypeDefinition $match.Groups[1].Value -ReferencedAssemblies @([System.Web.Script.Serialization.JavaScriptSerializer].Assembly.Location,[Windows.Forms.Form].Assembly.Location,[Drawing.Point].Assembly.Location)
[DshInput]::SetStopOwner($env:DSH_INPUT_OWNER_JSON)
[DshInput]::StartSharedPause()
[Console]::WriteLine('{"event":"ready"}')
while($null-ne($line=[Console]::ReadLine())){
 $req=$line|ConvertFrom-Json
 if($req.cmd-eq'resume'){[DshInput]::Resume()}
 $result=@{ok=$true;paused=[DshInput]::Paused;pauseReason=[DshInput]::PauseReason;stopInfo=[DshInput]::StopInfo;sessionState=if($req.cmd-eq'finish'){'finished'}else{'active'}}
 [Console]::WriteLine((@{id=$req.id;ok=$true;result=$result}|ConvertTo-Json -Depth 12 -Compress));[Console]::Out.Flush()
 if($req.cmd-eq'shutdown'){break}
}
