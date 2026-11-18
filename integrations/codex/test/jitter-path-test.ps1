param([string]$File=(Join-Path $PSScriptRoot '../sidecar.ps1'))
$ErrorActionPreference='Stop';$s=[IO.File]::ReadAllText((Resolve-Path $File))
function Extract($anchor){$st=$s.IndexOf($anchor);$op=$s.IndexOf('{',$st);$d=1;$i=$op+1;while($d){if($s[$i]-eq'{'){$d++};if($s[$i]-eq'}'){$d--};$i++};$s.Substring($st,$i-$st)}
$methods=(Extract 'public void DisplayAt(int x, int y)')+(Extract 'bool PositionAtAnchor()')+(Extract 'void ApplySprite(Image img)')+(Extract 'public void ApplySize(int size)')+(Extract 'public void ApplyStyle(string style)')+(Extract 'public void DisplayPreparedAt(int x,int y,int size,string style)')
$code=@"
using System;using System.Drawing;using System.Runtime.InteropServices;using System.Collections.Generic;
public class TimerStub {public int Interval;public void Start(){}public void Stop(){}}
public static class DshOverlay {public static bool LastSetWindowPosOk;public static int LastSetWindowPosError;}
public static class DshInput {public static IntPtr HWND_TOPMOST=new IntPtr(-1);public const int SWP_NOACTIVATE=16,SWP_SHOWWINDOW=64;public static PathTest Owner;public static int Calls,Flags;public static bool Fail;public static bool SetWindowPos(IntPtr h,IntPtr z,int x,int y,int w,int t,uint flags){Calls++;Flags=(int)flags;if(Fail)return false;Owner.NativeX=x;Owner.NativeY=y;Owner.NativeW=w;return true;}}
public class PathTest {
public bool Visible,hasVisual,paused;public IntPtr Handle=IntPtr.Zero;public int NativeX=-10000,NativeY=-10000,NativeW=64,LocationWrites,SizeWrites,ShownX,ShownY,ShowCount;public Point Location{set{LocationWrites++;NativeX=value.X;NativeY=value.Y;}}public Size Size{set{SizeWrites++;NativeW=value.Width;}}public int Width{get{return NativeW;}}public int Height{get{return NativeW;}}
public double visualX,visualY,startX,startY,targetX,targetY;public long motionStart;public int lastX,lastY,displaySize=64,frame,frameCount,Cell=256,holdMs=100;public bool deferPosition;public string mode="companion",EffectiveStyle="pointer";public TimerStub animTimer=new TimerStub(),hideTimer=new TimerStub(),motionTimer=new TimerStub(),hoverTimer=new TimerStub();public Dictionary<int,Bitmap> rasterFrames=new Dictionary<int,Bitmap>();public Dictionary<string,int> styleIntervals=new Dictionary<string,int>();public Image sprite;public string baseStyle="pointer";public Dictionary<string,Image> sprites=new Dictionary<string,Image>();
public void Show(){ShowCount++;ShownX=NativeX;ShownY=NativeY;Visible=true;}public void Invalidate(){}public void Update(){}public void ApplyFrameRegion(){}public int[] Placement(string s,int x,int y,int size){return new int[]{x,y};}
$methods
public void SetSprite(){sprite=new Bitmap(256,256);sprites["pointer"]=sprite;sprites["link"]=sprite;}
}
"@
Add-Type -TypeDefinition $code -ReferencedAssemblies System.Drawing
$fail=@();$t=New-Object PathTest;[DshInput]::Owner=$t;$t.DisplayAt(2700,200)
if($t.ShownX-ne2700-or$t.ShownY-ne200){$fail+='Show occurred at old HWND position'}
if($t.LocationWrites-ne0){$fail+='PositionAtAnchor writes both Location and native SetWindowPos'}
$t.SetSprite();[DshInput]::Calls=0;$t.SizeWrites=0;$t.ApplySize(60)
if([DshInput]::Calls-ne1-or$t.SizeWrites-ne0){$fail+='visible size update performs duplicate native/managed placements'}
$t.visualX=2800;$t.visualY=300;$t.DisplayAt(3000,400);if($t.startX-ne2800-or$t.startY-ne300){$fail+='redirect uses old target instead of visual point'}
[DshInput]::Calls=0;$t.DisplayPreparedAt(3200,500,40,'link')
if([DshInput]::Calls-ne1){$fail+='batched style/size/target writes more than once'}
if(([DshInput]::Flags-band64)-ne0){$fail+='hidden layout can SHOWWINDOW unexpectedly'}
$hidden=New-Object PathTest;[DshInput]::Owner=$hidden;[DshInput]::Fail=$true;$hidden.DisplayAt(400,300);if($hidden.ShowCount-ne0){$fail+='failed initial native position still Show'};[DshInput]::Fail=$false
if($fail.Count){$fail|ForEach-Object{"FAIL $_"};exit 1}
'PASS actual extracted DisplayAt/PositionAtAnchor/ApplySprite/ApplySize: positioned before Show, native-only once, size once, redirect visual point; recorder no GUI'
