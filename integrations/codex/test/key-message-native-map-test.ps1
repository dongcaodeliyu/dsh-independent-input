# Real read-only MapVirtualKey; actual production construction; recorded sends.
# No native PostMessage, hooks, Form, keyboard state setter or desktop input.
$ErrorActionPreference='Stop'
$source=[IO.File]::ReadAllText((Join-Path $PSScriptRoot '../sidecar.ps1'))
$start=$source.IndexOf('    public static int KeyMessageLParam(')
$end=$source.IndexOf('    public static void PostText(',$start)
$method=$source.Substring($start,$end-$start)
$prefix=@'
using System;using System.Runtime.InteropServices;
public static class NativeMapKeyBits {
 const int WM_KEYDOWN=0x100,WM_KEYUP=0x101,WM_SYSKEYDOWN=0x104,WM_SYSKEYUP=0x105;
 public static long Bits;public static int Calls;public static bool Paused;
 [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code,uint type);
 public static void CheckNotPaused(){if(Paused)throw new Exception("paused");}
 public static bool PostMessage(IntPtr hwnd,uint message,IntPtr key,IntPtr bits){Calls++;Bits=bits.ToInt64();return true;}
'@
Add-Type -TypeDefinition ($prefix+$method+'}')
$rows=@();$failures=@()
foreach($vk in @(0x21,0x22,0x23,0x24,0x25,0x26,0x27,0x28,0x2d,0x2e,0x62,0x41,0x0d,0x13)){
 $map=[NativeMapKeyBits]::MapVirtualKey($vk,4)
 foreach($down in @($true,$false)){
  [NativeMapKeyBits]::PostKey([IntPtr]1,$vk,$down,$false,$false)
  $bits=[NativeMapKeyBits]::Bits-band0xffffffffL
  $expected=($vk-ge0x21-and$vk-le0x28)-or$vk-eq0x2d-or$vk-eq0x2e-or($map-band0xff00)-eq0xe000
  $rows+=@{vk=('0x{0:X2}'-f$vk);map=('0x{0:X4}'-f$map);down=$down;lParam=('0x{0:X8}'-f$bits)}
  if((($bits-band0x1000000)-ne0)-ne$expected){$failures+=('extended mismatch vk=0x{0:X2} map=0x{1:X4}'-f$vk,$map)}
  if((($bits-shr16)-band255)-ne($map-band255)){throw 'scan byte changed'}
  if((($bits-shr30)-band3)-ne$(if($down){0}else{3})){throw 'keyup bits changed'}
 }
}
@{native='real MapVirtualKey only; PostMessage recorder';rows=$rows;failures=$failures}|ConvertTo-Json -Depth 5
if($failures.Count){throw ('RED '+($failures-join'; '))}
'PASS actual Windows mapping plus production key construction: main navigation extended, NUMPAD2 distinct, letters/Enter unchanged, keyup bits preserved; no native input.'
