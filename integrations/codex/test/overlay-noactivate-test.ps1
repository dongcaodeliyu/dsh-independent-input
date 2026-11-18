param([string]$SourcePath=(Join-Path $PSScriptRoot '../sidecar.ps1'))
$ErrorActionPreference='Stop'
$s=[IO.File]::ReadAllText((Resolve-Path $SourcePath))
function Extract([string]$anchor){$start=$s.IndexOf($anchor);if($start -lt 0){throw $anchor};$open=$s.IndexOf('{',$start);$depth=1;$i=$open+1;while($depth -gt 0){if($s[$i] -eq '{'){$depth++};if($s[$i] -eq '}'){$depth--};$i++};return $s.Substring($start,$i-$start)}
$display=Extract 'public void DisplayAt(int x, int y)'
$position=Extract 'bool PositionAtAnchor()'
$code=@"
using System; using System.Drawing; using System.Runtime.InteropServices;
public class TimerStub {public int Interval;public void Start(){}public void Stop(){}}
public static class DshOverlay {public static bool LastSetWindowPosOk;public static int LastSetWindowPosError;}
public static class DshInput {public static IntPtr HWND_TOPMOST=new IntPtr(-1);public const int SWP_NOACTIVATE=16,SWP_SHOWWINDOW=64;public static int Calls,Flags;public static bool SetWindowPos(IntPtr h,IntPtr z,int x,int y,int w,int t,uint flags){Calls++;Flags=(int)flags;return true;}}
public class ActualDisplayPath { public bool hasVisual,paused;public double visualX,visualY,startX,startY,targetX,targetY;public long motionStart;public TimerStub motionTimer=new TimerStub(),hoverTimer=new TimerStub();
 public int Implicit;public bool Visible=true;public IntPtr Handle=IntPtr.Zero;public Point Location;public int lastX,lastY,displaySize=48,frame,holdMs=100;public string mode="companion",EffectiveStyle="pointer";public TimerStub animTimer=new TimerStub(),hideTimer=new TimerStub();public bool TopMost{set{Implicit++;}}public void BringToFront(){Implicit++;}public void Show(){Visible=true;}public void Invalidate(){}public void Update(){}public void ApplyFrameRegion(){}public int[] Placement(string s,int x,int y,int size){return new int[]{x,y};}
$position
$display
}
"@
Add-Type -TypeDefinition $code -ReferencedAssemblies System.Drawing
$t=New-Object ActualDisplayPath;$t.DisplayAt(2700,200)
if($t.Implicit -ne 0){throw "Actual DisplayAt calls implicit activating z-order APIs: $($t.Implicit)"}
if([DshInput]::Calls -ne 1 -or ([DshInput]::Flags -band 16) -eq 0){throw 'Expected exactly one explicit native NOACTIVATE positioning'}
'PASS: actual extracted DisplayAt/PositionAtAnchor calls one NOACTIVATE native positioning; no implicit TopMost/BringToFront. Recorder only, no HWND or game effect tested.'
