$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '../lib/process-identity.ps1')
$self=[Diagnostics.Process]::GetCurrentProcess();$identity=@{pid=$PID;birth=$self.StartTime.ToUniversalTime().Ticks.ToString()}
if((Get-InputProcessState $identity)-ne'alive'){throw 'own process identity unreadable'}
if((Get-InputProcessState @{pid=$PID;birth='1'})-ne'dead'){throw 'old birth mismatch not dead'}
foreach($birth in @('unknown',$null,'0','99999999999999999999')){if((Get-InputProcessState @{pid=$PID;birth=$birth})-ne'unknown'){throw 'invalid birth classified dead'}}
$path=Join-Path ([IO.Path]::GetTempPath()) ('identity-'+[Guid]::NewGuid().ToString('N')+'.json')
try{
 @{protocolVersion=3;kind='dual-lane-upgrade-gate';generation='owned-test';guardian=$identity;coordinator=$identity;executors=@($identity)}|ConvertTo-Json -Depth 5|Set-Content -LiteralPath $path -Encoding UTF8
 $before=[IO.File]::ReadAllBytes($path)
 # Native query-denied seam: production observer must preserve unknown, never
 # coerce a failed identity query into dead. No OS permission is changed.
 function Get-InputProcessState($value){return 'unknown'}
 $r=Get-DeadDualGateObservation $path
 if($r.observedDead-or$r.state-ne'unknown'){throw 'query failure admitted recovery'}
 if([Convert]::ToBase64String($before)-cne[Convert]::ToBase64String([IO.File]::ReadAllBytes($path))){throw 'observer mutated metadata'}
 'PASS own OS identity/mismatched birth, malformed birth unknown; injected query-denied stays unknown and read-only (not an actual OS denial)'
}finally{Remove-Item -LiteralPath $path -Force}
