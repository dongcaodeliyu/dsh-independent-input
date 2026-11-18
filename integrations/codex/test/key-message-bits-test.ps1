# Executes production PostKey with fake MapVirtualKey/PostMessage, no OS input.
$ErrorActionPreference='Stop'
$s=[IO.File]::ReadAllText((Join-Path $PSScriptRoot '../sidecar.ps1'))
$start=$s.IndexOf('    public static void PostKey(');$end=$s.IndexOf('    public static void PostText(',$start)
$method=$s.Substring($start,$end-$start)
$helperStart=$s.IndexOf('    public static int KeyMessageLParam(')
if($helperStart-ge0){$method=$s.Substring($helperStart,$start-$helperStart)+$method}
$prefix=@'
using System;
public static class KeyBits {
 const int WM_KEYDOWN=0x100,WM_KEYUP=0x101,WM_SYSKEYDOWN=0x104,WM_SYSKEYUP=0x105;
 public static bool Paused;public static uint LastMapType,Message;public static int Calls;public static long Bits;
 public static void CheckNotPaused(){if(Paused)throw new Exception("paused");}
 public static uint MapVirtualKey(uint vk,uint type){LastMapType=type;uint scan=vk==0x28||vk==0x62?0x50u:vk==0x24?0x47u:vk==0x2e?0x53u:vk==0x41?0x1eu:vk==0x0d?0x1cu:0x1du;if(type==4&&(vk==0x28||vk==0x24||vk==0x2e))scan|=0xe000;if(type==4&&vk==0x13)scan|=0xe100;return scan;}
 public static bool PostMessage(IntPtr hwnd,uint message,IntPtr key,IntPtr bits){Calls++;Message=message;Bits=bits.ToInt64();return true;}
'@
Add-Type -TypeDefinition ($prefix+$method+'}')
$cases=@(@{vk=0x28;scan=0x50;extended=$true},@{vk=0x62;scan=0x50;extended=$false},@{vk=0x24;scan=0x47;extended=$true},@{vk=0x2e;scan=0x53;extended=$true},@{vk=0x41;scan=0x1e;extended=$false},@{vk=0x0d;scan=0x1c;extended=$false},@{vk=0x13;scan=0x1d;extended=$false})
foreach($case in $cases){foreach($down in @($true,$false)){
 [KeyBits]::PostKey([IntPtr]1,$case.vk,$down,$false,$false)
 $bits=[KeyBits]::Bits-band0xffffffffL
 if((($bits-shr24)-band1)-ne[int]$case.extended-or(($bits-shr16)-band255)-ne$case.scan){throw ('RED key scan/extended mismatch vk='+$case.vk)}
 if((($bits-shr30)-band3)-ne$(if($down){0}else{3})){throw 'keyup previous/transition bits'}
}}
[KeyBits]::PostKey([IntPtr]1,0x0d,$true,$true,$false);if(([KeyBits]::Bits-band0x1000000)-eq0){throw 'explicit extended lost'}
if(([KeyBits]::KeyMessageLParam(0x13,0xe11d,$true,$false)-band0x1000000)-ne0){throw 'E1 must not imply E0'}
if(([KeyBits]::KeyMessageLParam(0x41,0xe01e,$true,$false)-band0x1000000)-eq0){throw 'explicit E0 mapping lost'}
[KeyBits]::Paused=$true;$before=[KeyBits]::Calls
try{[KeyBits]::PostKey([IntPtr]1,0x28,$true,$false,$false);throw 'paused down accepted'}catch{if([KeyBits]::Calls-ne$before){throw 'paused down sent'}}
[KeyBits]::PostKey([IntPtr]1,0x28,$false,$false,$false);if([KeyBits]::Calls-ne$before+1){throw 'paused key release blocked'}
if([KeyBits]::LastMapType-ne4){throw 'extended mapping not requested'}
'PASS actual PostKey construction: DOWN vs NUMPAD2, HOME/DELETE, A/ENTER, E1 Pause not E0, explicit extended, keyup bits and paused release; fake native calls only'
