// Real legacy metadata and OS PID/birth reads; isolated namespace only.
// Status must not launch a coordinator, acquire an input lease or rewrite files.
import assert from 'node:assert/strict'
import {execFile,spawn} from 'node:child_process'
import {promisify} from 'node:util'
import {once} from 'node:events'
import {randomUUID} from 'node:crypto'
import {join} from 'node:path'
import {mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises'
import {DualControlLease} from '../lib/dual-control-lease.js'
import {dualConnection} from '../lib/dual-connection.js'
import {startDualCoordinator} from '../lib/dual-coordinator.js'
import {presentControl} from '../lib/presentation.js'
const exec=promisify(execFile),namespace='ls-'+randomUUID()
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'})
const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',`$p=[Diagnostics.Process]::GetProcessById(${child.pid});@{sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;session=[Diagnostics.Process]::GetCurrentProcess().SessionId;local=[Environment]::GetFolderPath('LocalApplicationData');birth=$p.StartTime.ToUniversalTime().Ticks.ToString()}|ConvertTo-Json -Compress`],{windowsHide:true})
const native=JSON.parse(stdout),directory=join(native.local,'dsh-independent-input-control','tests',namespace),metadata=join(directory,`test-${namespace}-dsh-independent-input-${native.sid}-${native.session}.json`)
await mkdir(directory,{recursive:true})
const connection=dualConnection({testNamespace:namespace,headlessTest:true}),lease=new DualControlLease({connection,testNamespace:namespace})
async function observe(record){const text=JSON.stringify(record);await writeFile(metadata,text);const files=await readdir(directory),result=await lease.status('CURRENT');assert.equal(await readFile(metadata,'utf8'),text);assert.deepEqual(await readdir(directory),files);return result}
try{
 const record={executionId:'LEGACY',name:'owned legacy fixture',pid:child.pid,birth:native.birth,executor:{pid:child.pid,birth:native.birth},pauseReason:null,lastStop:{kind:'fault',reason:'owned historical fault'}}
 let result=await observe({...record,executionId:'CURRENT'});assert.equal(result.canAcquire,false,'old owned identity must not imply admission')
 result=await observe({...record,birth:'1'});assert.equal(result.canAcquire,false,'live executor remains busy even when old guardian is dead')
 result=await observe(record);assert.equal(result.busy,true);assert.equal(result.canAcquire,false);assert.equal(result.migrationState,'legacy-live')
 result=await observe({...record,birth:null});assert.equal(result.busy,null);assert.equal(result.canAcquire,false);assert.ok(result.observationError)
 result=await observe({...record,birth:'unknown'});assert.equal(result.busy,null);assert.equal(result.canAcquire,false)
 const closed=once(child,'exit');child.kill();await closed
 result=await observe(record);assert.equal(result.busy,false);assert.equal(result.canAcquire,true);assert.equal(result.migrationState,'legacy-dead-upgrade-ready');assert.equal(result.capacity,3);assert.equal(result.occupied,0);assert.equal(result.availableSlots,3)
 assert.equal(presentControl(result).migrationState,'legacy-dead-upgrade-ready')
 const queuePath=metadata.replace(/\.json$/,'.queue.json'),queueText=JSON.stringify({version:1,nextSequence:3,tickets:[{executionId:'FIRST',sequence:1,actor:{pid:process.pid,birth:'unknown'}},{executionId:'CURRENT',sequence:2,actor:{pid:process.pid,birth:'unknown'}}]});await writeFile(queuePath,queueText)
 result=await observe(record);assert.equal(result.canAcquire,false);assert.equal(result.position,2);assert.equal(result.busy,true);assert.equal(result.migrationState,'legacy-queue-present');assert.equal(await readFile(queuePath,'utf8'),queueText);await rm(queuePath)

 result=await observe({...record,pauseReason:'control-escape',stopInfo:{kind:'pause',source:'keyboard-hook'}});assert.equal(result.canAcquire,false);assert.equal(result.migrationState,'legacy-paused')
 await writeFile(metadata,JSON.stringify(record));const coordinator=await startDualCoordinator({testNamespace:namespace,onMembers:async()=>{}});try{assert.equal(JSON.parse(await readFile(metadata,'utf8')).protocolVersion,3);assert.equal(coordinator.state.data.lanes.length,0)}finally{await coordinator.close()}
 console.log('PASS real isolated legacy dead/live/unknown/paused status: no file mutation or coordinator/backend launch; dead record admits guarded metadata-only migration, actual guardian upgrades under mutex with zero lanes; legacy queue stays unmigrated, live/unknown/paused remain blocked.')
}finally{if(child.exitCode===null&&child.signalCode===null){const closed=once(child,'exit');child.kill();await closed};await rm(directory,{recursive:true,force:true})}
