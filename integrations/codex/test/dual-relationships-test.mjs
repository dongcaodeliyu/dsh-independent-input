// Isolated metadata: real dead gate identities, never an input/GUI executor.
import assert from 'node:assert/strict'
import {spawn,execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {once} from 'node:events'
import {randomUUID} from 'node:crypto'
import {writeFile,readFile,mkdir,rm} from 'node:fs/promises'
import {dirname} from 'node:path'
import {DualLaneState} from '../lib/dual-lane-state.js'
import {dualControlPaths,readDualPersistence} from '../lib/dual-persistence.js'
const exec=promisify(execFile),namespace='relations-'+randomUUID(),{metadata}=await dualControlPaths(namespace),statePath=metadata.replace(/\.json$/,'.v3.json'),child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'})
const {stdout}=await exec('powershell.exe',['-NoProfile','-Command',`$p=[Diagnostics.Process]::GetProcessById(${child.pid});@{pid=$p.Id;birth=$p.StartTime.ToUniversalTime().Ticks.ToString()}|ConvertTo-Json -Compress`],{windowsHide:true}),dead=JSON.parse(stdout),exited=once(child,'exit');child.kill();await exited
const generation=randomUUID(),gate={protocolVersion:3,kind:'dual-lane-upgrade-gate',generation,guardian:dead,coordinator:dead,executors:[{...dead,role:'lane'}],endpoint:String.raw`\\.\pipe\dsh-dual-`+randomUUID()}
const model=new DualLaneState();model.acquire({executionId:'A',actor:dead});model.bindExecutor('A',dead);const laneRecord={...model.data,generation}
const queued=new DualLaneState();queued.request({executionId:'Q',actor:dead});const queueRecord={...queued.data,generation}
const stopped=new DualLaneState();stopped.acquire({executionId:'S',actor:dead});stopped.pause('S',{kind:'pause',reason:'host-cancel',source:'host-cancel'});stopped.retire('S',()=> 'dead');const stopRecord={...stopped.data,generation}
await mkdir(dirname(metadata),{recursive:true});await writeFile(metadata,JSON.stringify(gate))
const cases=[['unlisted-executor',{...laneRecord,lanes:[{...laneRecord.lanes[0],executor:{pid:dead.pid+1,birth:dead.birth}}]}],['invalid-queue-actor',{...queueRecord,tickets:[{...queueRecord.tickets[0],actor:{pid:0,birth:'unknown'}}]}],['invalid-stop-actor',{...stopRecord,halted:{S:{...stopRecord.halted.S,actor:null}}}]]
try{
 let failures=0
 for(const [name,record] of cases){const text=JSON.stringify(record),before=await readFile(metadata,'utf8');await writeFile(statePath,text);let rejected=false;try{await readDualPersistence(metadata)}catch(error){rejected=error.message==='dual-state-unknown'}if(!rejected){failures++;console.log('RED relation admitted: '+name)}assert.equal(await readFile(metadata,'utf8'),before);assert.equal(await readFile(statePath,'utf8'),text)}
 assert.equal(failures,0,'persisted identities and lane-to-gate membership must be proven')
 for(const record of [laneRecord,queueRecord,stopRecord]){await writeFile(statePath,JSON.stringify(record));assert((await readDualPersistence(metadata)).record)}
 console.log('PASS persisted delta: unlisted/mismatched executor and invalid queue/stop actors refuse without writes; valid lane/queue/stop identities retained; pure model remains separate')
}finally{if(child.exitCode===null&&child.signalCode===null)child.kill();await rm(dirname(metadata),{recursive:true,force:true})}
