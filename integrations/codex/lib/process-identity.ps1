# Same PID/birth identity rule for read-only observation and locked recovery.
function Get-InputProcessState($value){
  $number=0;$birth=0L
  if(-not$value-or-not[int]::TryParse([string]$value.pid,[ref]$number)-or$number-le0-or$value.birth-isnot[string]-or$value.birth-notmatch'^[0-9]{1,19}$'-or-not[long]::TryParse($value.birth,[ref]$birth)-or$birth-le0-or$birth-gt3155378975999999999){return 'unknown'}
  try{$process=[Diagnostics.Process]::GetProcessById($number)}catch [ArgumentException]{return 'dead'}catch{return 'unknown'}
  try{if($process.StartTime.ToUniversalTime().Ticks.ToString()-ceq$value.birth){return 'alive'};return 'dead'}catch{return 'unknown'}
}
function Get-DeadDualGateObservation([string]$MetadataPath){
  try{
    $before=[IO.File]::ReadAllText($MetadataPath);$gate=$before|ConvertFrom-Json
    if($gate.protocolVersion-ne3-or$gate.kind-ne'dual-lane-upgrade-gate'-or-not$gate.generation-or-not$gate.guardian-or-not$gate.coordinator-or$null-eq$gate.executors){throw 'schema'}
    $states=@(foreach($identity in @($gate.guardian,$gate.coordinator)+@($gate.executors)){Get-InputProcessState $identity})
    if([IO.File]::ReadAllText($MetadataPath)-cne$before){throw 'changed'}
    $state=if($states-contains'unknown'){'unknown'}elseif($states-contains'alive'){'live'}else{'dead'}
    return @{state=$state;observedDead=($state-eq'dead');generation=$gate.generation}
  }catch{return @{state='unknown';observedDead=$false}}
}
