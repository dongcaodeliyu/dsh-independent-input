$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Web.Extensions
$source=Get-Content -Raw -Encoding UTF8 (Join-Path $PSScriptRoot '../sidecar.ps1')
$source=$source.Replace("`r`n","`n");$a=$source.IndexOf('$cs = @'+"'"+"`n")+9;$b=$source.IndexOf("`n'@",$a);$cs=$source.Substring($a,$b-$a)
$cs=$cs.Replace('[DllImport("shell32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ShellExecuteExW(ref SHELLEXECUTEINFO info);','public static uint RecordedMask; public static int RecordedShow; public static string RecordedVerb,RecordedPath; public static int Closed; static bool ShellExecuteExW(ref SHELLEXECUTEINFO info) {RecordedMask=info.fMask;RecordedShow=info.nShow;RecordedVerb=info.lpVerb;RecordedPath=info.lpFile;info.hProcess=new IntPtr(55);return true;}')
$cs=$cs.Replace('[DllImport("kernel32.dll")] static extern uint GetProcessId(IntPtr process);','static uint GetProcessId(IntPtr process){return 42;}')
$cs=$cs.Replace('[DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);','static bool CloseHandle(IntPtr handle){Closed++;return true;}')
$cs=$cs.Replace('[DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(POINT point, uint flags);','public static IntPtr MonitorFromPoint(POINT point, uint flags){return new IntPtr(77);}')
Add-Type -TypeDefinition $cs -ReferencedAssemblies @([System.Web.Script.Serialization.JavaScriptSerializer].Assembly.Location,[System.Windows.Forms.Form].Assembly.Location,[System.Drawing.Point].Assembly.Location)
$r=[DshInput]::ShellOpen('C:\fixture.txt',3000,100)
if([DshInput]::RecordedMask -ne 0x00200140 -or [DshInput]::RecordedShow -ne 4 -or [DshInput]::RecordedVerb -cne 'open' -or $r[2] -ne 42 -or [DshInput]::Closed -ne 1){throw 'Shell native request/handle cleanup mismatch'}
[DshInput]::Paused=$true
try {[DshInput]::ShellOpen('C:\fixture.txt',3000,100);throw 'missing pause'}catch {if($_.Exception.Message -notmatch 'paused-partial'){throw}}
if([DshInput]::Closed -ne 1){throw 'paused call must not launch'}
Write-Output 'PASS: shipped native ShellOpen flags HMONITOR/NOCLOSEPROCESS/NOASYNC, open verb, SW_SHOWNOACTIVATE, handle cleanup and pause gate; fake Shell recorder only, no app launched'
