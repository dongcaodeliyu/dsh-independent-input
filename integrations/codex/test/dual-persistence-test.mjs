import assert from 'node:assert/strict'
import {spawn,execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {once} from 'node:events'
import {randomUUID} from 'node:crypto'
import {mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises'
import {dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {DualLaneState} from '../lib/dual-lane-state.js'
import {dualControlPaths,readDualPersistence} from '../lib/dual-persistence.js'
import {dualConnection} from '../lib/dual-connection.js'
import {DualControlLease} from '../lib/dual-control-lease.js'
import {startDualCoordinator} from '../lib/dual-coordinator.js'
const namespace='schema-'+randomUUID(),{metadata}=await dualControlPaths(namespace),statePath=metadata.replace(/\.json$/,'.v3.json'),directory=dirname(metadata),exec=promisify(execFile)
const actor=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'})
const {stdout}=await exec('powershell.exe',['-NoProfile','-Command',`$p=[Diagnostics.Process]::GetProcessById(${actor.pid});@{pid=$p.Id;birth=$p.StartTime.ToUniversalTime().Ticks.ToString()}|ConvertTo-Json -Compress`],{windowsHide:true}),identity=JSON.parse(stdout),exit=once(actor,'exit');actor.kill();await exit
const generation=randomUUID(),gate={protocolVersion:3,kind:'dual-lane-upgrade-gate',generation,guardian:identity,coordinator:identity,executors:[{...identity,role:'lane'}],endpoint:String.raw`\\.\pipe\dsh-dual-`+randomUUID()},model=new DualLaneState()
model.acquire({executionId:'A',actor:identity});model.bindExecutor('A',identity);model.retire('A',()=> 'dead');const valid={...model.data,generation},gateText=JSON.stringify(gate)
await mkdir(directory,{recursive:true});await writeFile(metadata,gateText)
const connection=dualConnection({testNamespace:namespace,headlessTest:true}),lease=new DualControlLease({connection,testNamespace:namespace})
try{
 for(const corruption of [{tickets:[7]},{halted:{A:false}},{halted:{A:{...valid.halted.A,stopInfo:{kind:'pause',reason:'control-escape'}}}}]){
  const text=JSON.stringify({...valid,...corruption});await writeFile(statePath,text);const files=await readdir(directory)
  assert.equal((await lease.status('A')).canAcquire,false)
  await assert.rejects(connection(),/dual-state-unknown/);await assert.rejects(startDualCoordinator({testNamespace:namespace,onMembers:async()=>{}}),/dual-state-unknown/)
  assert.equal(connection.local()?.gate?.generation,generation)
  assert.equal(await readFile(metadata,'utf8'),gateText);assert.equal(await readFile(statePath,'utf8'),text);assert.deepEqual(await readdir(directory),files)
 }
 // Lock-held stamp closes the preflight/read-to-publish race without a new lock.
 await writeFile(statePath,JSON.stringify(valid));const {stamp}=await readDualPersistence(metadata),changed=JSON.stringify({...valid,tickets:[7]});await writeFile(statePath,changed)
 const guard=spawn('powershell.exe',['-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('../lib/dual-guardian.ps1',import.meta.url)),'-CoordinatorPid',String(process.pid),'-TestNamespace',namespace,'-StateStamp',stamp],{windowsHide:true,stdio:['pipe','pipe','pipe']})
 const closed=once(guard,'close');let reply='';guard.stdin.on('error',()=>{});guard.stdout.on('data',s=>reply+=s);guard.stderr.on('data',s=>process.stderr.write(s));await closed
 assert.equal(JSON.parse(reply).reason,'dual-state-changed-before-lock');assert.equal(await readFile(metadata,'utf8'),gateText);assert.equal(await readFile(statePath,'utf8'),changed)
 await writeFile(statePath,JSON.stringify(valid));const restored=await startDualCoordinator({testNamespace:namespace,onMembers:async()=>{}});try{assert(restored.state.data.halted.A.beginRequired)}finally{await restored.close()}
 const freshNamespace='schema-fresh-'+randomUUID(),fresh=await startDualCoordinator({testNamespace:freshNamespace,onMembers:async()=>{}});try{assert.equal(fresh.state.data.lanes.length,0)}finally{await fresh.close();await rm(dirname(fresh.statePath),{recursive:true,force:true})}
 console.log('PASS real isolated persistence entry: three corruptions rejected by readonly/connection/coordinator preflight with gate/state bytes unchanged; actual guardian mutex stamp rejects post-validation change; legitimate recovered and absent fresh state start without input/UI')
}finally{if(actor.exitCode===null&&actor.signalCode===null)actor.kill();await rm(directory,{recursive:true,force:true})}
