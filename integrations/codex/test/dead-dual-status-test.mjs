// OS PID/birth reads and actual guardian recovery, unique internal namespace.
import assert from 'node:assert/strict'
import {spawn,execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {once} from 'node:events'
import {randomUUID} from 'node:crypto'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises'
const root=process.argv[2]?pathToFileURL(resolve(process.argv[2])+'/'):new URL('../',import.meta.url)
const {DualControlLease}=await import(new URL('lib/dual-control-lease.js',root)),{dualConnection}=await import(new URL('lib/dual-connection.js',root)),{startDualCoordinator}=await import(new URL('lib/dual-coordinator.js',root))
const {DualLaneState}=await import(new URL('lib/dual-lane-state.js',root))
const exec=promisify(execFile),namespace='dead-v3-'+randomUUID(),actors=[]
async function actor(){const p=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});actors.push(p);const {stdout}=await exec('powershell.exe',['-NoProfile','-Command',`$p=[Diagnostics.Process]::GetProcessById(${p.pid});@{pid=$p.Id;birth=$p.StartTime.ToUniversalTime().Ticks.ToString();sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;session=$p.SessionId;local=[Environment]::GetFolderPath('LocalApplicationData')}|ConvertTo-Json -Compress`],{windowsHide:true});return {proc:p,...JSON.parse(stdout)}}
const dead=await actor(),closed=once(dead.proc,'exit');dead.proc.kill();await closed
const directory=join(dead.local,'dsh-independent-input-control','tests',namespace),metadata=join(directory,`test-${namespace}-dsh-independent-input-${dead.sid}-${dead.session}.json`),statePath=metadata.replace(/\.json$/,'.v3.json'),generation=randomUUID()
const identity={pid:dead.pid,birth:dead.birth},gate={protocolVersion:3,kind:'dual-lane-upgrade-gate',generation,guardian:identity,coordinator:identity,executors:[{...identity,role:'lane'}],endpoint:String.raw`\\.\pipe\dsh-dual-`+randomUUID()}
const seed=new DualLaneState();seed.acquire({executionId:'OLD',name:'owned-fixture',actor:identity});seed.bindExecutor('OLD',identity);const state={...seed.data,generation}
await mkdir(directory,{recursive:true});await writeFile(statePath,JSON.stringify(state))
const connection=dualConnection({testNamespace:namespace,headlessTest:true}),lease=new DualControlLease({connection,testNamespace:namespace})
async function observe(value){const text=JSON.stringify(value);await writeFile(metadata,text);const files=await readdir(directory),result=await lease.status('CURRENT');assert.equal(await readFile(metadata,'utf8'),text);assert.deepEqual(await readdir(directory),files);return result}
try{
 let result=await observe(gate);assert.equal(result.canAcquire,true,'dead v3 pipe must expose guarded recovery admission');assert.equal(result.recoveryRequired,true);assert.equal(result.observedDead,true);assert.equal(result.occupied,null);assert.equal(result.reason,'coordinator-recovery-required')
 const live=await actor(),liveId={pid:live.pid,birth:live.birth}
 for(const changed of [{...gate,coordinator:liveId},{...gate,executors:[liveId]},{...gate,coordinator:{pid:live.pid,birth:'unknown'}}]){result=await observe(changed);assert.equal(result.canAcquire,false);assert.notEqual(result.observedDead,true)}
 result=await observe({...gate,coordinator:{pid:live.pid,birth:'1'}});assert.equal(result.observedDead,true,'reliably different birth means old instance dead; never kill current PID')
 const paused=new DualLaneState(structuredClone(state));paused.pauseDesktop({reason:'control-escape',source:'keyboard-hook'});await writeFile(statePath,JSON.stringify(paused.data));result=await observe(gate);assert.equal(result.canAcquire,false);assert.equal(result.desktopPaused,true);await writeFile(statePath,JSON.stringify(state))
 // Positive readonly evidence never replaces the guardian's mutex-held recheck.
 await observe(gate);await writeFile(metadata,JSON.stringify({...gate,executors:[liveId]}));await assert.rejects(startDualCoordinator({testNamespace:namespace,onMembers:async()=>{}}),/old-generation-live-or-unknown/)
 assert.equal(live.proc.exitCode,null)
 await writeFile(metadata,JSON.stringify(gate));const coordinator=await startDualCoordinator({testNamespace:namespace,onMembers:async()=>{}});try{assert.equal(coordinator.state.data.lanes.length,0);assert(coordinator.state.data.halted.OLD.beginRequired)}finally{await coordinator.close()}
 console.log('PASS dead-v3 readonly projection: confirmed dead only, no metadata writes/backend; live/unknown block, mismatched birth safe, global pause retained; actual mutex guardian rechecks and refuses newly live executor before recovery')
}finally{for(const p of actors)if(p.exitCode===null&&p.signalCode===null){const done=once(p,'exit');p.kill();await done};await rm(directory,{recursive:true,force:true})}
