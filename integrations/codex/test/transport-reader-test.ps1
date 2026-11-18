$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Web.Extensions
$source=(Get-Content -Raw -Encoding UTF8 (Join-Path $PSScriptRoot '../sidecar.ps1')).Replace("`r`n","`n")
$a=$source.IndexOf('$cs = @'+"'"+"`n")+9
$cs=$source.Substring($a,$source.IndexOf("`n'@",$a)-$a)
$pattern='\[DllImport\("user32.dll"[^\n]*\)\]\s*public static extern bool PostMessage\([^;]+;'
$cs=[regex]::Replace($cs,$pattern,'public static int TestPosts=0; public static bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l){Interlocked.Increment(ref TestPosts);return true;}')
$cs+=@'
public sealed class InterruptReaderFixture : System.IO.TextReader {
 public readonly BlockingCollection<string> Lines=new BlockingCollection<string>();
 public override string ReadLine(){var line=Lines.Take();return line=="EOF"?null:line;}
 public static void Run(){
  var reader=new InterruptReaderFixture();Console.SetIn(reader);
  reader.Lines.Add("ordinary");if(DshInput.ReadRequestLine()!="ordinary")throw new Exception("ordinary request lost");
  string failure=null;
  var thread=new Thread(delegate(){try{DshInput.PostText(new IntPtr(1),new string('a',10000));}catch(Exception e){failure=e.Message;}});
  thread.Start();while(DshInput.TestPosts==0)Thread.Sleep(1);
  reader.Lines.Add("{\"cmd\":\"__interrupt\",\"reason\":\"host-cancel\"}");
  if(!thread.Join(1000)||!DshInput.Paused||failure!="paused-partial"||DshInput.TestPosts>=10000)throw new Exception("reader failed to interrupt active sequence");
  DshInput.Resume();if(!DshInput.Paused)throw new Exception("resume unsealed old transport");
  DshInput.Paused=false;bool sealedGate=false;try{DshInput.CheckNotPaused();}catch(OperationCanceledException){sealedGate=true;}DshInput.Paused=true;
  if(!sealedGate)throw new Exception("old sequence resumed after pause flag cleared");
  int count=DshInput.TestPosts;Thread.Sleep(30);if(count!=DshInput.TestPosts)throw new Exception("late sequence steps");
  reader.Lines.Add("queued-never-execute");reader.Lines.Add("EOF");
  var watch=Stopwatch.StartNew();while(!DshInput.TransportEnded&&watch.ElapsedMilliseconds<1000)Thread.Sleep(1);
  if(DshInput.ReadRequestLine()!=null)throw new Exception("EOF continued queued request");
 }
}
'@
Add-Type -TypeDefinition $cs -ReferencedAssemblies @([System.Web.Script.Serialization.JavaScriptSerializer].Assembly.Location,[System.Windows.Forms.Form].Assembly.Location,[Drawing.Point].Assembly.Location)
# Start only a no-window sleep stub, registered as this test's owned capture.
$temporary=Join-Path ([IO.Path]::GetTempPath()) ('capture-stub-'+[Guid]::NewGuid().ToString('N')+'.js')
[IO.File]::WriteAllText($temporary,'setInterval(()=>{},1000)')
$info=New-Object Diagnostics.ProcessStartInfo
$info.FileName=(Get-Command node).Source;$info.Arguments='"'+$temporary+'"'
$info.UseShellExecute=$false;$info.CreateNoWindow=$true
$child=[Diagnostics.Process]::Start($info)
try {
 [DshInput]::RegisterOwnedCapture($child)
 [InterruptReaderFixture]::Run()
 if(-not $child.WaitForExit(1000)){throw 'owned capture survived interrupt'}
 Write-Output 'PASS: actual independent C# reader interrupts active text immediately, no late steps, EOF drops queued work, owned no-GUI capture stub terminates; native messages fake'
} finally {
 if(-not $child.HasExited){$child.Kill()};$child.Dispose();Remove-Item -LiteralPath $temporary
}
