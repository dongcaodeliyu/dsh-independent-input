param([Parameter(Mandatory=$true)][int]$CoordinatorPid,[string]$TestNamespace,[switch]$TestAssignFailureOnce,[string]$StateStamp='absent')
# Dedicated legacy-mutex/Job lifetime owner. It never creates UI or sends input.
$ErrorActionPreference='Stop'
$laneCapacity=(Get-Content -LiteralPath (Join-Path $PSScriptRoot 'dual-capacity.json') -Raw | ConvertFrom-Json).laneCapacity
if($laneCapacity -isnot [int] -and $laneCapacity -isnot [long] -or $laneCapacity -lt 1){throw 'invalid lane capacity'}
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public sealed class DualExecutorJob : IDisposable {
 [StructLayout(LayoutKind.Sequential)] struct Basic {public long ProcessTime,JobTime;public uint Flags;public UIntPtr Min,Max;public uint Active;public UIntPtr Affinity;public uint Priority,Scheduling;}
 [StructLayout(LayoutKind.Sequential)] struct Io {public ulong ReadOps,WriteOps,OtherOps,ReadBytes,WriteBytes,OtherBytes;}
 [StructLayout(LayoutKind.Sequential)] struct Extended {public Basic Basic;public Io Io;public UIntPtr ProcessMemory,JobMemory,PeakProcess,PeakJob;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr attributes,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref Extended value,uint length);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool result);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h,uint flags);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 IntPtr handle;
 public DualExecutorJob(){handle=CreateJobObjectW(IntPtr.Zero,null);if(handle==IntPtr.Zero)throw new System.ComponentModel.Win32Exception();var limits=new Extended();limits.Basic.Flags=0x2000;if(!SetInformationJobObject(handle,9,ref limits,(uint)Marshal.SizeOf(typeof(Extended)))){int e=Marshal.GetLastWin32Error();Dispose();throw new System.ComponentModel.Win32Exception(e);}}
 public void Assign(int pid){IntPtr process=OpenProcess(0x101,false,pid);if(process==IntPtr.Zero)throw new System.ComponentModel.Win32Exception();try{if(!AssignProcessToJobObject(handle,process))throw new System.ComponentModel.Win32Exception();}finally{CloseHandle(process);}}
 public bool Contains(int pid){IntPtr process=OpenProcess(0x1000,false,pid);if(process==IntPtr.Zero)throw new System.ComponentModel.Win32Exception();try{bool result;if(!IsProcessInJob(process,handle,out result))throw new System.ComponentModel.Win32Exception();return result;}finally{CloseHandle(process);}}
 public void Terminate(){if(!TerminateJobObject(handle,74))throw new System.ComponentModel.Win32Exception();}
 public void Dispose(){if(handle!=IntPtr.Zero){CloseHandle(handle);handle=IntPtr.Zero;}}
}
'@
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$session=[Diagnostics.Process]::GetCurrentProcess().SessionId
$scope="dsh-independent-input-$sid-$session";$directory=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'dsh-independent-input-control'
if($TestNamespace){if($TestNamespace-notmatch'^[a-zA-Z0-9-]{1,80}$'){throw 'invalid internal test namespace'};$scope='test-'+$TestNamespace+'-'+$scope;$directory=Join-Path $directory ('tests/'+$TestNamespace)}
if($TestAssignFailureOnce-and-not$TestNamespace){throw 'internal assign failure seam requires test namespace'}
$metadata=Join-Path $directory "$scope.json"
function Send($value){[Console]::Out.WriteLine(($value|ConvertTo-Json -Compress -Depth 12));[Console]::Out.Flush()}
function Identity($number){$p=[Diagnostics.Process]::GetProcessById([int]$number);return @{pid=$p.Id;birth=$p.StartTime.ToUniversalTime().Ticks.ToString()}}
. (Join-Path $PSScriptRoot 'process-identity.ps1')
function Life($value){Get-InputProcessState $value}
function Save-Gate {
 $temp=$metadata+'.'+$PID+'.tmp';[IO.File]::WriteAllText($temp,($script:gate|ConvertTo-Json -Depth 12 -Compress),[Text.UTF8Encoding]::new($false))
 if([IO.File]::Exists($metadata)){[IO.File]::Replace($temp,$metadata,$metadata+'.bak');[IO.File]::Delete($metadata+'.bak')}else{[IO.File]::Move($temp,$metadata)}
}
$mutex=[Threading.Mutex]::new($false,"Local\$scope");$held=$false;$job=$null;$normal=$false;$gate=$null;$jobTerminated=$false;$stage='legacy-mutex'
try{
 try{$held=$mutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$held=$true}
 if(-not$held){Send @{ok=$false;reason='legacy-or-coordinator-busy'};return}
 $stage='read-gate';$recovered=$null
 if([IO.File]::Exists($metadata)){
  try{$old=[IO.File]::ReadAllText($metadata)|ConvertFrom-Json}catch{Send @{ok=$false;reason='control-state-unknown-repair-required'};return}
  if($old.protocolVersion-eq3-and$old.kind-eq'dual-lane-upgrade-gate'){
   if(-not$old.guardian-or-not$old.coordinator-or$null-eq$old.executors){Send @{ok=$false;reason='incomplete-dual-gate'};return}
   foreach($identity in @($old.guardian,$old.coordinator)+@($old.executors)){if((Life $identity)-ne'dead'){Send @{ok=$false;reason='old-generation-live-or-unknown'};return}}
   $recovered=$old
  }elseif($old.executionId-and$old.pid-and$old.birth){
   if((Life $old)-ne'dead'-or($old.executor-and(Life $old.executor)-ne'dead')){Send @{ok=$false;reason='old-executor-live-or-unknown'};return}
   if($old.pauseReason){Send @{ok=$false;reason='legacy-paused-requires-original-resume'};return}
  }else{Send @{ok=$false;reason='control-state-unknown-repair-required'};return}
 }
 $stage='verify-state-stamp'
 try{
  $stateFile=Join-Path $directory "$scope.v3.json";$actual='absent'
  if([IO.File]::Exists($stateFile)){$hash=[Security.Cryptography.SHA256]::Create();try{$actual=[BitConverter]::ToString($hash.ComputeHash([IO.File]::ReadAllBytes($stateFile))).Replace('-','').ToLowerInvariant()}finally{$hash.Dispose()}}
  if($StateStamp-notmatch'^(absent|[0-9a-f]{64})$'-or$actual-cne$StateStamp){Send @{ok=$false;reason='dual-state-changed-before-lock'};return}
 }catch{Send @{ok=$false;reason='dual-state-unknown'};return}
 $stage='publish-gate';[IO.Directory]::CreateDirectory($directory)|Out-Null
 $stage='guardian-identity';$guardianIdentity=Identity $PID
 $stage='coordinator-identity';$coordinatorIdentity=Identity $CoordinatorPid
 $gate=@{protocolVersion=3;kind='dual-lane-upgrade-gate';generation=[Guid]::NewGuid().ToString('N');guardian=$guardianIdentity;coordinator=$coordinatorIdentity;executors=@();recoveredGeneration=$recovered.generation;recoveryPaused=($null-ne$recovered);scope=$scope}
 # Publish fail-closed legacy gate before creating a Job or acknowledging start.
 $stage='save-gate';Save-Gate;$stage='create-job';$job=New-Object DualExecutorJob
 Send @{ok=$true;scope=$scope;gate=$gate;statePath=(Join-Path $directory "$scope.v3.json")}
 while($null-ne($line=[Console]::ReadLine())){
  $message=$line|ConvertFrom-Json
  if($message.cmd-eq'bind'){
   try{
    if($jobTerminated){if(@($gate.executors|Where-Object {(Life $_)-ne'dead'}).Count){Send @{ok=$false;reason='fault-executors-not-dead'};continue};$job.Dispose();$job=New-Object DualExecutorJob;$jobTerminated=$false}
    $identity=Identity $message.pid
    $role=if($message.role-eq'header'){'header'}else{'lane'}
    $existing=@($gate.executors|Where-Object {$_.pid-eq$identity.pid-and$_.birth-eq$identity.birth})
    if($existing.Count-and$existing[0].assigned){if($job.Contains([int]$identity.pid)){Send @{ok=$true;executor=$identity};continue};Send @{ok=$false;reason='executor-job-membership-unconfirmed'};continue}
    $limit=if($role-eq'header'){1}else{$laneCapacity}
    if(@($gate.executors|Where-Object {(Life $_)-ne'dead'-and$_.role-eq$role-and-not($_.pid-eq$identity.pid-and$_.birth-eq$identity.birth)}).Count-ge$limit){Send @{ok=$false;reason='executor-capacity'};continue}
    # Persist identity before assignment/ack; abnormal recovery never assumes
    # an unrecorded assigned executor is gone.
    $entry=@{pid=$identity.pid;birth=$identity.birth;assigned=$false;role=$role}
    $gate.executors=@($gate.executors|Where-Object {(Life $_)-ne'dead'-and-not($_.pid-eq$identity.pid-and$_.birth-eq$identity.birth)})+@($entry);Save-Gate
    if($TestAssignFailureOnce){$TestAssignFailureOnce=$false;throw 'isolated forced assignment failure'}
    $job.Assign([int]$identity.pid)
    if(-not$job.Contains([int]$identity.pid)){throw 'job membership unconfirmed'}
    $entry.assigned=$true;Save-Gate;Send @{ok=$true;executor=$identity}
   }catch{$inner=$_.Exception.InnerException;Send @{ok=$false;reason='executor-job-bind-failed';errorType=$_.Exception.GetType().Name;nativeError=if($inner){$inner.NativeErrorCode}else{$null};innerType=if($inner){$inner.GetType().Name}else{$null}}}
  }elseif($message.cmd-eq'controller-fault'){
   $job.Terminate();$jobTerminated=$true
   $gate.controllerFault=$message.stopInfo;$gate.originalStopInfo=$message.originalStopInfo
   $stored=$true;try{Save-Gate}catch{$stored=$false}
   Send @{ok=$true;terminationRequested=$true;metadataPersisted=$stored}
  }elseif($message.cmd-eq'signal-pause'){
   if([string]$message.name-notmatch'^Local\\dsh-dual-pause-[a-f0-9-]+$'){Send @{ok=$false;reason='invalid-pause-event'};continue}
   $event=[Threading.EventWaitHandle]::new($false,[Threading.EventResetMode]::AutoReset,[string]$message.name)
   try{$event.Set()|Out-Null;Send @{ok=$true}}finally{$event.Dispose()}
  }elseif($message.cmd-eq'publish-endpoint'){
   if([string]$message.endpoint-notmatch'^\\\\\.\\pipe\\dsh-dual-[a-f0-9-]+$'){Send @{ok=$false;reason='invalid-coordinator-endpoint'};continue}
   $gate.endpoint=[string]$message.endpoint;Save-Gate;Send @{ok=$true}
  }elseif($message.cmd-eq'life'){
   Send @{ok=$true;state=(Life $message.identity)}
  }elseif($message.cmd-eq'identity'){
   try{Send @{ok=$true;identity=(Identity $message.pid)}}catch{Send @{ok=$false;reason='process-identity-unavailable'}}
  }elseif($message.cmd-eq'root'){
   $h=[IntPtr][long]$message.hwnd
   if(-not[DualExecutorJob]::IsWindow($h)){Send @{ok=$false;reason='target-hwnd-invalid'};continue}
   $root=[DualExecutorJob]::GetAncestor($h,2);$windowPid=[uint32]0;[DualExecutorJob]::GetWindowThreadProcessId($root,[ref]$windowPid)|Out-Null
   try{$identity=Identity $windowPid;Send @{ok=$true;target=@{hwnd=$root.ToInt64();pid=$identity.pid;birth=$identity.birth}}}catch{Send @{ok=$false;reason='target-identity-unavailable'}}
  }elseif($message.cmd-eq'release'){
   if(@($gate.executors|Where-Object {(Life $_)-ne'dead'}).Count){Send @{ok=$false;reason='executor-stop-unconfirmed'};continue}
   $normal=$true;Send @{ok=$true};break
  }else{Send @{ok=$false;reason='unsupported-guardian-command'}}
 }
}catch{Send @{ok=$false;reason='guardian-fault';errorType=$_.Exception.GetType().Name;innerType=if($_.Exception.InnerException){$_.Exception.InnerException.GetType().Name}else{$null};stage=$stage;nativeError=$_.Exception.InnerException.NativeErrorCode}}
finally{
 # Closing the Job stops only assigned plugin executors. The legacy gate stays
 # on abnormal exit even if mutex abandonment precedes process termination.
 if($job){$job.Dispose()}
 if($held){if($normal){[IO.File]::Delete($metadata)};$mutex.ReleaseMutex()};$mutex.Dispose()
}
