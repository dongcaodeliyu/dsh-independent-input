# Shared short state lock; the existing desktop mutex remains the input lease.
$queuePath=Join-Path $directory "$scope.queue.json"
$stateMutex=New-Object Threading.Mutex($false,"Local\$scope-state")
function Enter-State {try{if(-not $stateMutex.WaitOne(5000)){throw 'control-state-busy'}}catch [Threading.AbandonedMutexException]{}}
function Exit-State {$stateMutex.ReleaseMutex()}
function Write-Atomic($path,$value) {
  $temporary=$path+'.'+$PID+'.tmp'
  [IO.File]::WriteAllText($temporary,($value|ConvertTo-Json -Compress -Depth 12),[Text.UTF8Encoding]::new($false))
  if([IO.File]::Exists($path)){[IO.File]::Replace($temporary,$path,$path+'.bak');[IO.File]::Delete($path+'.bak')}else{[IO.File]::Move($temporary,$path)}
}
function Read-Queue {
  if(-not [IO.File]::Exists($queuePath)){return @{nextSequence=1;version=0;tickets=@()}}
  try{$q=[IO.File]::ReadAllText($queuePath)|ConvertFrom-Json;if($null -eq $q.nextSequence -or $null -eq $q.version -or $null -eq $q.tickets){throw 'schema'};return $q}catch{throw 'control-queue-state-unknown'}
}
function Ticket-Event($ticket) {return [Threading.EventWaitHandle]::new($false,[Threading.EventResetMode]::ManualReset,"Local\$scope-ticket-$($ticket.ticketId)")}
function Signal-Tickets($tickets) {foreach($ticket in @($tickets)){$event=Ticket-Event $ticket;try{$event.Set()|Out-Null}finally{$event.Dispose()}}}
function Save-Queue($q,$oldTickets) {$q.version=[long]$q.version+1;Write-Atomic $queuePath $q;Signal-Tickets (@($oldTickets)+@($q.tickets))}
function Prune-Tickets($q) {
  $before=@($q.tickets);$q.tickets=@($before|Where-Object {(Process-State $_.actor) -ne 'dead' -and (-not $_.expiresUtc -or ([DateTime]$_.expiresUtc).ToUniversalTime() -gt [DateTime]::UtcNow)})
  if($q.tickets.Count -ne $before.Count){Save-Queue $q $before}
}
function Owner-State($old) {
  if($old.state -eq 'absent'){return 'available'}
  if($old.state -eq 'unknown'){return 'unknown'}
  if($old.owner.pauseReason){return 'paused'}
  $guard=Process-State $old.owner;$executor=if($old.owner.executor){Process-State $old.owner.executor}else{'dead'}
  if($guard -eq 'alive' -or $executor -eq 'alive'){return 'busy'}
  if($guard -eq 'unknown' -or $executor -eq 'unknown'){return 'unknown'}
  return 'available'
}
function Identity($value) {
  return @{executionId=$value.executionId;rootId=$value.rootId;name=$value.name;projectId=$value.projectId;projectName=$value.projectName;projectPath=$value.projectPath;projectSource=$value.projectSource}
}
function Queue-Snapshot($q,$id) {
  $old=Read-Record;$state=Owner-State $old;$position=0;$rows=@();$index=0
  foreach($ticket in @($q.tickets)){$index++;if($ticket.executionId -eq $id){$position=$index};$row=Identity $ticket;$row.position=$index;$row.sequence=$ticket.sequence;$row.ticketId=$ticket.ticketId;$row.actorState=Process-State $ticket.actor;$rows+=,$row}
  $owned=$state -ne 'available' -and $old.owner.executionId -eq $id
  $turn=if($owned){'owned'}elseif($position -eq 1 -and $state -eq 'available'){'ready'}elseif($position -gt 0){'queued'}else{'not-queued'}
  return @{owner=if($state -eq 'available'){$null}else{$old.owner};state=$state;lastStop=$old.owner.lastStop;scope=$scope;queue=$rows;position=$position;turn=$turn;queueVersion=$q.version;canAcquire=($state -eq 'available' -and ($rows.Count -eq 0 -or $position -eq 1))}
}
function Update-OwnerReminder($q) {
  $old=Read-Record
  if($old.state -eq 'present' -and $old.owner.leaseId -and (Owner-State $old) -ne 'available'){
    $old.owner.reminderPending=(@($q.tickets).Count -gt 0 -and -not $old.owner.reminderClaimed)
    if($old.owner.reminderPending){$old.owner.reminderStatus='queued'}
    Write-Atomic $metadata $old.owner
  }
}
function Enqueue-Locked($q,$identity) {
  $old=Read-Record
  if((Owner-State $old) -ne 'available' -and $old.owner.executionId -eq $identity.executionId){return}
  $existing=@($q.tickets|Where-Object {$_.executionId -eq $identity.executionId})
  if($existing.Count){$existing[0].expiresUtc=[DateTime]::UtcNow.AddSeconds(120).ToString('o');Save-Queue $q @($q.tickets);return}
  $actorProcess=[Diagnostics.Process]::GetProcessById([int]$identity.actorPid)
  $ticket=Identity $identity;$ticket.ticketId=[Guid]::NewGuid().ToString('N');$ticket.sequence=[long]$q.nextSequence
  $ticket.actor=@{pid=$actorProcess.Id;birth=$actorProcess.StartTime.ToUniversalTime().Ticks.ToString()}
  $ticket.expiresUtc=[DateTime]::UtcNow.AddSeconds(120).ToString('o')
  $q.nextSequence=[long]$q.nextSequence+1;$before=@($q.tickets);$q.tickets=@($before)+@($ticket)
  Save-Queue $q $before;Update-OwnerReminder $q
}
function Invoke-ControlOperation($operation,$identity,$waitMs) {
  if($operation -ne 'status' -and -not $identity.executionId){throw 'trusted-execution-required'}
  $deadline=[DateTime]::UtcNow.AddMilliseconds([Math]::Max(0,[Math]::Min(45000,$waitMs)))
  $registered=$false
  do {
    $waitEvent=$null
    Enter-State
    try {
      $q=Read-Queue
      if($operation -ne 'status'){Prune-Tickets $q}
      switch($operation){
        'request' {Enqueue-Locked $q $identity}
        'wait' {if(-not $registered){Enqueue-Locked $q $identity;$registered=$true}}
        'cancel' {$oldTickets=@($q.tickets);$q.tickets=@($oldTickets|Where-Object {$_.executionId -ne $identity.executionId});Save-Queue $q $oldTickets;Update-OwnerReminder $q}
        'disconnect' {$oldTickets=@($q.tickets);$q.tickets=@($oldTickets|Where-Object {-not ($_.executionId -eq $identity.executionId -and $_.actor.pid -eq $identity.actorPid)});Save-Queue $q $oldTickets;Update-OwnerReminder $q}
        'claim' {
          $old=Read-Record;$notice=$null
          if($old.owner.executionId -eq $identity.executionId -and $old.owner.leaseId -and (Owner-State $old) -ne 'available' -and @($q.tickets).Count -gt 0 -and -not $old.owner.reminderClaimed){
            $old.owner.reminderClaimed=$true;$old.owner.reminderPending=$false;$old.owner.reminderStatus='unknown';Write-Atomic $metadata $old.owner
            $notice=@{leaseId=$old.owner.leaseId;delivery='unknown';text='做完本次桌面任务请finish，后面有排队；无需中断当前任务。'}
          }
          return @{notice=$notice}
        }
        'delivered' {$old=Read-Record;if($old.owner.executionId -eq $identity.executionId -and $old.owner.leaseId -eq $identity.noticeLeaseId -and $old.owner.reminderClaimed){$old.owner.reminderStatus='delivered-to-tool';Write-Atomic $metadata $old.owner};return @{ok=$true}}
      }
      $snapshot=Queue-Snapshot $q $identity.executionId
      if($operation -ne 'wait'){return $snapshot}
      if($snapshot.turn -in @('ready','owned')){$snapshot.waitResult='ready';return $snapshot}
      if($snapshot.position -eq 0){$snapshot.waitResult='cancelled';return $snapshot}
      $remaining=[int]($deadline-[DateTime]::UtcNow).TotalMilliseconds
      if($remaining -le 0){$snapshot.waitResult='timeout';return $snapshot}
      $ticket=@($q.tickets|Where-Object {$_.executionId -eq $identity.executionId})[0]
      $waitEvent=Ticket-Event $ticket;$waitEvent.Reset()|Out-Null
    } finally {Exit-State}
    # Named events wake immediately on writes/releases. Process death and ticket
    # expiry have no writer, so bound the internal readonly/liveness recheck.
    # This never expires an actual holder or clears the global pause latch.
    try {$waitEvent.WaitOne([Math]::Min(250,$remaining))|Out-Null}finally{$waitEvent.Dispose()}
  } while($true)
}
