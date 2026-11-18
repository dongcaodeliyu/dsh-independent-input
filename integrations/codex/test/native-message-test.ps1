$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Web.Extensions
$source=(Get-Content -Raw -Encoding UTF8 (Join-Path $PSScriptRoot '../sidecar.ps1')).Replace("`r`n","`n")
$a=$source.IndexOf('$cs = @'+"'"+"`n")+9;$cs=$source.Substring($a,$source.IndexOf("`n'@",$a)-$a)
$patterns=@{
 '\[DllImport\("user32.dll",EntryPoint="SendMessageTimeoutW",CharSet=CharSet.Unicode,SetLastError=true\)\] static extern IntPtr SendTextTimeout\([^;]+;'='public static int Calls=0,FailAt=0; public static uint Flags,Timeout; static IntPtr SendTextTimeout(IntPtr h,uint m,IntPtr w,string text,uint f,uint t,out IntPtr result){Calls++;Flags=f;Timeout=t;result=new IntPtr(1);return Calls==FailAt?IntPtr.Zero:new IntPtr(1);}'
 '\[DllImport\("user32.dll",EntryPoint="SendMessageTimeoutW",CharSet=CharSet.Unicode,SetLastError=true\)\] static extern IntPtr ReadTextTimeout\([^;]+;'='static IntPtr ReadTextTimeout(IntPtr h,uint m,IntPtr w,StringBuilder text,uint f,uint t,out IntPtr result){Calls++;Flags=f;Timeout=t;result=new IntPtr(3);text.Append("abc");return Calls==FailAt?IntPtr.Zero:new IntPtr(1);}'
 '\[DllImport\("user32.dll",EntryPoint="SendMessageTimeoutW",SetLastError=true\)\] static extern IntPtr ValueTimeout\([^;]+;'='static IntPtr ValueTimeout(IntPtr h,uint m,IntPtr w,IntPtr value,uint f,uint t,out IntPtr result){Calls++;Flags=f;Timeout=t;result=new IntPtr(3);return Calls==FailAt?IntPtr.Zero:new IntPtr(1);}'
 '\[DllImport\("user32.dll"[^\n]*\)\]\s*public static extern bool PostMessage\([^;]+;'='public static List<uint> Messages=new List<uint>(); public static int FailPost=0; public static bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l){Messages.Add(m);return Messages.Count!=FailPost;}'
 '\[DllImport\("user32.dll"[^\n]*\)\]\s*public static extern bool ScreenToClient\([^;]+;'='public static int Converts=0,FailConvert=0; public static bool ScreenToClient(IntPtr h,ref POINT p){return ++Converts!=FailConvert;}'
}
foreach($entry in $patterns.GetEnumerator()){if([regex]::Matches($cs,$entry.Key).Count -ne 1){throw 'native seam mismatch'};$cs=[regex]::Replace($cs,$entry.Key,$entry.Value)}
Add-Type -TypeDefinition $cs -ReferencedAssemblies @([System.Web.Script.Serialization.JavaScriptSerializer].Assembly.Location,[System.Windows.Forms.Form].Assembly.Location,[Drawing.Point].Assembly.Location)
function ExpectFailure($operation,$match){try{&$operation;throw 'missing-failure'}catch{if($_.Exception.Message -notmatch $match){throw}}}
[void][DshInput]::SetTextMessage([IntPtr]1,'abc')
if([DshInput]::Calls -ne 1 -or [DshInput]::Flags -ne 0x23 -or [DshInput]::Timeout -ne 600){throw 'text message unbounded/wrong flags'}
[DshInput]::Calls=0;[DshInput]::FailAt=1;ExpectFailure {[DshInput]::SetTextMessage([IntPtr]1,'abc')} 'message-result-unknown'
if([DshInput]::Calls -ne 1){throw 'uncertain write resent'}
[DshInput]::Calls=0;[DshInput]::FailAt=2;ExpectFailure {[DshInput]::GetTextMessage([IntPtr]1)} 'message-read-failed'
if([DshInput]::Calls -ne 2){throw 'read retried'}
[DshInput]::FailPost=3;ExpectFailure {[DshInput]::PostMouseClick([IntPtr]1,10,10,$false,1)} 'button release'
[DshInput]::Messages.Clear();[DshInput]::FailPost=0;[DshInput]::Converts=0;[DshInput]::FailConvert=2
ExpectFailure {[DshInput]::PostMouseDrag([IntPtr]1,10,10,40,40,4)} 'coordinate conversion'
if([DshInput]::Messages.Count -ne 3 -or [DshInput]::Messages[2] -ne 0x202){throw 'drag conversion failure continued or failed same-target release'}
Write-Output 'PASS: actual text functions use bounded timeout/no resend; failed read, click release and drag conversion surface failure with same-target cleanup; fake native only'
