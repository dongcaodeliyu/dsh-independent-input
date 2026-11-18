param([string]$OwnerJson,[switch]$ReadOnly,[string]$TestNamespace,[string]$Operation='acquire',[int]$WaitMs=45000)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
$owner=if($OwnerJson){$OwnerJson | ConvertFrom-Json}else{$null}
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$session=[Diagnostics.Process]::GetCurrentProcess().SessionId
$scope="dsh-independent-input-$sid-$session"
$directory=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'dsh-independent-input-control'
if($TestNamespace) {
  if($TestNamespace -notmatch '^[a-zA-Z0-9-]{1,80}$'){throw 'invalid internal test namespace'}
  $scope='test-'+$TestNamespace+'-'+$scope
  $directory=Join-Path $directory ('tests/'+$TestNamespace)
}
$metadata=Join-Path $directory "$scope.json"
$held=$false; $published=$false; $released=$false; $acquiringState=$false; $record=$null; $executor=$null
function Process-State($value) {
  if(-not $value -or -not $value.pid -or -not $value.birth){return 'unknown'}
  try {$p=[Diagnostics.Process]::GetProcessById([int]$value.pid)}
  catch [ArgumentException] {return 'dead'}
  catch {return 'unknown'}
  try {if($p.StartTime.ToUniversalTime().Ticks.ToString() -eq $value.birth){return 'alive'};return 'dead'} catch {return 'unknown'}
}
function Read-Record {
  if(-not [IO.File]::Exists($metadata)){return @{state='absent';owner=$null}}
  try {
    $value=[IO.File]::ReadAllText($metadata) | ConvertFrom-Json
    if(-not $value.executionId -or -not $value.pid -or -not $value.birth){return @{state='unknown';owner=$null}}
    return @{state='present';owner=$value}
  }catch{return @{state='unknown';owner=$null}}
}
function Write-Record {
  Enter-State
  try {
    $fresh=Read-Record
    if($record.leaseId -and $fresh.owner.leaseId -eq $record.leaseId){$record.reminderClaimed=$fresh.owner.reminderClaimed;$record.reminderStatus=$fresh.owner.reminderStatus}
    $q=Read-Queue;$record.reminderPending=(@($q.tickets).Count -gt 0 -and -not $record.reminderClaimed)
    Write-Atomic $metadata $record
  } finally {Exit-State}
}
function Send($value) { [Console]::Out.WriteLine(($value | ConvertTo-Json -Compress -Depth 8)); [Console]::Out.Flush() }
. (Join-Path $PSScriptRoot 'control-state.ps1')
if($ReadOnly){$Operation='status'}
if($Operation -ne 'acquire'){
  try {if($Operation -ne 'status'){[IO.Directory]::CreateDirectory($directory)|Out-Null};Send (Invoke-ControlOperation $Operation $owner $WaitMs)}finally{$stateMutex.Dispose()}
  exit 0
}
[IO.Directory]::CreateDirectory($directory) | Out-Null
$mutex=New-Object Threading.Mutex($false,"Local\$scope")
$reader=[IO.StreamReader]::new([Console]::OpenStandardInput(),[Text.UTF8Encoding]::new($false))
try {
  try {$held=$mutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$held=$true}
  Enter-State;$acquiringState=$true
  $q=Read-Queue;Prune-Tickets $q
  $old=Read-Record
  if(-not $held){if($owner.intent -eq 'begin'){Enqueue-Locked $q $owner};Send @{ok=$false;reason='control-busy';owner=$old.owner;scope=$scope;queueState=(Queue-Snapshot $q $owner.executionId)};exit 0}
  if($old.state -eq 'unknown'){Send @{ok=$false;reason='control-state-unknown-repair-required';owner=$null;scope=$scope};exit 0}
  if($old.owner -and $old.owner.executor) {
    $executorState=Process-State $old.owner.executor
    if($executorState -ne 'dead'){Send @{ok=$false;reason=if($executorState -eq 'alive'){'old-executor-still-alive'}else{'old-executor-state-unknown'};owner=$old.owner;scope=$scope};exit 0}
  }
  if($old.owner -and $old.owner.pauseReason -and $old.owner.executionId -ne $owner.executionId -and $owner.intent -ne 'resume'){Send @{ok=$false;reason='control-paused';owner=$old.owner;scope=$scope};exit 0}
  $continuingPause=$old.owner.pauseReason -and $old.owner.executionId -eq $owner.executionId -and $owner.intent -eq 'resume'
  if(@($q.tickets).Count -gt 0 -and -not $continuingPause){
    if($q.tickets[0].executionId -ne $owner.executionId){if($owner.intent -eq 'begin'){Enqueue-Locked $q $owner};Send @{ok=$false;reason='control-queue-turn';owner=$null;queueState=(Queue-Snapshot $q $owner.executionId)};exit 0}
    if($owner.intent -notin @('begin','resume')){Send @{ok=$false;reason='control-ready-begin-required';owner=$null;queueState=(Queue-Snapshot $q $owner.executionId)};exit 0}
  }
  $oldTickets=@($q.tickets);$q.tickets=@($oldTickets|Where-Object {$_.executionId -ne $owner.executionId});Save-Queue $q $oldTickets
  $record=@{executionId=$owner.executionId;rootId=$owner.rootId;name=$owner.name;actorKind=$owner.actorKind;projectId=$owner.projectId;projectName=$owner.projectName;projectPath=$owner.projectPath;projectSource=$owner.projectSource;leaseId=[Guid]::NewGuid().ToString('N');reminderClaimed=$false;reminderStatus='not-needed';pid=$PID;birth=[Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().Ticks.ToString();scope=$scope;pauseReason=if($old.owner){$old.owner.pauseReason}else{$null}}
  $record.stopInfo=$old.owner.stopInfo;$record.lastStop=$old.owner.lastStop;$record.lastTransition=$old.owner.lastTransition
  Write-Record; $published=$true; Send @{ok=$true;owner=$record;scope=$scope;queueState=(Queue-Snapshot $q $owner.executionId)}
  Exit-State;$acquiringState=$false
  while($null -ne ($line=$reader.ReadLine())) {
    $message=$line | ConvertFrom-Json
    if($message.cmd -eq 'bind') {
      $candidate=[Diagnostics.Process]::GetProcessById([int]$message.pid)
      $executor=@{pid=$candidate.Id;birth=$candidate.StartTime.ToUniversalTime().Ticks.ToString()}
      $record.executor=$executor;Write-Record;Send @{ok=$true;executor=$executor}
    } elseif($message.cmd -eq 'pause') {
      if(-not $record.pauseReason -or ($message.stopInfo.sessionId -and $message.stopInfo.sessionId -eq $record.stopInfo.sessionId -and $message.stopInfo.sequence -gt $record.stopInfo.sequence) -or ($message.stopInfo.utcTimestamp -and $record.stopInfo.utcTimestamp -and [DateTime]$message.stopInfo.utcTimestamp -lt [DateTime]$record.stopInfo.utcTimestamp)){$record.pauseReason=if($message.stopInfo.reason){$message.stopInfo.reason}else{[string]$message.reason};$record.stopInfo=$message.stopInfo;$record.lastStop=$message.stopInfo}
      $record.lastTransition=@{reason=$message.reason;source='node-pause-forward';utcTimestamp=[DateTime]::UtcNow.ToString('o')};Write-Record;Send @{ok=$true}
    } elseif($message.cmd -eq 'fault'){
      if(-not $record.pauseReason){$record.lastStop=$message.stopInfo};$record.lastTransition=$message.stopInfo;Write-Record;Send @{ok=$true}
    } elseif($message.cmd -eq 'resume') {
      $record.pauseReason=$null;$record.stopInfo=$null;Write-Record;Send @{ok=$true}
    } elseif($message.cmd -eq 'release') {
      if($record.pauseReason){Send @{ok=$false;reason='control-paused'};continue}
      $released=$true;Send @{ok=$true};break
    }
  }
  if($null -eq $line) {
    # EOF is a host stop, not proof that this exact executor has stopped.
    if(-not $record.pauseReason){$record.pauseReason='transport-eof';$record.stopInfo=@{reason='transport-eof';source='transport-eof';kind='pause';utcTimestamp=[DateTime]::UtcNow.ToString('o');ownerExecutionId=$record.executionId;ownerRootId=$record.rootId;ownerName=$record.name;sessionId=$record.birth;sequence=1};$record.lastStop=$record.stopInfo;Write-Record}
    while($executor -and (Process-State $executor) -ne 'dead'){[Threading.Thread]::Sleep(250)}
  }
} finally {
  if($acquiringState){Exit-State;$acquiringState=$false}
  if($held) {
    Enter-State
    try {
    if($published -and $released -and -not $record.pauseReason){if($record.lastStop){$record.executor=$null;try{Write-Record}catch{}}else{try {[IO.File]::Delete($metadata)}catch{}}}
    elseif($published -and $record.pauseReason){try {Write-Record}catch{}}
    $mutex.ReleaseMutex();Signal-Tickets (Read-Queue).tickets
    } finally {Exit-State}
  }
  $mutex.Dispose();$stateMutex.Dispose()
}
